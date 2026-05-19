# Stored Functions

All functions live in the `public` schema and are callable via Supabase RPC (`supabase.rpc(...)`).

---

## `consume_one_time_prekey`

**Type:** `FUNCTION` → returns `SETOF record (id uuid, key_public text)`

Atomically marks exactly one unused one-time pre-key as consumed and returns it. Uses `SELECT ... FOR UPDATE SKIP LOCKED` to prevent two concurrent callers from consuming the same key (race-condition safe).

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `p_user_id` | `uuid` | The user whose OTP pool to draw from. |
| `p_is_pq` | `boolean` | `false` = classical X25519 OTP; `true` = ML-KEM-768 OTP. |

### Returns

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | The `one_time_prekeys.id` of the consumed key. |
| `key_public` | `text` | The base64 public key. Included in the prekey bundle sent to the initiator. |

Returns an empty set if no unused key is available for the given `(user_id, is_pq)` combination.

### SQL Definition

```sql
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
```

### Called From

`lib/keys.ts` → `getPrekeyBundle()` — called twice concurrently (once for classical, once for PQ) via `Promise.all`.

### Notes

- `FOR UPDATE SKIP LOCKED` skips rows that are currently locked by another transaction, preventing double-consumption under concurrent load.
- Keys are consumed in `created_at` ascending order (oldest first) to ensure FIFO consumption, which is the correct Signal Protocol behaviour.
- The consumed key's `key_public` must be recorded in `messages.bootstrap_json` as `usedOTPPublicKey` or `usedPQOTPPublicKey` so the responder can identify which OTP was used.

---

## `check_connection_in_h3`

**Type:** `FUNCTION` → returns `SETOF record (matched_user_id uuid, h3_cell text)`

Given a user ID and an array of H3 cell indices, returns all accepted-connection peers of that user who are currently located within any of those cells.

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `uid` | `uuid` | The querying user's ID. |
| `h3_cells` | `text[]` | Array of H3 cell indices to check against. |

### Returns

| Column | Type | Description |
|---|---|---|
| `matched_user_id` | `uuid` | The connected peer's `users.id`. |
| `h3_cell` | `text` | The H3 cell where that peer is currently located. |

### SQL Definition

```sql
SELECT
  u.id    AS matched_user_id,
  u.h3_cell
FROM public.connections c
JOIN public.users u
  ON (
    CASE
      WHEN c.requester_id = uid THEN c.addressee_id
      ELSE c.requester_id
    END = u.id
  )
WHERE
  c.status = 'accepted'
  AND (c.requester_id = uid OR c.addressee_id = uid)
  AND u.h3_cell = ANY(h3_cells);
```

### Called From

`workers/locationUpdatedWorker.ts` — after a user's location updates, the worker calls this function with the user's H3 disk (center cell + neighbors) to find connected users who are in proximity.

### Notes

- Only returns peers with `connections.status = 'accepted'`. Blocked or pending connections are excluded.
- The CASE expression resolves the "other" user ID regardless of whether the querying user is `requester_id` or `addressee_id`.
- The H3 disk passed in should be the same `h3_neighbors` array stored on `users.h3_neighbors` after each location update.
