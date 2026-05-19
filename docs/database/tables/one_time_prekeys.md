# Table: `one_time_prekeys`

Pool of single-use pre-keys for Signal Protocol (X25519) and post-quantum (ML-KEM-768) key agreement. Each key is consumed atomically during a PQXDH session initiation; once used it is never returned again.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | `uuid` | NO | — | Owner of this pre-key. References `users.id`. Cascade-deleted with the user. |
| `key_public` | `text` | NO | — | Base64-encoded public key. X25519 when `is_pq = false`; ML-KEM-768 when `is_pq = true`. |
| `is_pq` | `boolean` | NO | `false` | `false` = classical X25519 OTP; `true` = post-quantum ML-KEM OTP. |
| `used_at` | `timestamptz` | YES | `NULL` | Set to `now()` when consumed. `NULL` means available. |
| `created_at` | `timestamptz` | NO | `now()` | Upload timestamp. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `one_time_prekeys_pkey` | PRIMARY KEY | `id` | — |
| `one_time_prekeys_user_id_fkey` | FOREIGN KEY | `user_id → users.id` | CASCADE |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `one_time_prekeys_pkey` | UNIQUE btree `(id)` | PK lookup |
| `idx_otp_unused` | btree `(user_id, is_pq)` WHERE `used_at IS NULL` | Partial index — fast scan for available OTPs only |

The `idx_otp_unused` partial index is critical for performance: it only indexes rows where `used_at IS NULL`, keeping it small as keys are consumed over time.

---

## Atomic Consumption

Keys are consumed via the `consume_one_time_prekey` stored function (see [functions.md](../functions.md)) using `SELECT ... FOR UPDATE SKIP LOCKED`. This prevents two concurrent session initiations from consuming the same key.

```sql
-- Called from getPrekeyBundle() in lib/keys.ts
SELECT * FROM consume_one_time_prekey(p_user_id := $1, p_is_pq := $2);
```

The returned `key_public` is included in the bundle sent to the initiator and must be stored as `usedOTPPublicKey` / `usedPQOTPPublicKey` in `messages.bootstrap_json`.

---

## Key Pool Management

- Keys are uploaded in bulk via `POST /keys/upload` (array fields `oneTimePreKeys`, `pqOneTimePreKeys`).
- The bundle fetch response includes `remainingOtpCount` so clients know when to replenish.
- Once `used_at` is set, the row is retained indefinitely (no scheduled cleanup yet). It serves as an audit trail of which keys were consumed.

---

## Notes

- Both classical and PQ OTPs are stored in the same table, distinguished by `is_pq`.
- The `remainingOtpCount` returned by the bundle endpoint counts only classical (`is_pq = false`) unused keys. Clients should maintain a threshold and upload more before the pool is exhausted to ensure forward secrecy for every session.
