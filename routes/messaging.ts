import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WebSocket } from "@fastify/websocket";
import { supabase } from "../lib/supabase.js";
import { publishNewMessage } from "../lib/rabbitmq.js";
import {
  messagesSentTotal,
  messagesPublishFailuresTotal,
  wsConnectionsTotal,
  wsDisconnectsTotal,
} from "../lib/metrics.js";
import { verifyAccessToken, signWsToken, verifyWsToken, AuthError } from "../shared/auth.js";
import {
  findOrCreateConversation,
  insertMessage,
  getConversationMessages,
  verifyConversationParticipant,
  getOtherParticipant,
  type ConversationRow,
  type MessageRow,
} from "../lib/messaging.js";
import { findConnectionBetweenUsers, isPairBlocked } from "../lib/connections.js";
import { redisSet, redisDel, redisGet } from "../lib/redis.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateConversationSchema = z.object({
  otherUserId: z.string().uuid(),
});

const MessageHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const WsIncomingMessageSchema = z.object({
  type: z.literal("send_message"),
  conversationId: z.string().uuid(),
  content: z.string().nullable().default(null),
  attachmentUrl: z.string().url().nullable().default(null),
  attachmentType: z.string().nullable().default(null),
}).refine(
  (data) => data.content !== null || data.attachmentUrl !== null,
  { message: "Message must have content or an attachment" }
);

// ─── WebSocket Connection Registry ────────────────────────────────────────────

const wsConnections = new Map<string, WebSocket>();

const REDIS_PRESENCE_PREFIX = "ws:online:";
const REDIS_PRESENCE_TTL = 120; // seconds
const HEARTBEAT_INTERVAL_MS = 30_000;

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type MessagingRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  signWsToken: typeof signWsToken;
  verifyWsToken: typeof verifyWsToken;
  AuthError: typeof AuthError;
  findConnectionBetweenUsers: typeof findConnectionBetweenUsers;
  isPairBlocked: typeof isPairBlocked;
  findOrCreateConversation: typeof findOrCreateConversation;
  insertMessage: typeof insertMessage;
  getConversationMessages: typeof getConversationMessages;
  verifyConversationParticipant: typeof verifyConversationParticipant;
  getOtherParticipant: typeof getOtherParticipant;
  publishNewMessage: typeof publishNewMessage;
  redisSet: typeof redisSet;
  redisDel: typeof redisDel;
  redisGet: typeof redisGet;
};

