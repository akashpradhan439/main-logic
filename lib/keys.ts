import { SupabaseClient } from "@supabase/supabase-js";

export interface PrekeyBundle {
  userId: string;
  identityKey: string;
  signedPrekey: string;
  pqSignedPrekey: string;
  signature: string;
  pqSignature?: string;
  oneTimePrekey?: string;
  pqOneTimePrekey?: string;
}

export async function uploadPrekeys(
  supabase: SupabaseClient,
  userId: string,
  bundle: {
    identityKey: string;
    signedPrekey: string;
    pqSignedPrekey: string;
    signature: string;
    pqSignature?: string;
  },
  oneTimePrekeys: { key: string; isPq: boolean }[]
) {
  // 1. Upload/Update user prekeys
  const { error: prekeyError } = await supabase
    .from("user_prekeys")
    .upsert({
      user_id: userId,
      identity_key_public: bundle.identityKey,
      signed_prekey_public: bundle.signedPrekey,
      pq_signed_prekey_public: bundle.pqSignedPrekey,
      signature: bundle.signature,
      pq_signature: bundle.pqSignature,
      updated_at: new Date().toISOString(),
    });

  if (prekeyError) return { error: prekeyError };

  // 2. Upload one-time prekeys
  if (oneTimePrekeys.length > 0) {
    const { error: otpError } = await supabase
      .from("one_time_prekeys")
      .insert(
        oneTimePrekeys.map((p) => ({
          user_id: userId,
          key_public: p.key,
          is_pq: p.isPq,
        }))
      );
    if (otpError) return { error: otpError };
  }

  return { error: null };
}

export async function getPrekeyBundle(
  supabase: SupabaseClient,
  userId: string
): Promise<{ bundle: PrekeyBundle | null; error: any }> {
  // 1. Fetch user prekeys
  const { data: userPrekeys, error: prekeyError } = await supabase
    .from("user_prekeys")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (prekeyError || !userPrekeys) {
    return { bundle: null, error: prekeyError || new Error("Prekeys not found") };
  }

  // 2. Fetch one classical OPK
  const { data: opk, error: opkError } = await supabase
    .from("one_time_prekeys")
    .select("id, key_public")
    .eq("user_id", userId)
    .eq("is_pq", false)
    .is("used_at", null)
    .limit(1)
    .maybeSingle();

  // 3. Fetch one PQ OPK
  const { data: pqOpk, error: pqOpkError } = await supabase
    .from("one_time_prekeys")
    .select("id, key_public")
    .eq("user_id", userId)
    .eq("is_pq", true)
    .is("used_at", null)
    .limit(1)
    .maybeSingle();

  // 4. Mark OPKs as used (atomic if possible, but for simplicity here we just update)
  if (opk) {
    await supabase.from("one_time_prekeys").update({ used_at: new Date().toISOString() }).eq("id", opk.id);
  }
  if (pqOpk) {
    await supabase.from("one_time_prekeys").update({ used_at: new Date().toISOString() }).eq("id", pqOpk.id);
  }

  return {
    bundle: {
      userId,
      identityKey: userPrekeys.identity_key_public,
      signedPrekey: userPrekeys.signed_prekey_public,
      pqSignedPrekey: userPrekeys.pq_signed_prekey_public,
      signature: userPrekeys.signature,
      pqSignature: userPrekeys.pq_signature,
      oneTimePrekey: opk?.key_public,
      pqOneTimePrekey: pqOpk?.key_public,
    },
    error: null,
  };
}
