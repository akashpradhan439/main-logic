import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";

const UpdateProfileSchema = z
  .object({
    bio: z.string().max(300).nullable().optional(),
    interests: z
      .array(z.string().min(1).max(50))
      .max(15)
      .optional(),
  })
  .strict();

export type ProfileRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
};

export function createProfileRoutes(overrides: Partial<ProfileRouteDeps> = {}) {
  const deps: ProfileRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    ...overrides,
  };

  return async function profileRoutes(app: FastifyInstance) {
    const { supabase, verifyAccessToken, AuthError } = deps;

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

        const { data, error } = await supabase
          .from("users")
          .select("id, first_name, last_name, bio, interests")
          .eq("id", userId)
          .single();

        if (error) {
          log.error({ event: "profile_fetch_failure", userId, error }, "Failed to fetch profile");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

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

        const { data, error } = await supabase
          .from("users")
          .update(updates)
          .eq("id", userId)
          .select("bio, interests")
          .single();

        if (error) {
          log.error({ event: "profile_update_failure", userId, error }, "Failed to update profile");
          return reply
            .status(500)
            .send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

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
  };
}

export default createProfileRoutes();
