import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { cellToLatLngSafe } from "../shared/h3.js";
import {
  chatWithAssistant,
  type AssistantCard,
  type AssistantUserContext,
} from "../lib/aiClient.js";
import { getPlaceDetails, type Place } from "../lib/foursquareClient.js";
import {
  findAcceptedConnections,
  findNearbyPeople,
  findNearbyPersonContext,
  type ConnectionContext,
} from "../lib/connectionContext.js";
import { config } from "../config.js";

const HISTORY_WINDOW_SIZE = 10;
const MAX_PLACE_REFS_PER_TURN = 12;

const ChatSchema = z
  .object({
    message: z.string().min(1).max(500),
    placeId: z.string().min(1).max(120).optional(),
    connectionUserId: z.string().uuid().optional(),
    personUserId: z.string().uuid().optional(),
    suggestion: z
      .object({
        connectionId: z.string().uuid(),
        title: z.string().min(1).max(120).optional(),
        place: z.string().min(1).max(160).optional(),
        time: z.string().min(1).max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function seedRememberedConnections(
  historyRows: Array<{ role: string; metadata: Record<string, unknown> | null }>
): ConnectionContext[] {
  for (const row of historyRows) {
    if (row.role !== "assistant") continue;
    const remembered = (row.metadata as { rememberedConnections?: unknown } | null)
      ?.rememberedConnections;
    if (Array.isArray(remembered)) return remembered as ConnectionContext[];
  }
  return [];
}

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
  pool: pg.Pool;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  chatWithAssistant: typeof chatWithAssistant;
  foursquareApiKey: string;
};

export function createAssistantRoutes(overrides: Partial<AssistantRouteDeps> = {}) {
  const deps: AssistantRouteDeps = {
    pool,
    verifyAccessToken,
    AuthError,
    chatWithAssistant,
    foursquareApiKey: config.foursquareApiKey,
    ...overrides,
  };

  return async function assistantRoutes(app: FastifyInstance) {
    const {
      pool: db,
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
        const suggestion = parsed.data.suggestion;
        const chosenConnectionUserId =
          parsed.data.connectionUserId ?? suggestion?.connectionId;
        const chosenPersonUserId = parsed.data.personUserId;

        const { rows: meRows } = await db.query(
          "SELECT first_name, bio, interests, language_preference, h3_cell FROM users WHERE id = $1",
          [userId]
        );
        const me = meRows[0] as {
          first_name: string | null;
          bio: string | null;
          interests: string[] | null;
          language_preference: string | null;
          h3_cell: string | null;
        } | undefined;

        if (!me) {
          log.error(
            { event: "assistant_user_fetch_failure", userId },
            "Failed to fetch user for assistant chat"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const h3Cell = me.h3_cell;
        const coords = h3Cell ? cellToLatLngSafe(h3Cell) : null;

        const userContext: AssistantUserContext = {
          firstName: me.first_name ?? "there",
          bio: me.bio,
          interests: me.interests ?? [],
          language: me.language_preference ?? "en",
          coords,
        };

        const { rows: historyRows } = await db.query(
          "SELECT role, content, metadata FROM assistant_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
          [userId, HISTORY_WINDOW_SIZE]
        );

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

        let seededRemembered = seedRememberedConnections(
          (historyRows ?? []) as Array<{
            role: string;
            metadata: Record<string, unknown> | null;
          }>
        );

        if (chosenConnectionUserId) {
          const [chosenConn] = await findAcceptedConnections(db, userId, {
            userId: chosenConnectionUserId,
          });
          if (chosenConn) {
            seededRemembered = [
              ...seededRemembered.filter((c) => c.userId !== chosenConn.userId),
              chosenConn,
            ];
          }
        }

        if (chosenPersonUserId) {
          const chosenPerson = await findNearbyPersonContext(db, userId, chosenPersonUserId);
          if (chosenPerson) {
            seededRemembered = [
              ...seededRemembered.filter((c) => c.userId !== chosenPerson.userId),
              chosenPerson,
            ];
          }
        }

        const { reply: aiReply, cards, rememberedConnections } = await chatWithAssistant(
          history,
          message,
          userContext,
          foursquareApiKey,
          tappedPlace,
          {
            rememberedConnections: seededRemembered,
            resolveConnections: (ref) => findAcceptedConnections(db, userId, ref),
            findNearbyPeople: () => findNearbyPeople(db, userId),
            suggestionSeed: suggestion
              ? { title: suggestion.title, place: suggestion.place, time: suggestion.time }
              : undefined,
          }
        );

        let messageId: string | null = null;
        try {
          const assistantMeta = JSON.stringify({ cards, rememberedConnections });
          const { rows: inserted } = await db.query(
            `INSERT INTO assistant_messages (user_id, role, content, metadata)
             VALUES ($1, 'user', $2, '{}'), ($1, 'assistant', $3, $4)
             RETURNING id, role, created_at
             ORDER BY created_at ASC`,
            [userId, message, aiReply, assistantMeta]
          );

          if (inserted && inserted.length > 0) {
            const assistantRow = inserted.find((r: { role: string }) => r.role === "assistant");
            messageId = assistantRow?.id ?? null;
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
          const { rows: cursorRows } = await db.query(
            "SELECT created_at FROM assistant_messages WHERE id = $1 AND user_id = $2",
            [cursor, userId]
          );
          const cursorRow = cursorRows[0] as { created_at: string } | undefined;

          if (!cursorRow) {
            log.error(
              { event: "assistant_history_cursor_failure", userId, cursor },
              "Failed to resolve cursor"
            );
            return reply
              .status(500)
              .send({ success: false, error: req.t("common.errors.unable_to_process") });
          }
          cursorCreatedAt = cursorRow.created_at;
        }

        let queryText = "SELECT id, role, content, metadata, created_at FROM assistant_messages WHERE user_id = $1";
        const queryParams: unknown[] = [userId];
        let paramIdx = 2;

        if (cursorCreatedAt) {
          queryText += ` AND created_at < $${paramIdx}`;
          queryParams.push(cursorCreatedAt);
          paramIdx++;
        }

        queryText += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
        queryParams.push(limit + 1);

        const { rows: rowsResult } = await db.query(queryText, queryParams);

        const all = (rowsResult ?? []) as Array<{
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
