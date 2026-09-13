import pg from "pg";
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;

export interface PrekeyBundle {
  userId:            string;
  identityKey:       string;
  identitySigningKey: string;
  signedPrekey:      string;
  signedPrekeyId:    number;
  pqSignedPrekey:    string;
  pqSignedPrekeyId:  number;
  signature:         string;
  pqSignature:       string;
  oneTimePrekey?:    string;
  oneTimePrekeyId?:  number;
  pqOneTimePrekey?:  string;
  pqOneTimePrekeyId?: number;
  remainingOtpCount:   number;
  remainingPqOtpCount: number;
}

export type OneTimePrekeyInput = string | { keyId: number; publicKey: string };

function normalizeOtp(input: OneTimePrekeyInput): { keyId: number | null; publicKey: string } {
  if (typeof input === "string") return { keyId: null, publicKey: input };
  return { keyId: input.keyId, publicKey: input.publicKey };
}

export async function uploadPrekeys(
  client: Pool | PoolClient,
  userId: string,
  bundle: {
    identityKey:       string;
    identitySigningKey: string;
    signedPrekey:      string;
    signedPrekeyId:   number;
    pqSignedPrekey:   string;
    pqSignedPrekeyId: number;
    signature:        string;
    pqSignature:      string;
  },
  oneTimePrekeys:   OneTimePrekeyInput[],
  pqOneTimePreKeys: OneTimePrekeyInput[]
) {
  try {
    await client.query(
      `INSERT INTO user_prekeys (
        user_id, identity_key_public, identity_signing_key_public,
        signed_prekey_public, signed_prekey_id, pq_signed_prekey_public,
        pq_signed_prekey_id, signature, pq_signature, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id) DO UPDATE SET
        identity_key_public = EXCLUDED.identity_key_public,
        identity_signing_key_public = EXCLUDED.identity_signing_key_public,
        signed_prekey_public = EXCLUDED.signed_prekey_public,
        signed_prekey_id = EXCLUDED.signed_prekey_id,
        pq_signed_prekey_public = EXCLUDED.pq_signed_prekey_public,
        pq_signed_prekey_id = EXCLUDED.pq_signed_prekey_id,
        signature = EXCLUDED.signature,
        pq_signature = EXCLUDED.pq_signature,
        updated_at = EXCLUDED.updated_at`,
      [
        userId,
        bundle.identityKey,
        bundle.identitySigningKey,
        bundle.signedPrekey,
        bundle.signedPrekeyId,
        bundle.pqSignedPrekey,
        bundle.pqSignedPrekeyId,
        bundle.signature,
        bundle.pqSignature,
        new Date().toISOString(),
      ]
    );

    // C2: seed the signed-prekey archive
    const archiveValues = [
      { user_id: userId, prekey_id: bundle.signedPrekeyId,   is_pq: false, public_key: bundle.signedPrekey,   signature: bundle.signature },
      { user_id: userId, prekey_id: bundle.pqSignedPrekeyId, is_pq: true,  public_key: bundle.pqSignedPrekey, signature: bundle.pqSignature },
    ];

    for (const row of archiveValues) {
      await client.query(
        `INSERT INTO signed_prekeys (user_id, prekey_id, is_pq, public_key, signature)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, prekey_id, is_pq) DO UPDATE SET
           public_key = EXCLUDED.public_key,
           signature = EXCLUDED.signature`,
        [row.user_id, row.prekey_id, row.is_pq, row.public_key, row.signature]
      );
    }

    const allOTPs = [
      ...oneTimePrekeys.map((k) => {
        const { keyId, publicKey } = normalizeOtp(k);
        return { user_id: userId, key_public: publicKey, prekey_id: keyId, is_pq: false };
      }),
      ...pqOneTimePreKeys.map((k) => {
        const { keyId, publicKey } = normalizeOtp(k);
        return { user_id: userId, key_public: publicKey, prekey_id: keyId, is_pq: true };
      }),
    ];

    if (allOTPs.length > 0) {
      const params: any[] = [];
      const valueClauses: string[] = [];
      allOTPs.forEach((otp, i) => {
        const base = i * 4;
        valueClauses.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
        params.push(otp.user_id, otp.key_public, otp.prekey_id, otp.is_pq);
      });
      await client.query(
        `INSERT INTO one_time_prekeys (user_id, key_public, prekey_id, is_pq) VALUES ${valueClauses.join(",")}`,
        params
      );
    }
  } catch (error) {
    return { error };
  }

  return { error: null };
}

interface ConsumedOpk {
  id: string;
  key_public: string;
  is_pq: boolean;
  prekey_id: number | null;
}

async function consumePrekeysAtomic(
  client: Pool | PoolClient,
  userId: string
): Promise<{ classical: ConsumedOpk | null; pq: ConsumedOpk | null }> {
  try {
    const { rows } = await client.query("SELECT * FROM consume_prekeys_atomic($1)", [userId]);
    if (!Array.isArray(rows) || rows.length === 0) return { classical: null, pq: null };
    return {
      classical: rows.find((r: ConsumedOpk) => r.is_pq === false) ?? null,
      pq:        rows.find((r: ConsumedOpk) => r.is_pq === true) ?? null,
    };
  } catch {
    return { classical: null, pq: null };
  }
}

