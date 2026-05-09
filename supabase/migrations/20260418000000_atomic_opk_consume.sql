-- H1: Replace the two-step SELECT + UPDATE pattern with a single atomic operation
-- using FOR UPDATE SKIP LOCKED to prevent concurrent handshakes from consuming
-- the same one-time prekey.
CREATE OR REPLACE FUNCTION consume_one_time_prekey(p_user_id uuid, p_is_pq boolean)
RETURNS TABLE(id uuid, key_public text) LANGUAGE sql AS $$
  UPDATE one_time_prekeys
  SET used_at = now()
  WHERE id = (
    SELECT id
    FROM   one_time_prekeys
    WHERE  user_id  = p_user_id
      AND  is_pq    = p_is_pq
      AND  used_at IS NULL
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, key_public;
$$;
