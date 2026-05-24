import type { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { redisGet, redisSet } from "../lib/redis.js";
import { cellToLatLngSafe } from "../shared/h3.js";
import { config } from "../config.js";

const SUGGESTIONS_CACHE_TTL_SECONDS = 1800;
const N8N_TIMEOUT_MS = 45_000;

type ConnectionContext = {
  userId: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  interests: string[];
  h3Cell: string | null;
  suggestionType: "detailed" | "one_liner";
  signals: {
    sharedInterests: string[];
    hasRichProfile: boolean;
    nearby: boolean;
    score: number;
  };
};

const DETAILED_LIMIT = 2;
const ONELINER_LIMIT = 3;

type SuggestionsContext = {
  userId: string;
  firstName: string;
  bio: string | null;
  interests: string[];
  language: string;
  languageLabel: string;
  lat: number;
  lng: number;
  h3Cell: string;
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  dayOfWeek: string;
  date: string;
  connections: ConnectionContext[];
};

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  bn: "Bangla (Bengali)",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  ja: "Japanese",
  pt: "Portuguese",
  ru: "Russian",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
};

function bucketTimeOfDay(d: Date): SuggestionsContext["timeOfDay"] {
  const h = d.getHours();
  if (h >= 6 && h <= 11) return "morning";
  if (h >= 12 && h <= 17) return "afternoon";
  if (h >= 18 && h <= 21) return "evening";
  return "night";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type MeetupSuggestionsRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  redisGet: typeof redisGet;
  redisSet: typeof redisSet;
  fetchImpl: typeof fetch;
};

