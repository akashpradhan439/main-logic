# Table: `notifications`

Event log for proximity-based overlap notifications. A row is written each time the location worker detects that two users share an overlapping H3 cell and a push notification is dispatched.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. |
| `user_a_id` | `uuid` | NO | — | One of the two users who overlapped. |
| `user_b_id` | `uuid` | NO | — | The other user who overlapped. |
| `initiator_id` | `uuid` | NO | — | The user whose location update triggered the overlap detection. |
| `overlap_hex` | `text` | NO | — | The H3 cell index (resolution 4) where the overlap was detected. |
| `notification_type` | `text` | NO | `'hex_overlap'` | Type discriminator. Currently always `hex_overlap`. |
| `created_at` | `timestamptz` | NO | `now()` | When the notification was created/sent. |

---

## Constraints

| Name | Type | Columns |
|---|---|---|
| `notifications_pkey` | PRIMARY KEY | `id` |

No foreign keys — `user_a_id`, `user_b_id`, `initiator_id` are UUIDs referencing `users.id` but without a formal FK constraint in the current schema.

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `notifications_pkey` | UNIQUE btree `(id)` | PK lookup |
| `idx_notifications_pair_created` | btree `(user_a_id, user_b_id, created_at DESC)` | Check recent notifications for a pair (rate-limiting / dedup logic) |
| `idx_notifications_initiator` | btree `(initiator_id, created_at DESC)` | Audit trail per initiating user |

---

## Notes

- This table is a pure append log. It is not used for deduplication — that role belongs to `connection_proximity_notifications`.
- The `user_a_id` / `user_b_id` ordering may or may not be canonical. Queries should use an OR clause or normalise the pair order.
