-- M2: pq_signature was added without NOT NULL. Rows with NULL pq_signature cause
-- a crash in initiateHandshake when libsodium receives undefined as the signature.
-- Set a sentinel empty string for legacy rows; those users must re-upload their
-- prekey bundle to restore handshake capability.
UPDATE user_prekeys SET pq_signature = '' WHERE pq_signature IS NULL;

ALTER TABLE user_prekeys ALTER COLUMN pq_signature SET NOT NULL;

COMMENT ON COLUMN user_prekeys.pq_signature IS 'Ed25519 signature of the PQ SPK by the IK. Empty string means bundle must be re-uploaded.';
