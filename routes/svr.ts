import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { config } from "../config.js";
import { memzero } from "../shared/cryptography.js";
import { 
  getSvrBackup, upsertSvrBackupSeed, updateSvrBlobs, 
  incrementGuessCountAndGet, deleteSvrBackup 
} from "../lib/svr.js";
import { generateOprfSeed, oprfEvaluate } from "../lib/oprf.js";

function isValidBase64(s: string): boolean {
  if (s.length === 0) return false;
  try {
    const decoded = Buffer.from(s, "base64");
    return decoded.toString("base64") === s;
  } catch {
    return false;
  }
}

const base64String = z.string().refine(isValidBase64, { message: "Must be valid base64" });

const EvaluateSchema = z.object({
  blinded_element: base64String
});

const BackupSchema = z.object({
  encrypted_master_key: base64String,
  encrypted_blob: base64String,
  version: z.number().int().positive().default(1)
});

const MAX_ENCRYPTED_MASTER_KEY_SIZE = 1024; // H2: 1 KB cap for encrypted master key

export default async function svrRoutes(app: FastifyInstance) {

  // ─── POST /svr/backup/evaluate — OPRF evaluation for backup creation ──────
  app.post("/svr/backup/evaluate", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.svrEnabled) {
      return reply.status(503).send({ error: "SVR is currently disabled." });
    }

    let oprfSeed: Uint8Array | null = null;
    try {
      const user = verifyAccessToken(req.headers.authorization);
      const parsed = EvaluateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
      }

      // H1: Always generate a fresh seed for backup creation. The old seed
      // is rotated and oprf_key_version is bumped atomically in the DB.
      oprfSeed = await generateOprfSeed();
      await upsertSvrBackupSeed(pool, user.sub, oprfSeed);

      const blindedElement = Buffer.from(parsed.data.blinded_element, "base64");
      const evaluated = await oprfEvaluate(blindedElement, oprfSeed);

      req.log.info({ event: "svr_backup_evaluate", userId: user.sub }, "SVR backup OPRF evaluation completed");

      return reply.status(200).send({
        evaluated_element: Buffer.from(evaluated).toString("base64")
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error({ err }, "SVR backup evaluate error");
      return reply.status(500).send({ error: "Internal server error" });
    } finally {
      // H3: Zero OPRF seed from JS heap after use
      if (oprfSeed) memzero(oprfSeed);
    }
  });

  // ─── PUT /svr/backup — Store encrypted backup blobs ───────────────────────
  app.put("/svr/backup", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.svrEnabled) {
      return reply.status(503).send({ error: "SVR is currently disabled." });
    }

    try {
      const user = verifyAccessToken(req.headers.authorization);
      const parsed = BackupSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
      }

      const backup = await getSvrBackup(pool, user.sub);
      if (!backup) {
        return reply.status(400).send({ error: "Must call /svr/backup/evaluate first" });
      }

      const encMasterKey = Buffer.from(parsed.data.encrypted_master_key, "base64");
      const encBlob = Buffer.from(parsed.data.encrypted_blob, "base64");

      // H2: Cap encrypted master key size
      if (encMasterKey.length > MAX_ENCRYPTED_MASTER_KEY_SIZE) {
        return reply.status(413).send({ error: "Encrypted master key exceeds max size" });
      }

      if (encBlob.length > config.svrMaxBlobSize) {
        return reply.status(413).send({ error: "Encrypted blob exceeds max size" });
      }

      await updateSvrBlobs(pool, user.sub, encMasterKey, encBlob, parsed.data.version);

      req.log.info({ event: "svr_backup_stored", userId: user.sub, version: parsed.data.version }, "SVR backup stored");

      return reply.status(200).send({ success: true });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error({ err }, "SVR backup store error");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── POST /svr/restore/evaluate — OPRF evaluation for restore (rate-limited)
  app.post("/svr/restore/evaluate", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.svrEnabled) {
      return reply.status(503).send({ error: "SVR is currently disabled." });
    }

    let oprfSeed: Uint8Array | null = null;
    try {
      const user = verifyAccessToken(req.headers.authorization);
      const parsed = EvaluateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
      }

      const backup = await getSvrBackup(pool, user.sub);
      if (!backup || backup.encryptedBlob.length === 0) {
        return reply.status(404).send({ error: "No SVR backup found" });
      }

      // C2 fix: Atomic lock-check + increment in a single SQL statement.
      // No separate isLocked() call — the WHERE clause in the UPDATE
      // rejects the row if locked_until is in the future.
      const { allowed, remaining, wipe, lockedUntil } = await incrementGuessCountAndGet(pool, user.sub);
      
      if (wipe) {
        // M3: Log permanent wipe as a security event
        req.log.error({ event: "svr_wipe", userId: user.sub }, "SVR backup permanently wiped after max guesses");
        return reply.status(410).send({ error: "Maximum attempts reached. Backup has been permanently wiped." });
      }
      
      if (!allowed) {
        // M3: Log lockout
        req.log.warn({ event: "svr_lockout", userId: user.sub, lockedUntil }, "SVR restore blocked — lockout in effect");
        return reply.status(429).send({ 
          error: "Too many failed attempts. Account temporarily locked.",
          locked_until: lockedUntil ?? null
        });
      }

      oprfSeed = backup.oprfSeed;
      const blindedElement = Buffer.from(parsed.data.blinded_element, "base64");
      const evaluated = await oprfEvaluate(blindedElement, oprfSeed);

      req.log.info({ event: "svr_restore_evaluate", userId: user.sub, remaining }, "SVR restore OPRF evaluation completed");

      return reply.status(200).send({
        evaluated_element: Buffer.from(evaluated).toString("base64"),
        encrypted_master_key: Buffer.from(backup.encryptedMasterKey).toString("base64"),
        encrypted_blob: Buffer.from(backup.encryptedBlob).toString("base64"),
        remaining_guesses: remaining
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error({ err }, "SVR restore evaluate error");
      return reply.status(500).send({ error: "Internal server error" });
    } finally {
      // H3: Zero OPRF seed from JS heap after use
      if (oprfSeed) memzero(oprfSeed);
    }
  });

  // C3 fix: /svr/restore/confirm has been REMOVED.
  //
  // The guess counter no longer resets on "successful" restore because the
  // server has no way to verify that decryption actually succeeded — any
  // authenticated user could call confirm to reset the counter and get
  // unlimited guesses.
  //
  // Instead, the guess counter resets naturally when the client calls
  // PUT /svr/backup to store a new backup (which it does after restoring
  // and re-generating keys). This is the only server-verifiable proof
  // that the client recovered the material.

  // ─── DELETE /svr/backup — User-initiated wipe ─────────────────────────────
  app.delete("/svr/backup", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.svrEnabled) {
      return reply.status(503).send({ error: "SVR is currently disabled." });
    }

    try {
      const user = verifyAccessToken(req.headers.authorization);
      await deleteSvrBackup(pool, user.sub);

      req.log.info({ event: "svr_backup_deleted", userId: user.sub }, "SVR backup deleted by user");

      return reply.status(200).send({ success: true });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.status).send({ error: err.message });
      }
      req.log.error({ err }, "SVR backup delete error");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
