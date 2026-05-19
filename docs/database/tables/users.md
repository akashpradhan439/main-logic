# Table: `users`

Core identity table. Every account is identified by a `(country_code, phone_number)` composite — phone numbers are the primary human-readable identity. An internal `uuid` id is used for all foreign-key relationships everywhere else in the schema.

RLS: **disabled** (access controlled at API layer via service-role key).

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `country_code` | `text` | NO | — | ISO 3166-1 alpha-2 or dial prefix (e.g. `"IN"`). Part of composite PK. |
| `phone_number` | `bigint` | NO | — | National number without country prefix. Part of composite PK. |
| `id` | `uuid` | YES* | `gen_random_uuid()` | Surrogate key used by all FK relationships. UNIQUE constraint guarantees single-row lookup. |
| `password_hash` | `text` | NO | — | Argon2/bcrypt hash of the user's PIN/password. |
| `dob` | `date` | NO | — | Date of birth. Used for age verification. |
| `first_name` | `varchar` | NO | — | Display first name. |
| `last_name` | `varchar` | NO | — | Display last name. |
| `h3_cell` | `text` | YES | — | Current H3 cell index at resolution 4 representing the user's last known location. Written by `POST /location/hex`. |
| `h3_neighbors` | `text[]` | YES | — | Disk of H3 neighbors around `h3_cell` (computed by the location worker). Used for proximity matching. |
| `device_token` | `text` | YES | — | APNs device push token for iOS. Nullable — users without a token cannot receive push notifications. |
| `created_at` | `timestamptz` | NO | `now()` | Account creation time. |
| `updated_at` | `timestamptz` | NO | `now()` | Last profile update. |

\* `id` is technically nullable in the schema but always populated by `gen_random_uuid()` on insert.

---

## Constraints

| Name | Type | Columns |
|---|---|---|
| `users_pkey` | PRIMARY KEY | `(country_code, phone_number)` |
| `users_id_key` | UNIQUE | `id` |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `users_pkey` | UNIQUE btree `(country_code, phone_number)` | Primary lookup by phone identity |
| `users_id_key` | UNIQUE btree `(id)` | FK resolution from all child tables |
| `idx_users_h3_cell` | btree `(h3_cell)` | Location-worker proximity scans |

---

## Referenced by (incoming foreign keys)

| Table | Column | On Delete |
|---|---|---|
| `connections` | `requester_id`, `addressee_id` | NO ACTION |
| `conversations` | `participant_one`, `participant_two` | NO ACTION |
| `conversations` | `initiator_user_id` | NO ACTION |
| `messages` | `sender_id` | NO ACTION |
| `user_prekeys` | `user_id` | CASCADE |
| `one_time_prekeys` | `user_id` | CASCADE |
| `expired_tokens` | `user_id` | CASCADE |
| `connection_proximity_notifications` | `user_a_id`, `user_b_id` | CASCADE |
| `security_incidents` | `user_id` | CASCADE (via `auth.users`) |

---

## Notes

- The composite PK (`country_code`, `phone_number`) mirrors the real-world uniqueness constraint for phone numbers.
- The `id` uuid is the FK anchor used everywhere else; applications should never expose the raw phone number as a key.
- `h3_cell` and `h3_neighbors` are denormalised onto users for O(1) proximity checks by the location worker. They are overwritten on every location update.
