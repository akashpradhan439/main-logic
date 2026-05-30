-- H1: One-time prekeys need a stable client-assigned integer id so the bootstrap
-- envelope can reference exactly which OPK was consumed (previously the bootstrap
-- carried the full public key only in a JSON sidecar, never in the binary proto).
ALTER TABLE one_time_prekeys
  ADD COLUMN IF NOT EXISTS prekey_id integer;

-- A client's OPK ids are unique within (user, kind). Partial-unique to tolerate
-- legacy NULL rows uploaded before this column existed.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_otp_prekey_id
  ON one_time_prekeys (user_id, is_pq, prekey_id)
  WHERE prekey_id IS NOT NULL;

-- Re-create the dual consume to also surface the prekey_id. The prior definition
-- (migration 20260528) returns a 3-column TABLE; adding a column changes the
-- function's OUT signature, which CREATE OR REPLACE cannot do — Postgres raises
-- "cannot change return type of existing function". Drop it first so this runs
-- cleanly whether or not 20260528 was already applied.
DROP FUNCTION IF EXISTS consume_prekeys_atomic(uuid);
CREATE OR REPLACE FUNCTION consume_prekeys_atomic(p_user_id uuid)
RETURNS TABLE(id uuid, key_public text, is_pq boolean, prekey_id integer) LANGUAGE sql AS $$
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
    RETURNING id, key_public, is_pq, prekey_id
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
    RETURNING id, key_public, is_pq, prekey_id
  )
  SELECT id, key_public, is_pq, prekey_id FROM classical
  UNION ALL
  SELECT id, key_public, is_pq, prekey_id FROM pq;
$$;
