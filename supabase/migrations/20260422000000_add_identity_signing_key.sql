-- Add Ed25519 identity signing key; used by the client to verify SPK signatures.
ALTER TABLE user_prekeys
  ADD COLUMN IF NOT EXISTS identity_signing_key_public text;

COMMENT ON COLUMN user_prekeys.identity_signing_key_public IS 'Ed25519 public key used to verify SPK and PQ-SPK signatures. Separate from the X25519 identity_key_public used for DH.';
