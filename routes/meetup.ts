import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { redisGet, redisSet } from "../lib/redis.js";
import { cellToLatLngSafe } from "../shared/h3.js";
import { config } from "../config.js";

const MEETUP_CACHE_TTL_SECONDS = 1800; // 30 minutes
const N8N_TIMEOUT_MS = 12_000;

const SpotsQuerySchema = z.object({
  type: z
    .enum(["coffee", "food", "outdoor", "bar", "shopping", "fitness", "any"])
    .optional()
    .default("any"),
});

type MeetupContext = {
  userId: string;
  lat: number;
  lng: number;
  h3Cell: string;
  bio: string | null;
  interests: string[];
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  dayOfWeek: string;
};

type Spot = {
  name: string;
  address: string;
  distanceMeters: number;
  mapsUrl: string;
  reason: string;
};

function bucketTimeOfDay(d: Date): MeetupContext["timeOfDay"] {
  const h = d.getHours();
  if (h >= 6 && h <= 11) return "morning";
  if (h >= 12 && h <= 17) return "afternoon";
  if (h >= 18 && h <= 21) return "evening";
  return "night";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type MeetupRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  redisGet: typeof redisGet;
  redisSet: typeof redisSet;
  fetchImpl: typeof fetch;
};

export function createMeetupRoutes(overrides: Partial<MeetupRouteDeps> = {}) {
  const deps: MeetupRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    redisGet,
    redisSet,
    fetchImpl: fetch,
    ...overrides,
  };

  return async function meetupRoutes(app: FastifyInstance) {
    const { supabase, verifyAccessToken, AuthError, redisGet, redisSet, fetchImpl } = deps;

    // ─── Internal: Context endpoint called by n8n ───────────────────────────

    app.get("/ai/meetup/spots/context", async (req, reply) => {
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

        const { data: user, error } = await supabase
          .from("users")
          .select("h3_cell, bio, interests")
          .eq("id", userId)
          .single();

        if (error || !user) {
          log.error({ event: "meetup_context_user_fetch_failure", userId, error }, "Failed to fetch user");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const h3Cell = (user.h3_cell as string | null) ?? null;
        if (!h3Cell) {
          return reply
            .status(400)
            .send({ success: false, error: "location_required" });
        }

        const coords = cellToLatLngSafe(h3Cell);
        if (!coords) {
          return reply
            .status(400)
            .send({ success: false, error: "location_invalid" });
        }

        const now = new Date();
        const context: MeetupContext = {
          userId,
          lat: coords.lat,
          lng: coords.lng,
          h3Cell,
          bio: (user.bio as string | null) ?? null,
          interests: (user.interests as string[] | null) ?? [],
          timeOfDay: bucketTimeOfDay(now),
          dayOfWeek: DAYS[now.getDay()] ?? "Unknown",
        };

        return reply.status(200).send({ success: true, context });
      } catch (err) {
        log.error({ event: "meetup_context_error", err }, "Unexpected error in /ai/meetup/spots/context");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── Client-facing: Trigger n8n workflow ────────────────────────────────

    app.get("/ai/meetup/spots", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        let bearerToken: string;
        try {
          const authHeader = req.headers.authorization;
          const user = verifyAccessToken(authHeader);
          userId = user.sub;
          bearerToken = (authHeader || "").replace("Bearer ", "").trim();
        } catch (err) {
          if (err instanceof AuthError) {
            return reply
              .status(err.status)
              .send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = SpotsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ success: false, error: parsed.error.flatten().fieldErrors });
        }
        const { type } = parsed.data;

        // Pre-check: user must have location set; if not, fail fast (don't bother n8n)
        const { data: user, error: userErr } = await supabase
          .from("users")
          .select("h3_cell")
          .eq("id", userId)
          .single();
        if (userErr || !user) {
          log.error({ event: "meetup_spots_user_fetch_failure", userId, userErr }, "Failed to fetch user");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }
        if (!user.h3_cell) {
          return reply
            .status(400)
            .send({ success: false, error: "location_required" });
        }

        // Cache check
        const cacheKey = `meetup:spots:${userId}:${type}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
          try {
            const parsedCache = JSON.parse(cached);
            return reply
              .status(200)
              .send({ success: true, cached: true, type, spots: parsedCache });
          } catch {
            // fall through on parse error
          }
        }

        if (!config.n8nMeetupWebhookUrl) {
          log.error({ event: "meetup_spots_n8n_not_configured", userId }, "n8n webhook URL not set");
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        // Call n8n webhook
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);

        let n8nResponse: Response;
        try {
          n8nResponse = await fetchImpl(config.n8nMeetupWebhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-N8N-Secret": config.n8nWebhookSecret,
            },
            body: JSON.stringify({ jwt: bearerToken, type }),
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(timeout);
          log.error({ event: "meetup_spots_n8n_call_failure", userId, err }, "n8n webhook call failed");
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }
        clearTimeout(timeout);

        if (!n8nResponse.ok) {
          log.error(
            { event: "meetup_spots_n8n_bad_status", userId, status: n8nResponse.status },
            "n8n webhook returned non-2xx"
          );
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        let n8nBody: unknown;
        try {
          n8nBody = await n8nResponse.json();
        } catch (err) {
          log.error({ event: "meetup_spots_n8n_bad_json", userId, err }, "n8n response not JSON");
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        const spots = extractSpots(n8nBody);
        if (!spots) {
          log.error({ event: "meetup_spots_n8n_bad_shape", userId, n8nBody }, "n8n response shape invalid");
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        await redisSet(cacheKey, JSON.stringify(spots), MEETUP_CACHE_TTL_SECONDS);

        log.info(
          { event: "meetup_spots_generated", userId, type, count: spots.length },
          "Meet-up spots generated"
        );

        return reply.status(200).send({ success: true, cached: false, type, spots });
      } catch (err) {
        log.error({ event: "meetup_spots_error", err }, "Unexpected error in /ai/meetup/spots");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

function extractSpots(body: unknown): Spot[] | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const raw = Array.isArray(obj.spots)
    ? obj.spots
    : Array.isArray((obj as { data?: unknown }).data)
      ? ((obj as { data: unknown }).data as unknown[])
      : null;
  if (!raw) return null;

  const spots: Spot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.name === "string" &&
      typeof r.address === "string" &&
      typeof r.reason === "string"
    ) {
      spots.push({
        name: r.name,
        address: r.address,
        distanceMeters: typeof r.distanceMeters === "number" ? r.distanceMeters : 0,
        mapsUrl: typeof r.mapsUrl === "string" ? r.mapsUrl : "",
        reason: r.reason,
      });
    }
  }
  return spots;
}

export default createMeetupRoutes();
