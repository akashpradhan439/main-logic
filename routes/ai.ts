import type { FastifyInstance } from "fastify";
import pg from "pg";
import { pool } from "../lib/db.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { redisGet, redisSet } from "../lib/redis.js";
import {
  suggestConnections,
  suggestInterests,
  type SuggestionCandidate,
} from "../lib/aiClient.js";

const SUGGESTIONS_CACHE_TTL_SECONDS = 900; // 15 minutes
const MAX_CANDIDATES_FOR_CLAUDE = 20;
const MAX_RESULTS = 10;

type SignalBag = {
  isNearby: boolean;
  proximityCount: number;
  mutualConnections: number;
};

function scoreCandidate(
  signals: SignalBag & { sharedInterestsCount: number }
): number {
  return (
    signals.sharedInterestsCount * 3 +
    signals.mutualConnections * 2 +
    signals.proximityCount +
    (signals.isNearby ? 1 : 0)
  );
}

export type AiRouteDeps = {
  pool: pg.Pool;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  redisGet: typeof redisGet;
  redisSet: typeof redisSet;
  suggestConnections: typeof suggestConnections;
  suggestInterests: typeof suggestInterests;
};

export function createAiRoutes(overrides: Partial<AiRouteDeps> = {}) {
  const deps: AiRouteDeps = {
    pool,
    verifyAccessToken,
    AuthError,
    redisGet,
    redisSet,
    suggestConnections,
    suggestInterests,
    ...overrides,
  };

  return async function aiRoutes(app: FastifyInstance) {
    const { pool, verifyAccessToken, AuthError, redisGet, redisSet, suggestConnections, suggestInterests } = deps;

    app.get("/ai/connections/suggestions", async (req, reply) => {
      const log = req.log;
      const requestStart = process.hrtime.bigint();

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

        // 1. Cache check (keyed by language so language switches don't return stale prose)
        const langResult = await pool.query("SELECT language_preference FROM users WHERE id = $1", [userId]);
        const userLang = (langResult.rows[0]?.language_preference as string | null) ?? "en";
        const cacheKey = `ai:suggestions:${userId}:${userLang}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            log.info({ event: "ai_suggestions_cache_hit", userId, lang: userLang }, "Returned cached suggestions");
            return reply.status(200).send({ success: true, suggestions: parsed, cached: true });
          } catch {
            // fall through on parse error
          }
        }

        // 2. Fetch current user profile
        const meResult = await pool.query(
          "SELECT h3_cell, h3_neighbors, bio, interests, language_preference FROM users WHERE id = $1",
          [userId]
        );
        const me = meResult.rows[0];

        if (!me) {
          log.error({ event: "ai_suggestions_me_fetch_failure", userId }, "Failed to fetch current user");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const myInterests = (me.interests as string[] | null) ?? [];
        const myNeighbors = (me.h3_neighbors as string[] | null) ?? [];
        const myCell = (me.h3_cell as string | null) ?? null;
        const myLanguage = (me.language_preference as string | null) ?? "en";

        // 3. Fetch exclusion set (all connections of any status involving current user)
        const connResult = await pool.query(
          "SELECT requester_id, addressee_id, status FROM connections WHERE requester_id = $1 OR addressee_id = $1",
          [userId]
        );

        const excludeIds = new Set<string>([userId]);
        const acceptedPartnerIds = new Set<string>();
        for (const row of connResult.rows) {
          const partnerId = row.requester_id === userId ? row.addressee_id : row.requester_id;
          excludeIds.add(partnerId);
          if (row.status === "accepted") acceptedPartnerIds.add(partnerId);
        }

        // 4. Gather candidates with signals
        const signalsByUser = new Map<string, SignalBag>();
        const ensure = (id: string): SignalBag => {
          let s = signalsByUser.get(id);
          if (!s) {
            s = { isNearby: false, proximityCount: 0, mutualConnections: 0 };
            signalsByUser.set(id, s);
          }
          return s;
        };

        // 4a. Nearby users by H3 cell
        const hexesToSearch = [myCell, ...myNeighbors].filter(
          (h): h is string => typeof h === "string" && h.length > 0
        );
        if (hexesToSearch.length > 0) {
          const nearbyResult = await pool.query(
            "SELECT id FROM users WHERE h3_cell = ANY($1) LIMIT 50",
            [hexesToSearch]
          );
          for (const u of nearbyResult.rows) {
            if (excludeIds.has(u.id)) continue;
            ensure(u.id).isNearby = true;
          }
        }

        // 4b. Proximity history via notifications table
        const notifResult = await pool.query(
          "SELECT user_a_id, user_b_id FROM notifications WHERE user_a_id = $1 OR user_b_id = $1 ORDER BY created_at DESC LIMIT 100",
          [userId]
        );
        for (const n of notifResult.rows) {
          const partner = n.user_a_id === userId ? n.user_b_id : n.user_a_id;
          if (excludeIds.has(partner)) continue;
          ensure(partner).proximityCount += 1;
        }

        // 4c. Friends-of-friends (two queries to avoid PostgREST .or/.in escaping issues)
        if (acceptedPartnerIds.size > 0) {
          const partnerList = Array.from(acceptedPartnerIds);
          const [fofResultA, fofResultB] = await Promise.all([
            pool.query(
              "SELECT requester_id, addressee_id FROM connections WHERE requester_id = ANY($1) AND status = 'accepted' LIMIT 200",
              [partnerList]
            ),
            pool.query(
              "SELECT requester_id, addressee_id FROM connections WHERE addressee_id = ANY($1) AND status = 'accepted' LIMIT 200",
              [partnerList]
            ),
          ]);
          const allFofRows = [...fofResultA.rows, ...fofResultB.rows];
          for (const row of allFofRows) {
            const aInPartners = acceptedPartnerIds.has(row.requester_id);
            const bInPartners = acceptedPartnerIds.has(row.addressee_id);
            let candidateId: string | null = null;
            if (aInPartners && !bInPartners) candidateId = row.addressee_id;
            else if (bInPartners && !aInPartners) candidateId = row.requester_id;
            if (!candidateId || excludeIds.has(candidateId)) continue;
            ensure(candidateId).mutualConnections += 1;
          }
        }

        if (signalsByUser.size === 0) {
          await redisSet(cacheKey, JSON.stringify([]), SUGGESTIONS_CACHE_TTL_SECONDS);
          return reply.status(200).send({ success: true, suggestions: [], cached: false });
        }

        // 5. Fetch candidate profiles
        const candidateIds = Array.from(signalsByUser.keys());
        const candidateResult = await pool.query(
          "SELECT id, first_name, last_name, bio, interests FROM users WHERE id = ANY($1)",
          [candidateIds]
        );

        // 6. Build candidate payloads + pre-rank
        type Enriched = {
          payload: SuggestionCandidate;
          firstName: string;
          lastName: string;
          bio: string | null;
          interests: string[];
          rankScore: number;
        };

        const enriched: Enriched[] = candidateResult.rows.map((c) => {
          const interests = (c.interests as string[] | null) ?? [];
          const sharedInterests = myInterests.filter((i) => interests.includes(i));
          const sig = signalsByUser.get(c.id)!;
          return {
            payload: {
              userId: c.id,
              firstName: c.first_name as string,
              bio: (c.bio as string | null) ?? null,
              interests,
              signals: {
                isNearby: sig.isNearby,
                proximityCount: sig.proximityCount,
                mutualConnections: sig.mutualConnections,
                sharedInterests,
              },
            },
            firstName: c.first_name as string,
            lastName: c.last_name as string,
            bio: (c.bio as string | null) ?? null,
            interests,
            rankScore: scoreCandidate({
              isNearby: sig.isNearby,
              proximityCount: sig.proximityCount,
              mutualConnections: sig.mutualConnections,
              sharedInterestsCount: sharedInterests.length,
            }),
          };
        });

        enriched.sort((a, b) => b.rankScore - a.rankScore);
        const topCandidates = enriched.slice(0, MAX_CANDIDATES_FOR_CLAUDE);

        // 7. Call Claude for ranking + reasons
        const ranked = await suggestConnections(
          { bio: (me.bio as string | null) ?? null, interests: myInterests },
          topCandidates.map((e) => e.payload),
          myLanguage
        );

        // 8. Merge Claude reasons with candidate profile data, preserving Claude's order
        const byId = new Map(topCandidates.map((e) => [e.payload.userId, e]));
        const final = ranked
          .map((r) => {
            const e = byId.get(r.userId);
            if (!e) return null;
            return {
              userId: r.userId,
              firstName: e.firstName,
              lastName: e.lastName,
              bio: e.bio,
              interests: e.interests,
              reason: r.reason,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .slice(0, MAX_RESULTS);

        // 9. Cache and return
        await redisSet(cacheKey, JSON.stringify(final), SUGGESTIONS_CACHE_TTL_SECONDS);

        const requestDurationMs = Number(process.hrtime.bigint() - requestStart) / 1_000_000;
        log.info(
          {
            event: "ai_suggestions_generated",
            userId,
            candidateCount: enriched.length,
            returnedCount: final.length,
            durationMs: requestDurationMs,
          },
          "AI suggestions generated"
        );

        return reply.status(200).send({ success: true, suggestions: final, cached: false });
      } catch (err) {
        log.error({ event: "ai_suggestions_error", err }, "Unexpected error in GET /ai/connections/suggestions");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    app.post("/ai/interests/suggestions", async (req, reply) => {
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

        const body = req.body as { bio?: unknown };
        const bio = body?.bio;
        if (typeof bio !== "string" || bio.trim().length === 0 || bio.length > 300) {
          return reply
            .status(400)
            .send({ success: false, error: req.t("common.errors.invalid_parameter") });
        }

        const meLangResult = await pool.query(
          "SELECT language_preference FROM users WHERE id = $1",
          [userId]
        );
        const userLanguage = (meLangResult.rows[0]?.language_preference as string | null) ?? "en";

        const interests = await suggestInterests(bio.trim(), userLanguage);

        log.info({ event: "ai_interests_generated", userId, interestCount: interests.length }, "AI interests generated");

        return reply.status(200).send({ success: true, interests });
      } catch (err) {
        log.error({ event: "ai_interests_error", err }, "Unexpected error in POST /ai/interests/suggestions");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

export default createAiRoutes();
