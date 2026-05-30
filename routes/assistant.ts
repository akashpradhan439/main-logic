import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { cellToLatLngSafe } from "../shared/h3.js";
import {
  chatWithAssistant,
  type AssistantCard,
  type AssistantUserContext,
} from "../lib/aiClient.js";
import { getPlaceDetails, type Place } from "../lib/foursquareClient.js";
import { config } from "../config.js";

const HISTORY_WINDOW_SIZE = 10;
const MAX_PLACE_REFS_PER_TURN = 12;

const ChatSchema = z
  .object({
    message: z.string().min(1).max(500),
    placeId: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * Extract every (name, placeId) reference visible in an assistant turn's
 * metadata and append a hidden marker to its content so the LLM can recall
 * placeIds on follow-up turns (e.g. when the user asks "tell me more about
 * Cafe Dori"). The marker is invisible to the client — only the LLM sees it.
 */
function augmentAssistantContent(
  content: string,
  metadata: Record<string, unknown> | null | undefined
): string {
  const cards = (metadata as { cards?: AssistantCard[] } | null | undefined)?.cards;
  if (!Array.isArray(cards) || cards.length === 0) return content;

  const refs: string[] = [];
  for (const card of cards) {
    if (card.type === "places" && Array.isArray(card.data)) {
      for (const p of card.data) {
        if (p?.placeId && p?.name) refs.push(`${p.name} (placeId=${p.placeId})`);
        if (refs.length >= MAX_PLACE_REFS_PER_TURN) break;
      }
    } else if (card.type === "place_detail" && card.data?.placeId && card.data?.name) {
      refs.push(`${card.data.name} (placeId=${card.data.placeId})`);
    }
    if (refs.length >= MAX_PLACE_REFS_PER_TURN) break;
  }
  if (refs.length === 0) return content;
  return (
    content +
    `\n\n[Place references from this turn — use these placeIds when calling get_place_details; never reveal the IDs in your reply: ${refs.join("; ")}]`
  );
}

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});

export type AssistantRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  chatWithAssistant: typeof chatWithAssistant;
  foursquareApiKey: string;
};

