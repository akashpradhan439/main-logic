-- Add pq_signature column to user_prekeys table
ALTER TABLE user_prekeys ADD COLUMN IF NOT EXISTS pq_signature text;

-- Update comment
COMMENT ON COLUMN user_prekeys.signature IS 'Ed25519 signature of the classical SPK by the IK';
COMMENT ON COLUMN user_prekeys.pq_signature IS 'Ed25519 signature of the PQ SPK by the IK';
