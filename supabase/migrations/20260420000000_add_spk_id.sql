-- M3: Add signed prekey IDs so the initiator can include which SPK was used in
-- the bootstrap, and the responder can look it up after rotation.
ALTER TABLE user_prekeys
  ADD COLUMN IF NOT EXISTS signed_prekey_id    integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pq_signed_prekey_id integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN user_prekeys.signed_prekey_id    IS 'Monotonically increasing ID incremented on each SPK rotation.';
COMMENT ON COLUMN user_prekeys.pq_signed_prekey_id IS 'Monotonically increasing ID incremented on each PQ SPK rotation.';