export function createMessagingRoutes(
  overrides: Partial<MessagingRouteDeps> = {}
) {
  const deps: MessagingRouteDeps = {
    supabase,
    verifyAccessToken,
    signWsToken,
    verifyWsToken,
    AuthError,
    findConnectionBetweenUsers,
    isPairBlocked,
    findOrCreateConversation,
    insertMessage,
    getConversationMessages,
    verifyConversationParticipant,
    getOtherParticipant,
    publishNewMessage,
    redisSet,
    redisDel,
    redisGet,
    ...overrides,
  };

  return async function messagingRoutes(app: FastifyInstance) {
    const {
      supabase,
      verifyAccessToken,
      signWsToken,
      verifyWsToken,
      AuthError,
      findConnectionBetweenUsers,
      isPairBlocked,
      findOrCreateConversation,
      insertMessage,
      getConversationMessages,
      verifyConversationParticipant,
      getOtherParticipant,
      publishNewMessage,
      redisSet,
      redisDel,
    } = deps;

    // ─── REST: WS Token ──────────────────────────────────────────────────

    app.post("/messaging/ws-token", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: "Authentication required" });
          }
          throw err;
        }

        const token = signWsToken(userId);
        log.info({ event: "ws_token_generated", userId, requestId }, "WS token generated");

        return reply.status(200).send({ success: true, token });
      } catch (err) {
        log.error({ event: "ws_token_error", requestId, err }, "Error generating WS token");
        return reply.status(500).send({ success: false, error: "Unable to generate token" });
      }
    });

    // ─── REST: Create / Get Conversation ──────────────────────────────────

    app.post("/messaging/conversations", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const requestStart = process.hrtime.bigint();

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            log.info({ event: "auth_failed", requestId }, "Authentication failed");
            return reply.status(err.status).send({ success: false, error: "Authentication required" });
          }
          throw err;
        }

        const parsed = CreateConversationSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { otherUserId } = parsed.data;

        if (otherUserId === userId) {
          return reply.status(400).send({ success: false, error: "Cannot create conversation with yourself" });
        }

        log.info(
          { event: "conversation_create_start", userId, otherUserId, requestId },
          "Creating conversation"
        );

        // Verify users are connected
        const { row: connection, error: connError } = await findConnectionBetweenUsers(
          supabase, userId, otherUserId
        );

        if (connError) {
          log.error(
            { event: "conversation_create_failure", userId, otherUserId, requestId, err: connError.message },
            "Failed to check connection"
          );
          return reply.status(500).send({ success: false, error: "Unable to create conversation right now" });
        }

        if (!connection || connection.status !== "accepted" || isPairBlocked(connection)) {
          return reply.status(403).send({ success: false, error: "You must be connected with this user to message them" });
        }

        const { conversation, error, created } = await findOrCreateConversation(
          supabase, userId, otherUserId, log
        );

        if (error || !conversation) {
          log.error(
            { event: "conversation_create_failure", userId, otherUserId, requestId },
            "Failed to create conversation"
          );
          return reply.status(500).send({ success: false, error: "Unable to create conversation right now" });
        }

        const requestDurationMs = Number(process.hrtime.bigint() - requestStart) / 1_000_000;
        log.info(
          { event: "conversation_create_success", conversationId: conversation.id, userId, otherUserId, created, requestId, durationMs: requestDurationMs },
          "Conversation ready"
        );

        // Unified response format
        return reply.status(created ? 201 : 200).send({
          success: true,
          conversation: {
            id: conversation.id,
            otherUserId,
            createdAt: conversation.created_at,
            updatedAt: conversation.updated_at,
          }
        });
      } catch (err) {
        const requestDurationMs = Number(process.hrtime.bigint() - requestStart) / 1_000_000;
        log.error(
          { event: "conversation_create_error", requestId, durationMs: requestDurationMs, err },
          "Unexpected error creating conversation"
        );
        return reply.status(500).send({ success: false, error: "Unable to create conversation right now" });
      }
    });

    // ─── REST: List Conversations ─────────────────────────────────────────

    app.get("/messaging/conversations", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: "Authentication required" });
          }
          throw err;
        }

        log.info({ event: "conversations_list_start", userId, requestId }, "Listing conversations");

        const { data, error } = await supabase
          .from("conversations")
          .select("id, participant_one, participant_two, created_at, updated_at")
          .or(`participant_one.eq.${userId},participant_two.eq.${userId}`)
          .order("updated_at", { ascending: false });

        if (error) {
          log.error(
            { event: "conversations_list_failure", userId, requestId, err: error.message },
            "Failed to list conversations"
          );
          return reply.status(500).send({ success: false, error: "Unable to list conversations right now" });
        }

        const conversations = (data ?? []).map((conv: any) => {
          const otherUserId =
            conv.participant_one === userId ? conv.participant_two : conv.participant_one;
          return {
            id: conv.id,
            otherUserId,
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
          };
        });

        log.info(
          { event: "conversations_list_success", userId, requestId, count: conversations.length },
          "Conversations listed"
        );

        return reply.status(200).send({ success: true, conversations });
      } catch (err) {
        log.error(
          { event: "conversations_list_error", requestId, err },
          "Unexpected error listing conversations"
        );
        return reply.status(500).send({ success: false, error: "Unable to list conversations right now" });
      }
    });

    // ─── REST: Get Messages ───────────────────────────────────────────────

    app.get("/messaging/conversations/:id/messages", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const { id: conversationId } = req.params as { id: string };

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: "Authentication required" });
          }
          throw err;
        }

        // Verify user is a participant and not blocked
        const { isParticipant, isBlocked, error: verifyError } = await verifyConversationParticipant(
          supabase, conversationId, userId
        );

        if (verifyError) {
          log.error(
            { event: "messages_fetch_failure", conversationId, userId, requestId, err: verifyError.message },
            "Failed to verify participant"
          );
          return reply.status(500).send({ success: false, error: "Unable to fetch messages right now" });
        }

        if (!isParticipant) {
          return reply.status(403).send({ success: false, error: "You are not a participant in this conversation" });
        }

        if (isBlocked) {
          return reply.status(403).send({ success: false, error: "You cannot view messages for this conversation" });
        }

        const parsed = MessageHistoryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { cursor, limit } = parsed.data;

        const { messages, error } = await getConversationMessages(
          supabase, conversationId, cursor ?? null, limit
        );

        if (error) {
          log.error(
            { event: "messages_fetch_failure", conversationId, userId, requestId, err: error.message },
            "Failed to fetch messages"
          );
          return reply.status(500).send({ success: false, error: "Unable to fetch messages right now" });
        }

        log.info(
          { event: "messages_fetch_success", conversationId, userId, requestId, count: messages.length },
          "Messages fetched"
        );

        const lastMessage = messages.length === limit ? messages[messages.length - 1] : undefined;
        const nextCursor = lastMessage ? lastMessage.created_at : null;

        return reply.status(200).send({ success: true, messages, nextCursor });
      } catch (err) {
        log.error(
          { event: "messages_fetch_error", requestId, err },
          "Unexpected error fetching messages"
        );
        return reply.status(500).send({ success: false, error: "Unable to fetch messages right now" });
      }
    });

    // ─── WebSocket: Real-time Messaging ───────────────────────────────────

    await app.register(import("@fastify/websocket"));

    app.get("/messaging/ws", { websocket: true }, (socket, req) => {
      const requestId = req.id;
      const log = req.log;

      // Authenticate via short-lived WS token
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      let userId: string;

      if (!token) {
        log.info({ event: "ws_auth_no_token", requestId }, "WebSocket connection attempt with no token");
        socket.send(JSON.stringify({ type: "error", message: "Authentication token required" }));
        socket.close(4001, "Token required");
        return;
      }

      try {
        const payload = verifyWsToken(token);
        userId = payload.sub;
      } catch (err) {
        log.info({ event: "ws_auth_failed", requestId, err }, "WebSocket authentication failed");
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Authentication failed");
        return;
      }

      // Close any existing connection for this user (single-session enforcement)
      const existingSocket = wsConnections.get(userId);
      if (existingSocket) {
        log.info({ event: "ws_session_replaced", userId, requestId }, "Replacing existing WebSocket session");
        existingSocket.close(4002, "Session replaced");
      }

      wsConnections.set(userId, socket);
      wsConnectionsTotal.inc();

      // Set Redis presence
      redisSet(`${REDIS_PRESENCE_PREFIX}${userId}`, "1", REDIS_PRESENCE_TTL).catch((err) => {
        log.error({ event: "ws_redis_presence_error", userId, err }, "Failed to set Redis presence");
      });

      log.info(
        { event: "ws_connect", userId, requestId, activeConnections: wsConnections.size },
        "WebSocket connected"
      );

      // ─── Heartbeat ────────────────────────────────────────────────────────

      let isAlive = true;
      const heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          log.info({ event: "ws_heartbeat_timeout", userId }, "WebSocket heartbeat timeout, closing");
          clearInterval(heartbeatInterval);
          socket.close(4003, "Heartbeat timeout");
          return;
        }
        isAlive = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);

      socket.on("pong", () => {
        isAlive = true;
        // Refresh Redis presence TTL
        redisSet(`${REDIS_PRESENCE_PREFIX}${userId}`, "1", REDIS_PRESENCE_TTL).catch(() => {});
      });

      // ─── Message Handling ─────────────────────────────────────────────────

      socket.on("message", async (rawData) => {
        const messageRequestId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        try {
          const parsed = JSON.parse(rawData.toString());
          const validated = WsIncomingMessageSchema.safeParse(parsed);

          if (!validated.success) {
            socket.send(JSON.stringify({
              type: "error",
              message: "Invalid message format",
              errors: validated.error.flatten().fieldErrors,
            }));
            return;
          }

          const { conversationId, content, attachmentUrl, attachmentType } = validated.data;

          log.info(
            {
              event: "ws_message_received",
              userId,
              conversationId,
              hasContent: content !== null,
              hasAttachment: attachmentUrl !== null,
              requestId: messageRequestId,
            },
            "WebSocket message received"
          );

          // Verify sender is participant and not blocked
          const { isParticipant, isBlocked, conversation, error: verifyError } = await verifyConversationParticipant(
            supabase, conversationId, userId
          );

          if (verifyError || !isParticipant || !conversation) {
            socket.send(JSON.stringify({
              type: "error",
              message: "You are not a participant in this conversation",
            }));
            return;
          }

          if (isBlocked) {
            socket.send(JSON.stringify({
              type: "error",
              message: "You cannot send messages to this user",
            }));
            return;
          }

          // Insert into DB
          const { message, error: insertError } = await insertMessage(
            supabase, conversationId, userId, content, attachmentUrl, attachmentType, log
          );

          if (insertError || !message) {
            socket.send(JSON.stringify({
              type: "error",
              message: "Failed to send message",
            }));
            return;
          }

          messagesSentTotal.inc();

          // ACK to sender
          socket.send(JSON.stringify({
            type: "message_ack",
            messageId: message.id,
            conversationId,
            createdAt: message.created_at,
          }));

          // Determine recipient
          const recipientId = getOtherParticipant(conversation, userId);
          if (!recipientId) {
            log.error(
              { event: "ws_no_recipient", userId, conversationId, requestId: messageRequestId },
              "Could not determine recipient"
            );
            return;
          }

          // Construct outgoing message payload
          const outgoingPayload = {
            type: "new_message",
            messageId: message.id,
            conversationId,
            senderId: userId,
            content: message.content,
            attachmentUrl: message.attachment_url,
            attachmentType: message.attachment_type,
            createdAt: message.created_at,
          };

          // Try to deliver directly to recipient on this instance
          const recipientSocket = wsConnections.get(recipientId);
          if (recipientSocket && recipientSocket.readyState === 1) {
            recipientSocket.send(JSON.stringify(outgoingPayload));
            log.info(
              {
                event: "ws_message_delivered",
                userId,
                recipientId,
                messageId: message.id,
                conversationId,
                delivery: "local",
                requestId: messageRequestId,
              },
              "Message delivered locally"
            );
            return;
          }

          // Recipient not on this instance — publish to RabbitMQ for cross-instance delivery or offline push
          try {
            const published = await publishNewMessage(
              {
                conversationId,
                messageId: message.id,
                senderId: userId,
                recipientId,
                content: message.content,
                attachmentUrl: message.attachment_url,
                attachmentType: message.attachment_type,
                createdAt: message.created_at,
                requestId: messageRequestId,
              },
              log
            );

            if (!published) {
              messagesPublishFailuresTotal.inc();
              log.error(
                {
                  event: "ws_message_publish_failed",
                  userId,
                  recipientId,
                  messageId: message.id,
                  requestId: messageRequestId,
                },
                "Failed to publish message to RabbitMQ"
              );
            } else {
              log.info(
                {
                  event: "ws_message_offline",
                  userId,
                  recipientId,
                  messageId: message.id,
                  conversationId,
                  requestId: messageRequestId,
                },
                "Message published for offline/cross-instance delivery"
              );
            }
          } catch (publishErr) {
            messagesPublishFailuresTotal.inc();
            log.error(
              {
                event: "ws_message_publish_error",
                userId,
                recipientId,
                messageId: message.id,
                requestId: messageRequestId,
                err: publishErr,
              },
              "Error publishing message to RabbitMQ"
            );
          }
        } catch (err) {
          log.error(
            { event: "ws_message_processing_error", userId, requestId: messageRequestId, err },
            "Error processing WebSocket message"
          );
          socket.send(JSON.stringify({ type: "error", message: "Failed to process message" }));
        }
      });

      // ─── Disconnect Handling ──────────────────────────────────────────────

      socket.on("close", () => {
        clearInterval(heartbeatInterval);
        wsConnections.delete(userId);
        wsDisconnectsTotal.inc();

        redisDel(`${REDIS_PRESENCE_PREFIX}${userId}`).catch((err) => {
          log.error({ event: "ws_redis_presence_cleanup_error", userId, err }, "Failed to clear Redis presence");
        });

        log.info(
          { event: "ws_disconnect", userId, requestId, activeConnections: wsConnections.size },
          "WebSocket disconnected"
        );
      });

      socket.on("error", (err) => {
        log.error({ event: "ws_error", userId, requestId, err }, "WebSocket error");
      });
    });

    // ─── Graceful Shutdown ──────────────────────────────────────────────────

    app.addHook("onClose", async () => {
      for (const [userId, socket] of wsConnections) {
        socket.close(1001, "Server shutting down");
        await redisDel(`${REDIS_PRESENCE_PREFIX}${userId}`).catch(() => {});
      }
      wsConnections.clear();
      app.log.info({ event: "ws_shutdown", message: "All WebSocket connections closed" }, "WebSocket shutdown complete");
    });
  };
}

// Default export for use in routes/index.ts
export default createMessagingRoutes();
