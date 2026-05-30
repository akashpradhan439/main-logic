-- C2/H5: Archive signed prekeys (classical + PQ) by (user_id, prekey_id, is_pq)
-- instead of overwriting the single current SPK in user_prekeys. Rotating an SPK
-- previously destroyed the only server record of the prior key, which — combined
-- with a client that also dropped the matching private key — permanently broke
-- any in-flight handshake that named the old signed_prekey_id. Keeping a bounded
-- archive lets a responder resolve the historic SPK referenced in a bootstrap.

CREATE TABLE IF NOT EXISTS signed_prekeys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prekey_id   integer NOT NULL,
  is_pq       boolean NOT NULL DEFAULT false, -- false: X25519 SPK, true: ML-KEM PQ-SPK
  public_key  text NOT NULL,                  -- Base64
  signature   text NOT NULL,                  -- Ed25519 signature of public_key by IK
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prekey_id, is_pq)
);

CREATE INDEX IF NOT EXISTS idx_signed_prekeys_lookup
  ON signed_prekeys (user_id, is_pq, prekey_id);

-- Backfill the archive with the current SPK and PQ-SPK already stored inline on
-- user_prekeys so existing users keep working without a re-upload.
INSERT INTO signed_prekeys (user_id, prekey_id, is_pq, public_key, signature)
SELECT user_id, COALESCE(signed_prekey_id, 1), false, signed_prekey_public, signature
FROM   user_prekeys
WHERE  signed_prekey_public IS NOT NULL
ON CONFLICT (user_id, prekey_id, is_pq) DO NOTHING;

INSERT INTO signed_prekeys (user_id, prekey_id, is_pq, public_key, signature)
SELECT user_id, COALESCE(pq_signed_prekey_id, 1), true, pq_signed_prekey_public, pq_signature
FROM   user_prekeys
WHERE  pq_signed_prekey_public IS NOT NULL
  AND  COALESCE(pq_signature, '') <> ''
ON CONFLICT (user_id, prekey_id, is_pq) DO NOTHING;

-- Atomically archive a rotated SPK, update the current pointer on user_prekeys
-- (so the bundle endpoint always serves the latest), and prune to the N most
-- recent archived keys for that user/kind.
CREATE OR REPLACE FUNCTION rotate_signed_prekey(
  p_user_id    uuid,
  p_is_pq      boolean,
  p_prekey_id  integer,
  p_public_key text,
  p_signature  text,
  p_keep       integer DEFAULT 5
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO signed_prekeys (user_id, prekey_id, is_pq, public_key, signature)
  VALUES (p_user_id, p_prekey_id, p_is_pq, p_public_key, p_signature)
  ON CONFLICT (user_id, prekey_id, is_pq)
  DO UPDATE SET public_key = EXCLUDED.public_key,
                signature  = EXCLUDED.signature,
                created_at = now();

  IF p_is_pq THEN
    UPDATE user_prekeys
       SET pq_signed_prekey_public = p_public_key,
           pq_signed_prekey_id     = p_prekey_id,
           pq_signature            = p_signature,
           updated_at              = now()
     WHERE user_id = p_user_id;
  ELSE
    UPDATE user_prekeys
       SET signed_prekey_public = p_public_key,
           signed_prekey_id     = p_prekey_id,
           signature            = p_signature,
           updated_at           = now()
     WHERE user_id = p_user_id;
  END IF;

  DELETE FROM signed_prekeys s
   WHERE s.user_id = p_user_id
     AND s.is_pq   = p_is_pq
     AND s.id NOT IN (
       SELECT id FROM signed_prekeys
        WHERE user_id = p_user_id AND is_pq = p_is_pq
        ORDER BY created_at DESC, prekey_id DESC
        LIMIT p_keep
     );
END;
$$;

COMMENT ON TABLE signed_prekeys IS 'Bounded archive of rotated signed prekeys so responders can resolve a historic SPK referenced in a handshake bootstrap.';
