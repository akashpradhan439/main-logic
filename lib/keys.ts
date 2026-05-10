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
  pqOneTimePrekey?:  string;
  remainingOtpCount: number;
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
  oneTimePrekeys:   string[],
  pqOneTimePreKeys: string[]
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

  const allOTPs = [
    ...oneTimePrekeys.map(key  => ({ user_id: userId, key_public: key, is_pq: false })),
    ...pqOneTimePreKeys.map(key => ({ user_id: userId, key_public: key, is_pq: true  })),
  ];

  if (allOTPs.length > 0) {
    const { error: otpError } = await supabase.from("one_time_prekeys").insert(allOTPs);
    if (otpError) return { error: otpError };
  }

  return { error: null };
}

// Atomically marks one unused OPK as used and returns it, avoiding double-use races.
async function consumeOneTimePrekey(
  supabase: SupabaseClient,
  userId: string,
  isPq: boolean
): Promise<{ id: string; key_public: string } | null> {
  const { data, error } = await (supabase as any).rpc("consume_one_time_prekey", {
    p_user_id: userId,
    p_is_pq:   isPq,
  });
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as { id: string; key_public: string };
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

  const [opk, pqOpk] = await Promise.all([
    consumeOneTimePrekey(supabase, userId, false),
    consumeOneTimePrekey(supabase, userId, true),
  ]);

  const { count: remainingOtpCount } = await supabase
    .from("one_time_prekeys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_pq", false)
    .is("used_at", null);

  return {
    bundle: {
      userId,
      identityKey:        userPrekeys.identity_key_public,
      identitySigningKey: userPrekeys.identity_signing_key_public,
      signedPrekey:       userPrekeys.signed_prekey_public,
      signedPrekeyId:    userPrekeys.signed_prekey_id ?? 1,
      pqSignedPrekey:    userPrekeys.pq_signed_prekey_public,
      pqSignedPrekeyId:  userPrekeys.pq_signed_prekey_id ?? 1,
      signature:         userPrekeys.signature,
      pqSignature:       userPrekeys.pq_signature,
      oneTimePrekey:     opk?.key_public,
      pqOneTimePrekey:   pqOpk?.key_public,
      remainingOtpCount: remainingOtpCount ?? 0,
    },
    error: null,
  };
}
