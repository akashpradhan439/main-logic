# Table: `expired_tokens`

JWT blocklist (deny list). When a user logs out or a token is explicitly revoked, its hash is inserted here. The auth middleware checks this table on every request to reject tokens that have been invalidated before their natural expiry.

RLS: **enabled** — policy: `service_role` only (all operations).

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `token_hash` | `text` | NO | — | SHA-256 (or similar) hash of the raw JWT string. Primary key. Hashing avoids storing the token itself. |
| `user_id` | `uuid` | NO | — | The user who owned the token. References `users.id`. Cascade-deleted with the user. |
| `expired_at` | `timestamptz` | NO | `now()` | The token's original expiry time. Used to prune old rows — entries can be deleted once `expired_at < now()` since the token would be invalid anyway. |
| `created_at` | `timestamptz` | NO | `now()` | When the revocation was recorded. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `expired_tokens_pkey` | PRIMARY KEY | `token_hash` | — |
| `expired_tokens_user_id_fkey1` | FOREIGN KEY | `user_id → users.id` | CASCADE |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `expired_tokens_pkey` | UNIQUE btree `(token_hash)` | O(1) blocklist lookup on every authenticated request |
| `idx_expired_tokens_expired_at` | btree `(expired_at)` | Efficient pruning of rows past their expiry |

---

## RLS Policy

| Policy | Role | Command | Rule |
|---|---|---|---|
| `Service role only` | `service_role` | ALL | `true` (full access) |

Public/anon access is blocked. Only the backend service role (used by the API server) can read or write this table.

---

## Pruning

Rows where `expired_at < now()` are safe to delete — those tokens would be rejected by the JWT signature check even without the blocklist entry. A periodic cleanup job (not yet scheduled) should run:

```sql
DELETE FROM expired_tokens WHERE expired_at < now();
```

---

## Notes

- 360 rows currently, all from active logout events.
- The blocklist is checked via the `shared/auth.ts` middleware before any route handler runs.
