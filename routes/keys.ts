import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { uploadPrekeys, getPrekeyBundle, rotateSignedPrekey, getOpkStatus } from "../lib/keys.js";
import { findConnectionBetweenUsers, isPairBlocked } from "../lib/connections.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

function isValidBase64(s: string): boolean {
  if (s.length === 0) return false;
  try {
    const decoded = Buffer.from(s, "base64");
    return decoded.toString("base64") === s;
  } catch {
    return false;
  }
}

function base64Key(byteLen: number) {
  return z.string().refine(
    (s) => {
      if (!isValidBase64(s)) return false;
      return Buffer.from(s, "base64").length === byteLen;
    },
    { message: `Must be valid base64 encoding exactly ${byteLen} bytes` }
  );
}

// X25519 keys are 32 bytes, Ed25519 keys/sigs are 32/64 bytes, ML-KEM-768 public key is 1184 bytes
const base64X25519 = base64Key(32);
const base64Ed25519Pub = base64Key(32);
const base64Ed25519Sig = base64Key(64);
const base64MlKem768 = base64Key(1184);

// H1: an OPK may be a bare base64 string (legacy) or carry a client-assigned id.
const OneTimePrekeySchema = z.union([
  base64X25519,
  z.object({ keyId: z.number().int().nonnegative(), publicKey: base64X25519 }),
]);

const PqOneTimePrekeySchema = z.union([
  base64MlKem768,
  z.object({ keyId: z.number().int().nonnegative(), publicKey: base64MlKem768 }),
]);

const UploadKeysSchema = z.object({
  identityKey:             base64Ed25519Pub,
  identitySigningKey:      base64Ed25519Pub.optional(),
  signedPreKey:            base64X25519,
  signedPreKeyId:          z.number().int().positive().default(1),
  pqSignedPreKey:          base64MlKem768,
  pqSignedPreKeyId:        z.number().int().positive().default(1),
  signedPreKeySignature:   base64Ed25519Sig,
  pqSignedPreKeySignature: base64Ed25519Sig,
  oneTimePreKeys:          z.array(OneTimePrekeySchema).optional().default([]),
  pqOneTimePreKeys:        z.array(PqOneTimePrekeySchema).optional().default([]),
});

const RotateSignedPrekeySchema = z.object({
  signedPreKey:          base64X25519,
  signedPreKeyId:        z.number().int().positive(),
  signedPreKeySignature: base64Ed25519Sig,
});

const RotatePqSignedPrekeySchema = z.object({
  pqSignedPreKey:          base64MlKem768,
  pqSignedPreKeyId:        z.number().int().positive(),
  pqSignedPreKeySignature: base64Ed25519Sig,
});

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type KeysRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  uploadPrekeys: typeof uploadPrekeys;
  getPrekeyBundle: typeof getPrekeyBundle;
  rotateSignedPrekey: typeof rotateSignedPrekey;
  getOpkStatus: typeof getOpkStatus;
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
    getOpkStatus,
    findConnectionBetweenUsers,
    isPairBlocked,
    AuthError,
    ...overrides,
  };

  return async function keysRoutes(app: FastifyInstance) {
    const {
      supabase, verifyAccessToken, uploadPrekeys, getPrekeyBundle,
      rotateSignedPrekey, getOpkStatus, findConnectionBetweenUsers, isPairBlocked, AuthError,
    } = deps;

    // ─── POST: Upload Prekeys ───────────────────────────────────────────

    app.post("/keys/upload", {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (req, reply) => {
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

        // C5/N1: identitySigningKey is optional — defaults to identityKey (XEdDSA single-key model).
        // The server uses identityKey for both signing verification and DH derivation.
        const effectiveSigningKey = identitySigningKey ?? identityKey;

        const { error } = await uploadPrekeys(
          supabase as any,
          userId,
          {
            identityKey,
            identitySigningKey: effectiveSigningKey,
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

    app.get("/keys/bundle/:userId", {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    }, async (req, reply) => {
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

        const { bundle, error, opkPoolLow } = await getPrekeyBundle(supabase as any, targetUserId);

        if (error || !bundle) {
          // M7: distinguish a stale bundle (re-upload needed) from not-found.
          if (error instanceof Error && error.message.startsWith("PREKEY_BUNDLE_STALE")) {
            log.warn({ event: "keys_bundle_stale", targetUserId }, "Prekey bundle is stale");
            return reply.status(422).send({ success: false, error: req.t("common.errors.unable_to_process"), code: "PREKEY_BUNDLE_STALE" });
          }
          log.error({ event: "keys_bundle_fetch_failure", targetUserId, error }, "Failed to fetch prekey bundle");
          return reply.status(404).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        if (opkPoolLow) {
          log.warn({ event: "keys_opk_pool_low", targetUserId }, "OPK pool is low — client should re-upload");
        }

        log.info({ event: "keys_bundle_fetch_success", targetUserId }, "Prekey bundle fetched");
        return reply.status(200).send({ success: true, bundle });
      } catch (err) {
        log.error({ event: "keys_bundle_error", error: err }, "Unexpected error in keys/bundle");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });

    // ─── PUT: Rotate Signed Prekey (C2: archive instead of overwrite) ────

    app.put("/keys/signed-prekey", {
      config: { rateLimit: { max: 2, timeWindow: "1 minute" } },
    }, async (req, reply) => {
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

    app.put("/keys/pq-signed-prekey", {
      config: { rateLimit: { max: 2, timeWindow: "1 minute" } },
    }, async (req, reply) => {
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

    // ─── GET: OPK Pool Status ────────────────────────────────────────────

    app.get("/keys/opk-status", {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    }, async (req, reply) => {
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

        const { classical, pq, error } = await getOpkStatus(supabase as any, userId);
        if (error) {
          log.error({ event: "opk_status_failure", userId, error }, "Failed to get OPK status");
          return reply.status(500).send({ success: false, error: "Failed to get OPK status" });
        }

        log.info({ event: "opk_status_success", userId, classical, pq }, "OPK status fetched");
        return reply.status(200).send({ success: true, classical, pq });
      } catch (err) {
        log.error({ event: "opk_status_error", error: err }, "Unexpected error in keys/opk-status");
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    });
  };
}

export default createKeysRoutes();
