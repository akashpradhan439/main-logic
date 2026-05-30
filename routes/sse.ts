import type { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { registerConnection, removeConnection, type BufferItem } from "../lib/sseManager.js";
import { getMessagesSinceCursor } from "../lib/messaging.js";

export type SseRouteDeps = {
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  getMessagesSinceCursor: typeof getMessagesSinceCursor;
  supabase: typeof supabase;
};

export function createSseRoutes(overrides: Partial<SseRouteDeps> = {}) {
  const deps: SseRouteDeps = { verifyAccessToken, AuthError, getMessagesSinceCursor, supabase, ...overrides };

  return async function sseRoutes(app: FastifyInstance) {
    const { verifyAccessToken, AuthError, getMessagesSinceCursor, supabase } = deps;

    app.get("/messaging/stream", async (req, reply) => {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.status(err.status).send({ success: false, error: "Unauthorized" });
        }
        throw err;
      }

      const cursor = (req.query as Record<string, string | undefined>)["cursor"];

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      function send(event: string, data: unknown, id?: string): boolean {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          const idLine = id ? `id: ${id}\n` : "";
          reply.raw.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        }
        return false;
      }

      const buffer: BufferItem[] = [];
      const state = { send, buffer, isLive: false };

      removeConnection(userId);
      registerConnection(userId, state);

      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.write(": heartbeat\n\n");
        } else {
          clearInterval(heartbeat);
        }
      }, 30_000);

      reply.raw.on("close", () => {
        clearInterval(heartbeat);
        removeConnection(userId);
      });

      send("connected", { userId });

      // Track ids delivered during catch-up so the buffer flush below can't
      // re-send a message that was both returned by the catch-up query and
      // buffered by a concurrent live send (would be a duplicate).
      const deliveredIds = new Set<string>();

      if (cursor) {
        try {
          const generator = getMessagesSinceCursor(supabase, userId, cursor);
          for await (const batch of generator) {
            if (reply.raw.writableEnded || reply.raw.destroyed) break;
            for (const msg of batch) {
              const replayEvent: Record<string, unknown> = {
                type: "new_message",
                conversationId: msg.conversation_id,
                messageId: msg.id,
                senderId: msg.sender_id,
                // Canonical initiator — mirrors the live send path so a bootstrap
                // replayed on reconnect doesn't deadlock both clients into responders.
                initiatorUserId: msg.initiator_user_id ?? null,
                envelope: Buffer.from(msg.envelope).toString("base64"),
                attachmentUrl: msg.attachment_url,
                attachmentType: msg.attachment_type,
                createdAt: msg.created_at,
              };
              if (msg.bootstrap_json) {
                replayEvent.bootstrap = msg.bootstrap_json;
              }
              send("message", replayEvent, msg.id);
              deliveredIds.add(msg.id);
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } catch (err) {
          req.log.error({ err, userId }, "SSE catch-up failed");
        }
      }

      // Flush any messages buffered during catch-up, skipping ones already sent.
      for (const { eventId, data } of state.buffer) {
        if (deliveredIds.has(eventId)) continue;
        send("message", data, eventId);
      }
      state.buffer.length = 0;

      state.isLive = true;
    });
  };
}

export default createSseRoutes();
