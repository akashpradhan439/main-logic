import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { uploadPrekeys, getPrekeyBundle, rotateSignedPrekey } from "../lib/keys.js";
import { findConnectionBetweenUsers, isPairBlocked } from "../lib/connections.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

// H1: an OPK may be a bare base64 string (legacy) or carry a client-assigned id.
const OneTimePrekeySchema = z.union([
  z.string().min(1),
  z.object({ keyId: z.number().int().nonnegative(), publicKey: z.string().min(1) }),
]);

const UploadKeysSchema = z.object({
  identityKey:             z.string().min(1),
  identitySigningKey:      z.string().min(1),
  signedPreKey:            z.string().min(1),
  signedPreKeyId:          z.number().int().positive().default(1),
  pqSignedPreKey:          z.string().min(1),
  pqSignedPreKeyId:        z.number().int().positive().default(1),
  signedPreKeySignature:   z.string().min(1),
  pqSignedPreKeySignature: z.string().min(1),
  oneTimePreKeys:          z.array(OneTimePrekeySchema).optional().default([]),
  pqOneTimePreKeys:        z.array(OneTimePrekeySchema).optional().default([]),
});

const RotateSignedPrekeySchema = z.object({
  signedPreKey:          z.string().min(1),
  signedPreKeyId:        z.number().int().positive(),
  signedPreKeySignature: z.string().min(1),
});

const RotatePqSignedPrekeySchema = z.object({
  pqSignedPreKey:          z.string().min(1),
  pqSignedPreKeyId:        z.number().int().positive(),
  pqSignedPreKeySignature: z.string().min(1),
});

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type KeysRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  uploadPrekeys: typeof uploadPrekeys;
  getPrekeyBundle: typeof getPrekeyBundle;
  rotateSignedPrekey: typeof rotateSignedPrekey;
  findConnectionBetweenUsers: typeof findConnectionBetweenUsers;
  isPairBlocked: typeof isPairBlocked;
  AuthError: typeof AuthError;
};

export function createKeysRoutes(overrides: Partial<KeysRouteDeps> = {}) {
  const deps: KeysRouteDeps = {
    supabase,
    verifyAccessToken,
    uploadPrekeys,
    getPrekeyBundle,
    rotateSignedPrekey,
    findConnectionBetweenUsers,
    isPairBlocked,
    AuthError,
    ...overrides,
  };

  return async function keysRoutes(app: FastifyInstance) {
    const {
      supabase, verifyAccessToken, uploadPrekeys, getPrekeyBundle,
      rotateSignedPrekey, findConnectionBetweenUsers, isPairBlocked, AuthError,
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

        const {
          identityKey, identitySigningKey, signedPreKey, signedPreKeyId,
          pqSignedPreKey, pqSignedPreKeyId,
          signedPreKeySignature, pqSignedPreKeySignature,
          oneTimePreKeys, pqOneTimePreKeys,
        } = parsed.data;

        const { error } = await uploadPrekeys(
          supabase as any,
          userId,
          {
            identityKey,
            identitySigningKey,
            signedPrekey:     signedPreKey,
            signedPrekeyId:   signedPreKeyId,
            pqSignedPrekey:   pqSignedPreKey,
            pqSignedPrekeyId: pqSignedPreKeyId,
            signature:        signedPreKeySignature,
            pqSignature:      pqSignedPreKeySignature,
          },
          oneTimePreKeys,
          pqOneTimePreKeys
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

    // ─── GET: Fetch Prekey Bundle ───────────────────────────────────────

    app.get("/keys/bundle/:userId", async (req, reply) => {
      const log = req.log;
      const { userId: targetUserId } = req.params as { userId: string };

      try {
        let requesterId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          requesterId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        // C3: fetching a bundle consumes one-time prekeys, so gate it on an
        // accepted (non-blocked) connection. Without this any logged-in user can
        // drain another user's OPK pool. Self-fetch is allowed (e.g. diagnostics).
        if (targetUserId !== requesterId) {
          const { row: connection, error: connError } = await findConnectionBetweenUsers(
            supabase as any, requesterId, targetUserId
          );
          if (connError) {
            log.error({ event: "keys_bundle_conn_error", requesterId, targetUserId, error: connError }, "Failed to check connection");
            return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
          }
          if (!connection || connection.status !== "accepted" || isPairBlocked(connection)) {
            log.info({ event: "keys_bundle_forbidden", requesterId, targetUserId }, "Bundle fetch blocked: not connected");
            return reply.status(403).send({ success: false, error: req.t("messaging.errors.not_connected") });
          }
        }

        const { bundle, error } = await getPrekeyBundle(supabase as any, targetUserId);

        if (error || !bundle) {
          // M7: distinguish a stale bundle (re-upload needed) from not-found.
          if (error instanceof Error && error.message.startsWith("PREKEY_BUNDLE_STALE")) {
            log.warn({ event: "keys_bundle_stale", targetUserId }, "Prekey bundle is stale");
            return reply.status(422).send({ success: false, error: req.t("common.errors.unable_to_process"), code: "PREKEY_BUNDLE_STALE" });
          }
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

    // ─── PUT: Rotate Signed Prekey (C2: archive instead of overwrite) ────

    app.put("/keys/signed-prekey", async (req, reply) => {
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

        const parsed = RotateSignedPrekeySchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { signedPreKey, signedPreKeyId, signedPreKeySignature } = parsed.data;

        const { error } = await rotateSignedPrekey(supabase as any, userId, {
          prekeyId:  signedPreKeyId,
          publicKey: signedPreKey,
          signature: signedPreKeySignature,
          isPq:      false,
        });

        if (error) {
          log.error({ event: "spk_rotation_failure", userId, error }, "Failed to rotate signed prekey");
          return reply.status(500).send({ success: false, error: "Failed to rotate signed prekey" });
        }

        log.info({ event: "spk_rotation_success", userId, signedPreKeyId }, "Signed prekey rotated");
        return reply.status(200).send({ success: true });
      } catch (err) {
        log.error({ event: "spk_rotation_error", error: err }, "Unexpected error rotating signed prekey");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });

    // ─── PUT: Rotate PQ Signed Prekey (H5) ──────────────────────────────

    app.put("/keys/pq-signed-prekey", async (req, reply) => {
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

        const parsed = RotatePqSignedPrekeySchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { pqSignedPreKey, pqSignedPreKeyId, pqSignedPreKeySignature } = parsed.data;

        const { error } = await rotateSignedPrekey(supabase as any, userId, {
          prekeyId:  pqSignedPreKeyId,
          publicKey: pqSignedPreKey,
          signature: pqSignedPreKeySignature,
          isPq:      true,
        });

        if (error) {
          log.error({ event: "pq_spk_rotation_failure", userId, error }, "Failed to rotate PQ signed prekey");
          return reply.status(500).send({ success: false, error: "Failed to rotate PQ signed prekey" });
        }

        log.info({ event: "pq_spk_rotation_success", userId, pqSignedPreKeyId }, "PQ signed prekey rotated");
        return reply.status(200).send({ success: true });
      } catch (err) {
        log.error({ event: "pq_spk_rotation_error", error: err }, "Unexpected error rotating PQ signed prekey");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });
  };
}

export default createKeysRoutes();
