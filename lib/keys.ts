import { SupabaseClient } from "@supabase/supabase-js";

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
  remainingOtpCount:   number; // classical OPKs remaining
  remainingPqOtpCount: number; // PQ OPKs remaining (M6)
}

// An OPK may be uploaded as a bare base64 string (legacy) or with an explicit
// client-assigned id so the bootstrap can reference exactly which key was used (H1).
export type OneTimePrekeyInput = string | { keyId: number; publicKey: string };

function normalizeOtp(input: OneTimePrekeyInput): { keyId: number | null; publicKey: string } {
  if (typeof input === "string") return { keyId: null, publicKey: input };
  return { keyId: input.keyId, publicKey: input.publicKey };
}

export async function uploadPrekeys(
  supabase: SupabaseClient,
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
  const { error: prekeyError } = await supabase
    .from("user_prekeys")
    .upsert({
      user_id:                 userId,
      identity_key_public:          bundle.identityKey,
      identity_signing_key_public:  bundle.identitySigningKey,
      signed_prekey_public:         bundle.signedPrekey,
      signed_prekey_id:        bundle.signedPrekeyId,
      pq_signed_prekey_public: bundle.pqSignedPrekey,
      pq_signed_prekey_id:     bundle.pqSignedPrekeyId,
      signature:               bundle.signature,
      pq_signature:            bundle.pqSignature,
      updated_at:              new Date().toISOString(),
    });

  if (prekeyError) return { error: prekeyError };

  // C2: seed the signed-prekey archive so historic SPKs are resolvable from the
  // very first upload (not only after a rotation).
  const { error: archiveError } = await supabase
    .from("signed_prekeys")
    .upsert(
      [
        { user_id: userId, prekey_id: bundle.signedPrekeyId,   is_pq: false, public_key: bundle.signedPrekey,   signature: bundle.signature },
        { user_id: userId, prekey_id: bundle.pqSignedPrekeyId, is_pq: true,  public_key: bundle.pqSignedPrekey, signature: bundle.pqSignature },
      ],
      { onConflict: "user_id,prekey_id,is_pq" }
    );
  if (archiveError) return { error: archiveError };

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
    const { error: otpError } = await supabase.from("one_time_prekeys").insert(allOTPs);
    if (otpError) return { error: otpError };
  }

  return { error: null };
}

interface ConsumedOpk {
  id: string;
  key_public: string;
  is_pq: boolean;
  prekey_id: number | null;
}

// M5: atomically consume one classical and one PQ OPK in a single RPC.
async function consumePrekeysAtomic(
  supabase: SupabaseClient,
  userId: string
): Promise<{ classical: ConsumedOpk | null; pq: ConsumedOpk | null }> {
  const { data, error } = await (supabase as any).rpc("consume_prekeys_atomic", {
    p_user_id: userId,
  });
  if (error || !Array.isArray(data)) return { classical: null, pq: null };
  const rows = data as ConsumedOpk[];
  return {
    classical: rows.find((r) => r.is_pq === false) ?? null,
    pq:        rows.find((r) => r.is_pq === true) ?? null,
  };
}

/** Resolve a historic signed prekey by id (C2) — e.g. the one named in a bootstrap. */
export async function getSignedPrekeyById(
  supabase: SupabaseClient,
  userId: string,
  prekeyId: number,
  isPq: boolean
): Promise<{ publicKey: string; signature: string } | null> {
  const { data, error } = await supabase
    .from("signed_prekeys")
    .select("public_key, signature")
    .eq("user_id", userId)
    .eq("is_pq", isPq)
    .eq("prekey_id", prekeyId)
    .maybeSingle();
  if (error || !data) return null;
  return { publicKey: (data as any).public_key, signature: (data as any).signature };
}

/** Rotate (and archive) a signed prekey via the atomic SQL function (C2/H5). */
export async function rotateSignedPrekey(
  supabase: SupabaseClient,
  userId: string,
  params: { prekeyId: number; publicKey: string; signature: string; isPq: boolean }
): Promise<{ error: any }> {
  const { error } = await (supabase as any).rpc("rotate_signed_prekey", {
    p_user_id:    userId,
    p_is_pq:      params.isPq,
    p_prekey_id:  params.prekeyId,
    p_public_key: params.publicKey,
    p_signature:  params.signature,
  });
  return { error };
}

/**
 * Returns the subset of the given user IDs that have a USABLE prekey bundle
 * (identity key present and a non-sentinel pq_signature). Lets the messaging API
 * report `signalReady` so clients can gate sends instead of attempting and failing
 * when the peer hasn't uploaded keys yet (#12).
 */
export async function usersWithUsableBundles(
  supabase: SupabaseClient,
  userIds: string[]
): Promise<Set<string>> {
  const ready = new Set<string>();
  if (userIds.length === 0) return ready;

  const { data, error } = await supabase
    .from("user_prekeys")
    .select("user_id, identity_key_public, pq_signature")
    .in("user_id", userIds);

  if (error || !data) return ready;
  for (const row of data as Array<{ user_id: string; identity_key_public: string | null; pq_signature: string | null }>) {
    if (row.identity_key_public && row.pq_signature && row.pq_signature !== "") {
      ready.add(row.user_id);
    }
  }
  return ready;
}

export async function getPrekeyBundle(
  supabase: SupabaseClient,
  userId: string
): Promise<{ bundle: PrekeyBundle | null; error: any }> {
  const { data: userPrekeys, error: prekeyError } = await supabase
    .from("user_prekeys")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (prekeyError || !userPrekeys) {
    return { bundle: null, error: prekeyError || new Error("Prekeys not found") };
  }

  // M7: a legacy sentinel pq_signature means the bundle is unusable; surface a
  // clear error so the caller gets a "re-upload needed" signal rather than a
  // bundle that crashes the initiator's signature verification.
  if (!userPrekeys.pq_signature || userPrekeys.pq_signature === "") {
    return { bundle: null, error: new Error("PREKEY_BUNDLE_STALE: user must re-upload prekeys") };
  }

  const { classical: opk, pq: pqOpk } = await consumePrekeysAtomic(supabase, userId);

  const [{ count: remainingOtpCount }, { count: remainingPqOtpCount }] = await Promise.all([
    supabase
      .from("one_time_prekeys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_pq", false)
      .is("used_at", null),
    supabase
      .from("one_time_prekeys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_pq", true)
      .is("used_at", null),
  ]);

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
      remainingOtpCount:   remainingOtpCount ?? 0,
      remainingPqOtpCount: remainingPqOtpCount ?? 0,
    },
    error: null,
  };
}
