# Table: `connection_proximity_notifications`

Deduplication state for proximity push alerts between connected users. Tracks which pairs have already received an alert so the push worker does not spam repeated notifications for the same overlap. One row per unique unordered user pair.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. |
| `user_a_id` | `uuid` | NO | — | One user in the pair. References `users.id`. |
| `user_b_id` | `uuid` | NO | — | The other user in the pair. References `users.id`. |
| `overlapping_cells` | `text[]` | NO | — | Array of H3 cell indices where the overlap was detected. May contain multiple cells if users share more than one. |
| `created_at` | `timestamptz` | NO | `now()` | When the notification was last sent for this pair. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `connection_proximity_notifications_pkey` | PRIMARY KEY | `id` | — |
| `unique_pair` | UNIQUE | `(user_a_id, user_b_id)` | — |
| `connection_proximity_notifications_user_a_id_fkey` | FOREIGN KEY | `user_a_id → users.id` | CASCADE |
| `connection_proximity_notifications_user_b_id_fkey` | FOREIGN KEY | `user_b_id → users.id` | CASCADE |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `connection_proximity_notifications_pkey` | UNIQUE btree `(id)` | PK lookup |
| `unique_pair` | UNIQUE btree `(user_a_id, user_b_id)` | Enforce one row per pair; used for upsert deduplication |
| `idx_cpn_user_a` | btree `(user_a_id)` | Fetch all dedup records for a given user (a-side) |
| `idx_cpn_user_b` | btree `(user_b_id)` | Fetch all dedup records for a given user (b-side) |

---

## How It Is Used

The location-updated worker (`workers/locationUpdatedWorker.ts`) upserts into this table on each overlap detection:

```
UPSERT (user_a_id, user_b_id, overlapping_cells, created_at)
ON CONFLICT (user_a_id, user_b_id) DO UPDATE
  SET overlapping_cells = ..., created_at = now()
```

If the row already exists and was created within the cooldown window, no push is sent. If it is new or the cooldown has expired, the push notification worker fires.

---

## Notes

- `user_a_id` / `user_b_id` ordering must be normalised by the worker (canonical pair) before the upsert to make the `unique_pair` constraint effective.
- On user deletion, CASCADE removes all dedup rows for that user, which means the other user in a pair will receive a fresh push the next time they overlap with a newly re-registered account.
