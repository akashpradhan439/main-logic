import type { FastifyInstance } from "fastify";
import { z } from "zod";
import pg from "pg";
import { pool } from "../lib/db.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";

export const SUPPORTED_LANGUAGES = [
  "en",
  "ar",
  "bn",
  "es",
  "fr",
  "hi",
  "ja",
  "pt",
  "ru",
  "zh-Hans",
  "zh-Hant",
] as const;

const UpdateProfileSchema = z
  .object({
    bio: z.string().max(300).nullable().optional(),
    interests: z
      .array(z.string().min(1).max(50))
      .max(15)
      .optional(),
  })
  .strict();

const UpdateLanguageSchema = z
  .object({
    language_preference: z.enum(SUPPORTED_LANGUAGES),
  })
  .strict();

export type ProfileRouteDeps = {
  pool: pg.Pool;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
};

export function createProfileRoutes(overrides: Partial<ProfileRouteDeps> = {}) {
  const deps: ProfileRouteDeps = {
    pool,
    verifyAccessToken,
    AuthError,
    ...overrides,
  };

  return async function profileRoutes(app: FastifyInstance) {
    const { pool, verifyAccessToken, AuthError } = deps;

    app.get("/profile", async (req, reply) => {
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

        const { rows } = await pool.query(
          "SELECT id, first_name, last_name, bio, interests FROM users WHERE id = $1",
          [userId]
        );

        if (rows.length === 0) {
          log.error({ event: "profile_fetch_failure", userId }, "User not found");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const data = rows[0];

        return reply.status(200).send({
          success: true,
          profile: {
            id: data.id,
            firstName: data.first_name,
            lastName: data.last_name,
            bio: data.bio ?? null,
            interests: (data.interests as string[] | null) ?? [],
          },
        });
      } catch (err) {
        log.error({ event: "profile_get_error", err }, "Unexpected error in GET /profile");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    app.patch("/profile", async (req, reply) => {
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

        const parsed = UpdateProfileSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const updates: { bio?: string | null; interests?: string[] } = {};
        if (parsed.data.bio !== undefined) updates.bio = parsed.data.bio;
        if (parsed.data.interests !== undefined) {
          updates.interests = parsed.data.interests.map((s) => s.trim().toLowerCase());
        }

        if (Object.keys(updates).length === 0) {
          return reply
            .status(400)
            .send({ success: false, error: req.t("common.errors.invalid_parameter") });
        }

        const bio = updates.bio !== undefined ? updates.bio : null;
        const interests = updates.interests !== undefined ? JSON.stringify(updates.interests) : null;

        const { rows } = await pool.query(
          "UPDATE users SET bio = $1, interests = $2 WHERE id = $3 RETURNING bio, interests",
          [bio, interests, userId]
        );

        if (rows.length === 0) {
          log.error({ event: "profile_update_failure", userId }, "Failed to update profile");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const data = rows[0];

        log.info({ event: "profile_updated", userId }, "Profile updated");
        return reply.status(200).send({
          success: true,
          profile: {
            bio: data.bio ?? null,
            interests: (data.interests as string[] | null) ?? [],
          },
        });
      } catch (err) {
        log.error({ event: "profile_patch_error", err }, "Unexpected error in PATCH /profile");
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    app.patch("/profile/language", async (req, reply) => {
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

        const parsed = UpdateLanguageSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({
            success: false,
            error: req.t("common.errors.invalid_parameter"),
            supported: SUPPORTED_LANGUAGES,
          });
        }

        const { rows } = await pool.query(
          "UPDATE users SET language_preference = $1 WHERE id = $2 RETURNING language_preference",
          [parsed.data.language_preference, userId]
        );

        if (rows.length === 0) {
          log.error(
            { event: "language_update_failure", userId },
            "Failed to update language preference"
          );
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const data = rows[0];

        log.info(
          { event: "language_updated", userId, language: data.language_preference },
          "Language preference updated"
        );
        return reply.status(200).send({
          success: true,
          languagePreference: data.language_preference,
        });
      } catch (err) {
        log.error(
          { event: "language_patch_error", err },
          "Unexpected error in PATCH /profile/language"
        );
        return reply
          .status(500)
          .send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

export default createProfileRoutes();