export function createMeetupSuggestionsRoutes(
  overrides: Partial<MeetupSuggestionsRouteDeps> = {}
) {
  const deps: MeetupSuggestionsRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    redisGet,
    redisSet,
    fetchImpl: fetch,
    ...overrides,
  };

  return async function meetupSuggestionsRoutes(app: FastifyInstance) {
    const { supabase, verifyAccessToken, AuthError, redisGet, redisSet, fetchImpl } = deps;

    // ─── Internal: Context endpoint called by n8n ───────────────────────────

    app.get("/ai/meetup/suggestions/context", async (req, reply) => {
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

        const { data: me, error: meErr } = await supabase
          .from("users")
          .select("first_name, bio, interests, h3_cell, language_preference")
          .eq("id", userId)
          .single();

        if (meErr || !me) {
          log.error(
            { event: "meetup_suggestions_me_fetch_failure", userId, meErr },
            "Failed to fetch user"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const h3Cell = (me.h3_cell as string | null) ?? null;
        if (!h3Cell) {
          return reply.status(400).send({ success: false, error: "location_required" });
        }
        const coords = cellToLatLngSafe(h3Cell);
        if (!coords) {
          return reply.status(400).send({ success: false, error: "location_invalid" });
        }

        const { data: connRows, error: connErr } = await supabase
          .from("connections")
          .select("requester_id, addressee_id, status")
          .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
          .eq("status", "accepted");

        if (connErr) {
          log.error(
            { event: "meetup_suggestions_conn_fetch_failure", userId, connErr },
            "Failed to fetch connections"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const partnerIds: string[] = [];
        for (const row of connRows ?? []) {
          const partner =
            row.requester_id === userId ? row.addressee_id : row.requester_id;
          if (typeof partner === "string" && partner.length > 0) {
            partnerIds.push(partner);
          }
        }

        let connections: ConnectionContext[] = [];
        if (partnerIds.length > 0) {
          const { data: partnerProfiles, error: pErr } = await supabase
            .from("users")
            .select("id, first_name, last_name, bio, interests, h3_cell")
            .in("id", partnerIds);
          if (pErr) {
            log.error(
              { event: "meetup_suggestions_partners_fetch_failure", userId, pErr },
              "Failed to fetch partner profiles"
            );
            return reply
              .status(500)
              .send({ success: false, error: req.t("common.errors.unable_to_process") });
          }
          const myInterestSet = new Set((me.interests as string[] | null) ?? []);
          const scored = (partnerProfiles ?? []).map((p) => {
            const cInterests = (p.interests as string[] | null) ?? [];
            const cBio = (p.bio as string | null) ?? null;
            const cH3 = (p.h3_cell as string | null) ?? null;
            const sharedInterests = cInterests.filter((i) => myInterestSet.has(i));
            const hasRichProfile =
              (cBio?.trim().length ?? 0) > 0 && cInterests.length >= 2;
            const nearby = cH3 !== null && cH3 === h3Cell;
            const score =
              sharedInterests.length * 3 +
              (hasRichProfile ? 2 : 0) +
              (nearby ? 1 : 0);
            return {
              base: {
                userId: p.id as string,
                firstName: p.first_name as string,
                lastName: p.last_name as string,
                bio: cBio,
                interests: cInterests,
                h3Cell: cH3,
              },
              sharedInterests,
              hasRichProfile,
              nearby,
              score,
            };
          });
          scored.sort((a, b) => b.score - a.score);
          connections = scored
            .slice(0, DETAILED_LIMIT + ONELINER_LIMIT)
            .map((entry, idx) => ({
              ...entry.base,
              suggestionType: idx < DETAILED_LIMIT ? "detailed" : "one_liner",
              signals: {
                sharedInterests: entry.sharedInterests,
                hasRichProfile: entry.hasRichProfile,
                nearby: entry.nearby,
                score: entry.score,
              },
            }));
        }

        const now = new Date();
        const languageCode = ((me.language_preference as string | null) ?? "en");
        const languageLabel = LANGUAGE_LABELS[languageCode] ?? "English";
        const context: SuggestionsContext = {
          userId,
          firstName: me.first_name as string,
          bio: (me.bio as string | null) ?? null,
          interests: (me.interests as string[] | null) ?? [],
          language: languageCode,
          languageLabel,
          lat: coords.lat,
          lng: coords.lng,
          h3Cell,
          timeOfDay: bucketTimeOfDay(now),
          dayOfWeek: DAYS[now.getDay()] ?? "Unknown",
          date: `${DAYS[now.getDay()] ?? "Unknown"}, ${MONTHS[now.getMonth()] ?? ""} ${now.getDate()}`,
          connections,
        };

        return reply.status(200).send({ success: true, context });
      } catch (err) {
        log.error(
          { event: "meetup_suggestions_context_error", err },
          "Unexpected error in /ai/meetup/suggestions/context"
        );
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── Client-facing: Trigger n8n workflow ────────────────────────────────

    app.get("/ai/meetup/suggestions", async (req, reply) => {
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

        const { data: user, error: userErr } = await supabase
          .from("users")
          .select("h3_cell")
          .eq("id", userId)
          .single();
        if (userErr || !user) {
          log.error(
            { event: "meetup_suggestions_user_fetch_failure", userId, userErr },
            "Failed to fetch user"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }
        if (!user.h3_cell) {
          return reply.status(400).send({ success: false, error: "location_required" });
        }

        const cacheKey = `meetup:suggestions:${userId}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            return reply
              .status(200)
              .send({ success: true, cached: true, suggestions: parsed });
          } catch {
            // fall through
          }
        }

        if (!config.n8nMeetupSuggestionsWebhookUrl) {
          log.error(
            { event: "meetup_suggestions_n8n_not_configured", userId },
            "n8n webhook URL not set"
          );
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);

        let n8nResponse: Response;
        try {
          n8nResponse = await fetchImpl(config.n8nMeetupSuggestionsWebhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-N8N-Secret": config.n8nWebhookSecret,
            },
            body: JSON.stringify({ jwt: bearerToken }),
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(timeout);
          log.error(
            { event: "meetup_suggestions_n8n_call_failure", userId, err },
            "n8n webhook call failed"
          );
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }
        clearTimeout(timeout);

        if (!n8nResponse.ok) {
          log.error(
            { event: "meetup_suggestions_n8n_bad_status", userId, status: n8nResponse.status },
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
          log.error(
            { event: "meetup_suggestions_n8n_bad_json", userId, err },
            "n8n response not JSON"
          );
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        const result = extractSuggestions(n8nBody);
        if (!result) {
          log.error(
            { event: "meetup_suggestions_n8n_bad_shape", userId, n8nBody },
            "n8n response shape invalid"
          );
          return reply
            .status(503)
            .send({ success: false, error: "suggestions_unavailable" });
        }

        await redisSet(
          cacheKey,
          JSON.stringify(result.suggestions),
          SUGGESTIONS_CACHE_TTL_SECONDS
        );

        log.info(
          {
            event: "meetup_suggestions_generated",
            userId,
            count: result.suggestions.length,
            attempts: result.attempts,
            approved: result.approved,
          },
          "Meet-up suggestions generated"
        );

        return reply.status(200).send({
          success: true,
          cached: false,
          suggestions: result.suggestions,
          supervisor: {
            approved: result.approved,
            attempts: result.attempts,
            lastFeedback: result.lastFeedback,
          },
        });
      } catch (err) {
        log.error(
          { event: "meetup_suggestions_error", err },
          "Unexpected error in /ai/meetup/suggestions"
        );
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

type DetailedSuggestion = {
  type: "detailed";
  connectionId: string;
  connectionName: string;
  title: string;
  place: string;
  time: string;
  text: string;
};

type OneLinerSuggestion = {
  type: "one_liner";
  connectionId: string;
  connectionName: string;
  text: string;
};

type SuggestionItem = DetailedSuggestion | OneLinerSuggestion;

type ExtractedResult = {
  suggestions: SuggestionItem[];
  attempts: number;
  approved: boolean;
  lastFeedback: string;
};

function extractSuggestions(body: unknown): ExtractedResult | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const raw = obj.suggestions;
  if (!Array.isArray(raw)) return null;
  const suggestions: SuggestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (
      s.type === "detailed" &&
      typeof s.connectionId === "string" &&
      typeof s.connectionName === "string" &&
      typeof s.title === "string" &&
      typeof s.place === "string" &&
      typeof s.time === "string" &&
      typeof s.text === "string"
    ) {
      suggestions.push({
        type: "detailed",
        connectionId: s.connectionId,
        connectionName: s.connectionName,
        title: s.title,
        place: s.place,
        time: s.time,
        text: s.text,
      });
    } else if (
      s.type === "one_liner" &&
      typeof s.connectionId === "string" &&
      typeof s.connectionName === "string" &&
      typeof s.text === "string"
    ) {
      suggestions.push({
        type: "one_liner",
        connectionId: s.connectionId,
        connectionName: s.connectionName,
        text: s.text,
      });
    }
  }
  if (suggestions.length === 0) return null;
  const attempts = typeof obj.attempts === "number" ? obj.attempts : 1;
  const approved = obj.approved === true;
  const lastFeedback = typeof obj.lastFeedback === "string" ? obj.lastFeedback : "";
  return { suggestions, attempts, approved, lastFeedback };
}

export default createMeetupSuggestionsRoutes();
