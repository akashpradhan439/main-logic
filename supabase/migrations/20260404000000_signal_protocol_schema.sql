-- Table for user Identity Keys and Signed Prekeys (KDS)
CREATE TABLE IF NOT EXISTS user_prekeys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  identity_key_public text NOT NULL, -- Base64
  signed_prekey_public text NOT NULL, -- Base64
  pq_signed_prekey_public text NOT NULL, -- Base64
  signature text NOT NULL, -- Ed25519 signature of the SPK by the IK
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Table for One-Time Prekeys (OPKs)
CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_public text NOT NULL, -- Base64
  is_pq boolean NOT NULL DEFAULT false, -- True if this is a PQOPK (ML-KEM)
  used_at timestamptz, -- NULL if available, timestamp if used
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fetching unused OPKs
CREATE INDEX IF NOT EXISTS idx_otp_unused ON one_time_prekeys (user_id, is_pq) 
WHERE used_at IS NULL;

-- Update messages table for E2EE metadata
-- Since the user said "overhaul", we can augment the existing table or recreate it.
-- We'll add nullable columns for E2EE metadata to maintain compatibility during migration if needed, 
-- but strictly focus on 1:1 E2EE.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ephemeral_key text; -- Base64 (X25519/ML-KEM ephemeral)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ratchet_index integer; -- Double Ratchet message index
ALTER TABLE messages ADD COLUMN IF NOT EXISTS previous_ratchet_index integer; -- For skipped messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS header_mac text; -- AES-SIV tag for header protection if stored separately

-- Type for message encryption status
-- "none" (legacy), "signal" (Double Ratchet)
DO $$ BEGIN
    CREATE TYPE encryption_type AS ENUM ('none', 'signal');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS encryption_type encryption_type DEFAULT 'none';

-- Add a column for the E2EE envelope (header + ciphertext) if we want to store it as a single blob
-- For now, we'll use 'content' for the ciphertext and the above columns for the header.
