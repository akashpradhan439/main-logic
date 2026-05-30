-- M5: Consume the classical and PQ one-time prekeys in a single transaction so a
-- partial failure can't waste one OPK while the other is never handed out. Returns
-- at most one row per kind; either may be absent if that pool is exhausted (the
-- handshake then falls back to the SPK-only path for that side).
CREATE OR REPLACE FUNCTION consume_prekeys_atomic(p_user_id uuid)
RETURNS TABLE(id uuid, key_public text, is_pq boolean) LANGUAGE sql AS $$
  WITH classical AS (
    UPDATE one_time_prekeys
       SET used_at = now()
     WHERE id = (
       SELECT id FROM one_time_prekeys
        WHERE user_id = p_user_id AND is_pq = false AND used_at IS NULL
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, key_public, is_pq
  ),
  pq AS (
    UPDATE one_time_prekeys
       SET used_at = now()
     WHERE id = (
       SELECT id FROM one_time_prekeys
        WHERE user_id = p_user_id AND is_pq = true AND used_at IS NULL
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, key_public, is_pq
  )
  SELECT id, key_public, is_pq FROM classical
  UNION ALL
  SELECT id, key_public, is_pq FROM pq;
$$;
