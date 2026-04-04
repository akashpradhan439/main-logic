import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { uploadPrekeys, getPrekeyBundle } from "../lib/keys.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const UploadKeysSchema = z.object({
  identityKey: z.string(),
  signedPrekey: z.string(),
  pqSignedPrekey: z.string(),
  signature: z.string(),
  oneTimePrekeys: z.array(z.object({
    key: z.string(),
    isPq: z.boolean(),
  })).optional().default([]),
});

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type KeysRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  uploadPrekeys: typeof uploadPrekeys;
  getPrekeyBundle: typeof getPrekeyBundle;
  AuthError: typeof AuthError;
};

export function createKeysRoutes(
  overrides: Partial<KeysRouteDeps> = {}
) {
  const deps: KeysRouteDeps = {
    supabase,
    verifyAccessToken,
    uploadPrekeys,
    getPrekeyBundle,
    AuthError,
    ...overrides,
  };

  return async function keysRoutes(app: FastifyInstance) {
    const {
      supabase,
      verifyAccessToken,
      uploadPrekeys,
      getPrekeyBundle,
      AuthError,
    } = deps;

    // ─── POST: Upload Prekeys ───────────────────────────────────────────
    
    app.post("/keys/upload", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = UploadKeysSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { identityKey, signedPrekey, pqSignedPrekey, signature, oneTimePrekeys } = parsed.data;

        const { error } = await uploadPrekeys(
          supabase as any,
          userId,
          { identityKey, signedPrekey, pqSignedPrekey, signature },
          oneTimePrekeys
        );

        if (error) {
          log.error({ event: "keys_upload_failure", userId, error }, "Failed to upload prekeys");
          return reply.status(500).send({ success: false, error: "Failed to upload prekeys" });
        }

        log.info({ event: "keys_upload_success", userId }, "Prekeys uploaded successfully");
        return reply.status(200).send({ success: true });
      } catch (err) {
        log.error({ event: "keys_upload_error", error: err }, "Unexpected error in keys/upload");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });

    // ─── GET: Fetch Prekey Bundle ───────────────────────────────────────────
    
    app.get("/keys/bundle/:userId", async (req, reply) => {
      const log = req.log;
      const { userId: targetUserId } = req.params as { userId: string };

      try {
        // Authenticate requester
        try {
          verifyAccessToken(req.headers.authorization);
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const { bundle, error } = await getPrekeyBundle(supabase as any, targetUserId);

        if (error || !bundle) {
          log.error({ event: "keys_bundle_fetch_failure", targetUserId, error }, "Failed to fetch prekey bundle");
          return reply.status(404).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        log.info({ event: "keys_bundle_fetch_success", targetUserId }, "Prekey bundle fetched");
        return reply.status(200).send({ success: true, bundle });
      } catch (err) {
        log.error({ event: "keys_bundle_error", error: err }, "Unexpected error in keys/bundle");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });
  };
}

export default createKeysRoutes();