export async function getSignedPrekeyById(
  client: Pool | PoolClient,
  userId: string,
  prekeyId: number,
  isPq: boolean
): Promise<{ publicKey: string; signature: string } | null> {
  try {
    const { rows } = await client.query(
      "SELECT public_key, signature FROM signed_prekeys WHERE user_id = $1 AND is_pq = $2 AND prekey_id = $3",
      [userId, isPq, prekeyId]
    );
    if (rows.length === 0) return null;
    return { publicKey: rows[0].public_key, signature: rows[0].signature };
  } catch {
    return null;
  }
}

export async function rotateSignedPrekey(
  client: Pool | PoolClient,
  userId: string,
  params: { prekeyId: number; publicKey: string; signature: string; isPq: boolean }
): Promise<{ error: any }> {
  try {
    await client.query(
      "SELECT * FROM rotate_signed_prekey($1, $2, $3, $4, $5)",
      [userId, params.isPq, params.prekeyId, params.publicKey, params.signature]
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
}

export async function getOpkStatus(
  client: Pool | PoolClient,
  userId: string
): Promise<{ classical: number; pq: number; error: any }> {
  try {
    const [classicalRes, pqRes] = await Promise.all([
      client.query(
        "SELECT COUNT(*)::int as count FROM one_time_prekeys WHERE user_id = $1 AND is_pq = false AND used_at IS NULL",
        [userId]
      ),
      client.query(
        "SELECT COUNT(*)::int as count FROM one_time_prekeys WHERE user_id = $1 AND is_pq = true AND used_at IS NULL",
        [userId]
      ),
    ]);
    return {
      classical: classicalRes.rows[0]?.count ?? 0,
      pq: pqRes.rows[0]?.count ?? 0,
      error: null,
    };
  } catch (error) {
    return { classical: 0, pq: 0, error };
  }
}

export async function usersWithUsableBundles(
  client: Pool | PoolClient,
  userIds: string[]
): Promise<Set<string>> {
  const ready = new Set<string>();
  if (userIds.length === 0) return ready;

  try {
    const { rows } = await client.query(
      "SELECT user_id, identity_key_public, pq_signature FROM user_prekeys WHERE user_id = ANY($1)",
      [userIds]
    );
    for (const row of rows) {
      if (row.identity_key_public && row.pq_signature && row.pq_signature !== "") {
        ready.add(row.user_id);
      }
    }
  } catch {
    // return empty set on error
  }
  return ready;
}

export async function getPrekeyBundle(
  client: Pool | PoolClient,
  userId: string
): Promise<{ bundle: PrekeyBundle | null; error: any; opkPoolLow: boolean }> {
  let userPrekeys: any;
  try {
    const { rows } = await client.query(
      "SELECT * FROM user_prekeys WHERE user_id = $1",
      [userId]
    );
    userPrekeys = rows[0];
  } catch (error) {
    return { bundle: null, error, opkPoolLow: false };
  }

  if (!userPrekeys) {
    return { bundle: null, error: new Error("Prekeys not found"), opkPoolLow: false };
  }

  if (!userPrekeys.pq_signature || userPrekeys.pq_signature === "") {
    return { bundle: null, error: new Error("PREKEY_BUNDLE_STALE: user must re-upload prekeys"), opkPoolLow: false };
  }

  const { classical: opk, pq: pqOpk } = await consumePrekeysAtomic(client, userId);

  const [classicalRes, pqRes] = await Promise.all([
    client.query(
      "SELECT COUNT(*)::int as count FROM one_time_prekeys WHERE user_id = $1 AND is_pq = false AND used_at IS NULL",
      [userId]
    ),
    client.query(
      "SELECT COUNT(*)::int as count FROM one_time_prekeys WHERE user_id = $1 AND is_pq = true AND used_at IS NULL",
      [userId]
    ),
  ]);

  const remainingOtpCount = classicalRes.rows[0]?.count ?? 0;
  const remainingPqOtpCount = pqRes.rows[0]?.count ?? 0;

  return {
    bundle: {
      userId,
      identityKey:        userPrekeys.identity_key_public,
      identitySigningKey: userPrekeys.identity_signing_key_public,
      signedPrekey:       userPrekeys.signed_prekey_public,
      signedPrekeyId:     userPrekeys.signed_prekey_id ?? 1,
      pqSignedPrekey:     userPrekeys.pq_signed_prekey_public,
      pqSignedPrekeyId:   userPrekeys.pq_signed_prekey_id ?? 1,
      signature:          userPrekeys.signature,
      pqSignature:        userPrekeys.pq_signature,
      ...(opk   ? { oneTimePrekey:   opk.key_public,   ...(opk.prekey_id != null   ? { oneTimePrekeyId:   opk.prekey_id }   : {}) } : {}),
      ...(pqOpk ? { pqOneTimePrekey: pqOpk.key_public, ...(pqOpk.prekey_id != null ? { pqOneTimePrekeyId: pqOpk.prekey_id } : {}) } : {}),
      remainingOtpCount,
      remainingPqOtpCount,
    },
    error: null,
    opkPoolLow: remainingOtpCount < 5 || remainingPqOtpCount < 5,
  };
}
