ALTER TABLE user_prekeys ADD COLUMN IF NOT EXISTS pq_signature text; -- Base64 encoded Ed25519 signature