export function createAssistantRoutes(overrides: Partial<AssistantRouteDeps> = {}) {
  const deps: AssistantRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    chatWithAssistant,
    foursquareApiKey: config.foursquareApiKey,
    ...overrides,
  };

  return async function assistantRoutes(app: FastifyInstance) {
    const {
      supabase,
      verifyAccessToken,
      AuthError,
      chatWithAssistant,
      foursquareApiKey,
    } = deps;

    app.post("/assistant/chat", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply
              .status(err.status)
              .send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = ChatSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ success: false, error: parsed.error.flatten().fieldErrors });
        }
        const message = parsed.data.message.trim();
        const tappedPlaceId = parsed.data.placeId;

        const { data: me, error: meErr } = await supabase
          .from("users")
          .select("first_name, bio, interests, language_preference, h3_cell")
          .eq("id", userId)
          .single();

        if (meErr || !me) {
          log.error(
            { event: "assistant_user_fetch_failure", userId, meErr },
            "Failed to fetch user for assistant chat"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const h3Cell = (me.h3_cell as string | null) ?? null;
        const coords = h3Cell ? cellToLatLngSafe(h3Cell) : null;

        const userContext: AssistantUserContext = {
          firstName: (me.first_name as string | null) ?? "there",
          bio: (me.bio as string | null) ?? null,
          interests: (me.interests as string[] | null) ?? [],
          language: (me.language_preference as string | null) ?? "en",
          coords,
        };

        // Fetch last N messages, DESC, then reverse to ASC for the LLM.
        // metadata is included so we can re-inject placeIds the model saw in
        // earlier turns — without it the model can't call get_place_details on
        // follow-ups like "tell me more about Cafe Dori".
        const { data: historyRows, error: histErr } = await supabase
          .from("assistant_messages")
          .select("role, content, metadata")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(HISTORY_WINDOW_SIZE);

        if (histErr) {
          log.warn(
            { event: "assistant_history_fetch_warn", userId, histErr },
            "Failed to fetch history; continuing with empty context"
          );
        }

        const history = (
          (historyRows ?? []) as Array<{
            role: string;
            content: string;
            metadata: Record<string, unknown> | null;
          }>
        )
          .slice()
          .reverse()
          .filter(
            (h): h is { role: "user" | "assistant"; content: string; metadata: Record<string, unknown> | null } =>
              (h.role === "user" || h.role === "assistant") &&
              typeof h.content === "string"
          )
          .map((h) => ({
            role: h.role,
            content:
              h.role === "assistant"
                ? augmentAssistantContent(h.content, h.metadata)
                : h.content,
          }));

        // If the client passed an explicit placeId (user tapped a card),
        // resolve the detail server-side, weave it into the LLM context, and
        // surface a place_detail card unconditionally.
        let tappedPlace: Place | null = null;
        if (tappedPlaceId) {
          tappedPlace = await getPlaceDetails(foursquareApiKey, tappedPlaceId);
          if (!tappedPlace) {
            log.warn(
              { event: "assistant_tapped_place_miss", userId, tappedPlaceId },
              "placeId did not resolve via Foursquare; continuing without tap context"
            );
          }
        }

        const { reply: aiReply, cards } = await chatWithAssistant(
          history,
          message,
          userContext,
          foursquareApiKey,
          tappedPlace
        );

        // Persist both turns
        let messageId: string | null = null;
        try {
          const { data: inserted, error: insErr } = await supabase
            .from("assistant_messages")
            .insert([
              { user_id: userId, role: "user", content: message, metadata: {} },
              {
                user_id: userId,
                role: "assistant",
                content: aiReply,
                metadata: { cards } as { cards: AssistantCard[] },
              },
            ])
            .select("id, role, created_at")
            .order("created_at", { ascending: true });

          if (insErr) {
            log.error(
              { event: "assistant_insert_failure", userId, insErr },
              "Failed to persist assistant chat turn"
            );
          } else if (inserted && inserted.length > 0) {
            const assistantRow = inserted.find((r) => r.role === "assistant");
            messageId = (assistantRow?.id as string | undefined) ?? null;
          }
        } catch (err) {
          log.error(
            { event: "assistant_insert_exception", userId, err },
            "Exception while persisting assistant chat turn"
          );
        }

        log.info(
          {
            event: "assistant_chat_completed",
            userId,
            cardCount: cards.length,
            cardTypes: cards.map((c) => c.type),
            messageLength: message.length,
            replyLength: aiReply.length,
          },
          "Assistant chat completed"
        );

        return reply.status(200).send({
          success: true,
          reply: aiReply,
          cards,
          messageId,
        });
      } catch (err) {
        log.error(
          { event: "assistant_chat_error", err },
          "Unexpected error in POST /assistant/chat"
        );
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    app.get("/assistant/history", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply
              .status(err.status)
              .send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = HistoryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ success: false, error: parsed.error.flatten().fieldErrors });
        }
        const { limit, cursor } = parsed.data;

        let cursorCreatedAt: string | null = null;
        if (cursor) {
          const { data: cursorRow, error: cursorErr } = await supabase
            .from("assistant_messages")
            .select("created_at")
            .eq("id", cursor)
            .eq("user_id", userId)
            .maybeSingle();

          if (cursorErr) {
            log.error(
              { event: "assistant_history_cursor_failure", userId, cursorErr },
              "Failed to resolve cursor"
            );
            return reply
              .status(500)
              .send({ success: false, error: req.t("common.errors.unable_to_process") });
          }
          cursorCreatedAt = (cursorRow?.created_at as string | undefined) ?? null;
        }

        let query = supabase
          .from("assistant_messages")
          .select("id, role, content, metadata, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit + 1);

        if (cursorCreatedAt) {
          query = query.lt("created_at", cursorCreatedAt);
        }

        const { data: rows, error: rowsErr } = await query;
        if (rowsErr) {
          log.error(
            { event: "assistant_history_fetch_failure", userId, rowsErr },
            "Failed to fetch assistant history"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const all = (rows ?? []) as Array<{
          id: string;
          role: string;
          content: string;
          metadata: Record<string, unknown> | null;
          created_at: string;
        }>;
        const hasMore = all.length > limit;
        const sliced = hasMore ? all.slice(0, limit) : all;

        const messages = sliced.map((r) => ({
          id: r.id,
          role: r.role,
          content: r.content,
          metadata: r.metadata ?? {},
          createdAt: r.created_at,
        }));

        return reply.status(200).send({
          success: true,
          messages,
          hasMore,
        });
      } catch (err) {
        log.error(
          { event: "assistant_history_error", err },
          "Unexpected error in GET /assistant/history"
        );
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

export default createAssistantRoutes();
