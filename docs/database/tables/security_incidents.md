# Table: `security_incidents`

Immutable audit log for security-relevant authentication events: repeated login failures, suspicious token use, unusual IP activity, etc. Written by the auth layer; never mutated after insert.

RLS: **enabled** — policy: `service_role` only (all operations).

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | `uuid` | NO | — | The user involved in the incident. References `auth.users.id` (Supabase managed auth table, not `public.users`). Cascade-deleted when the auth user is removed. |
| `incident_type` | `text` | NO | — | Machine-readable label for the event category (e.g. `invalid_token`, `rate_limit_exceeded`, `suspicious_ip`). No CHECK constraint — extensible by the application. |
| `token_hash` | `text` | YES | — | Hash of the token involved, if applicable. |
| `ip_address` | `text` | YES | — | Client IP at the time of the incident. |
| `user_agent` | `text` | YES | — | HTTP User-Agent header. |
| `metadata` | `jsonb` | YES | — | Arbitrary additional context (e.g. attempt counts, geo data, device fingerprint). Schema is free-form. |
| `created_at` | `timestamptz` | NO | `now()` | When the incident was recorded. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `security_incidents_pkey` | PRIMARY KEY | `id` | — |
| `security_incidents_user_id_fkey` | FOREIGN KEY | `user_id → auth.users.id` | CASCADE |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `security_incidents_pkey` | UNIQUE btree `(id)` | PK lookup |
| `idx_security_incidents_user_id` | btree `(user_id)` | All incidents for a specific user |
| `idx_security_incidents_type` | btree `(incident_type)` | Filter by incident category (e.g. count brute-force attempts) |
| `idx_security_incidents_created_at` | btree `(created_at DESC)` | Time-range scans (recent incidents dashboard) |

---

## RLS Policy

| Policy | Role | Command | Rule |
|---|---|---|---|
| `Service role only` | `service_role` | ALL | `true` (full access) |

Only the backend service role can access this table.

---

## Notes

- `user_id` references `auth.users.id` (Supabase's built-in auth schema), not `public.users.id`. This is intentional — security incidents may be recorded even before a `public.users` row exists (e.g. failed login before account completion).
- 0 rows currently — no incidents have been triggered in the test environment.
- This table should be treated as append-only. Do not update or delete rows outside of automated cascade deletes.
