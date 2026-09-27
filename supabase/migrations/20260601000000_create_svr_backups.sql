-- Table for Secure Value Recovery (SVR) backups
CREATE TABLE IF NOT EXISTS svr_backups (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  
  -- OPRF server-side secret (per-user, rotatable)
  oprf_seed        bytea        NOT NULL,       -- 32-byte random seed for OPRF key derivation
  oprf_key_version smallint     NOT NULL DEFAULT 1,
  
  -- Encrypted data (opaque to server)
  encrypted_master_key  bytea   NOT NULL,       -- masterKey encrypted with hardenedPin
  encrypted_blob        bytea   NOT NULL,       -- protobuf(privKeys + sessionState) encrypted with masterKey
  
  -- Rate limiting / brute-force protection
  guess_count      smallint     NOT NULL DEFAULT 0,
  max_guesses      smallint     NOT NULL DEFAULT 10,
  
  -- Metadata
  version          smallint     NOT NULL DEFAULT 1,  -- backup format version
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  locked_until     timestamptz  DEFAULT NULL     -- exponential backoff lockout
);

-- Index for cleanup/lockout jobs
CREATE INDEX IF NOT EXISTS idx_svr_backups_locked ON svr_backups (locked_until) 
  WHERE locked_until IS NOT NULL;
