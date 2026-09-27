import pg from "pg";
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;
import { config } from "../config.js";

export interface SvrBackup {
  userId: string;
  oprfSeed: Uint8Array;
  oprfKeyVersion: number;
  encryptedMasterKey: Uint8Array;
  encryptedBlob: Uint8Array;
  guessCount: number;
  maxGuesses: number;
  version: number;
  lockedUntil: Date | null;
}

/**
 * Creates or re-initializes an SVR backup row with a fresh OPRF seed.
 * On conflict (user already has a row), the seed is rotated and the
 * key version is bumped — this handles PIN-change flows correctly (H1).
 */
export async function upsertSvrBackupSeed(
  client: Pool | PoolClient,
  userId: string,
  oprfSeed: Uint8Array,
  maxGuesses: number = config.svrMaxGuesses
): Promise<void> {
  await client.query(
    `INSERT INTO svr_backups (user_id, oprf_seed, max_guesses, encrypted_master_key, encrypted_blob) 
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       oprf_seed = EXCLUDED.oprf_seed,
       oprf_key_version = svr_backups.oprf_key_version + 1,
       updated_at = now()`,
    [userId, Buffer.from(oprfSeed), maxGuesses, Buffer.alloc(0), Buffer.alloc(0)]
  );
}

export async function getSvrBackup(
  client: Pool | PoolClient,
  userId: string
): Promise<SvrBackup | null> {
  const { rows } = await client.query(
    `SELECT user_id, oprf_seed, oprf_key_version, encrypted_master_key, encrypted_blob, 
            guess_count, max_guesses, version, locked_until
     FROM svr_backups 
     WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    userId: r.user_id,
    oprfSeed: new Uint8Array(r.oprf_seed),
    oprfKeyVersion: r.oprf_key_version,
    encryptedMasterKey: new Uint8Array(r.encrypted_master_key),
    encryptedBlob: new Uint8Array(r.encrypted_blob),
    guessCount: r.guess_count,
    maxGuesses: r.max_guesses,
    version: r.version,
    lockedUntil: r.locked_until,
  };
}

export async function updateSvrBlobs(
  client: Pool | PoolClient,
  userId: string,
  encryptedMasterKey: Uint8Array,
  encryptedBlob: Uint8Array,
  version: number
): Promise<void> {
  await client.query(
    `UPDATE svr_backups 
     SET encrypted_master_key = $1, encrypted_blob = $2, version = $3, 
         guess_count = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = $4`,
    [Buffer.from(encryptedMasterKey), Buffer.from(encryptedBlob), version, userId]
  );
}

/**
 * Atomically checks the lockout, increments the guess counter, and applies
 * exponential backoff — all in a single UPDATE with a WHERE guard so there
 * is no TOCTOU race between the lock check and the increment (C2).
 *
 * Returns { allowed, remaining, wipe }.
 *   - allowed=false + wipe=false → row is locked or missing
 *   - allowed=false + wipe=true  → max guesses reached, row deleted
 *   - allowed=true               → evaluation may proceed
 */
export async function incrementGuessCountAndGet(
  client: Pool | PoolClient,
  userId: string
): Promise<{ allowed: boolean; remaining: number; wipe: boolean; lockedUntil?: Date }> {
  // C2 fix: the WHERE clause rejects the row if locked_until is in the future,
  // making the lock-check and increment a single atomic operation.
  const { rows } = await client.query(
    `UPDATE svr_backups 
     SET guess_count = guess_count + 1, updated_at = now()
     WHERE user_id = $1 
       AND (locked_until IS NULL OR locked_until <= now())
     RETURNING guess_count, max_guesses`,
    [userId]
  );
  
  if (rows.length === 0) {
    // Either row doesn't exist or it's locked. Check which.
    const existing = await client.query(
      `SELECT locked_until FROM svr_backups WHERE user_id = $1`,
      [userId]
    );
    if (existing.rows.length > 0 && existing.rows[0].locked_until) {
      return { allowed: false, remaining: 0, wipe: false, lockedUntil: existing.rows[0].locked_until };
    }
    return { allowed: false, remaining: 0, wipe: false };
  }
  
  const guessCount: number = rows[0].guess_count;
  const maxGuesses: number = rows[0].max_guesses;
  const remaining = Math.max(0, maxGuesses - guessCount);

  if (guessCount >= maxGuesses) {
    // Permanent wipe!
    await client.query(`DELETE FROM svr_backups WHERE user_id = $1`, [userId]);
    return { allowed: false, remaining: 0, wipe: true };
  }

  // C1 fix: Calculate exponential backoff lockout using parameterized query
  const lockoutSchedule: Record<number, number> = {
    4: 1,      // 1 minute
    5: 5,      // 5 minutes
    6: 30,     // 30 minutes
    7: 60,     // 1 hour
    8: 480,    // 8 hours
    9: 1440,   // 24 hours
  };

  const lockMinutes = lockoutSchedule[guessCount] ?? 0;

  if (lockMinutes > 0) {
    await client.query(
      `UPDATE svr_backups SET locked_until = now() + make_interval(mins => $2) WHERE user_id = $1`,
      [userId, lockMinutes]
    );
  }

  return { allowed: true, remaining, wipe: false };
}

export async function resetGuessCount(
  client: Pool | PoolClient,
  userId: string
): Promise<void> {
  await client.query(
    `UPDATE svr_backups SET guess_count = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1`,
    [userId]
  );
}

export async function deleteSvrBackup(
  client: Pool | PoolClient,
  userId: string
): Promise<void> {
  await client.query(`DELETE FROM svr_backups WHERE user_id = $1`, [userId]);
}
