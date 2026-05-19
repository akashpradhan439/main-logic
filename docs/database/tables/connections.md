# Table: `connections`

Represents a directed-then-symmetric social relationship between two users. The record is always stored with the canonical pair ordering (`LEAST(requester_id, addressee_id)`, `GREATEST(...)`) enforced by the `unique_connection_pair` index, ensuring exactly one row per pair regardless of which side initiated.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. |
| `requester_id` | `uuid` | NO | — | User who sent the connection request. References `users.id`. |
| `addressee_id` | `uuid` | NO | — | User who received the request. References `users.id`. |
| `status` | `text` | NO | — | Current state. CHECK constraint: `pending`, `accepted`, `blocked`, `rejected`. |
| `requester_blocked` | `boolean` | NO | `false` | Soft-block flag set by the requester side (allows filtering without a full `blocked` status). |
| `addressee_blocked` | `boolean` | NO | `false` | Soft-block flag set by the addressee side. |
| `created_at` | `timestamptz` | YES | `now()` | When the connection request was first created. |
| `updated_at` | `timestamptz` | YES | `now()` | Last status change. |

---

## Constraints

| Name | Type | Columns | Notes |
|---|---|---|---|
| `connections_pkey` | PRIMARY KEY | `id` | |
| `connections_requester_id_addressee_id_key` | UNIQUE | `(requester_id, addressee_id)` | Prevents duplicate directed requests. |
| `unique_connection_pair` | UNIQUE | `(LEAST(requester_id,addressee_id), GREATEST(requester_id,addressee_id))` | Guarantees at most one row per unordered user pair. |
| `status` CHECK | CHECK | `status` | Must be one of `pending`, `accepted`, `blocked`, `rejected`. |
| `connections_requester_id_fkey` | FOREIGN KEY | `requester_id → users.id` | NO ACTION on delete. |
| `connections_addressee_id_fkey` | FOREIGN KEY | `addressee_id → users.id` | NO ACTION on delete. |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `connections_pkey` | UNIQUE btree `(id)` | PK lookup |
| `connections_requester_id_addressee_id_key` | UNIQUE btree `(requester_id, addressee_id)` | Directed-pair dedup |
| `unique_connection_pair` | UNIQUE btree `(LEAST(...), GREATEST(...))` | Symmetric pair dedup |
| `idx_connections_requester` | btree `(requester_id)` | Fetch all connections for a user by requester side |
| `idx_connections_addressee` | btree `(addressee_id)` | Fetch all connections for a user by addressee side |
| `idx_connections_status` | btree `(status)` | Filter by status (e.g. all `accepted`) |

---

## Status Lifecycle

```
         QR scan / invite
               │
               ▼
           pending
          /       \
    accepted     rejected
       │
  (soft block)
  requester_blocked = true
  addressee_blocked = true
       │
    blocked (hard)
```

- **pending** — request sent, awaiting response.
- **accepted** — both sides are connected; messaging is permitted.
- **blocked** — either side called the block endpoint; messaging is denied.
- **rejected** — addressee declined; re-request subject to cooldown.
- `requester_blocked` / `addressee_blocked` — independent soft-block flags layered on top of `accepted`; the API checks `isPairBlocked()` which ORs both flags.

---

## Notes

- Messaging routes guard against blocked pairs via `isPairBlocked(connection)` in `lib/connections.ts`.
- The `unique_connection_pair` expression index means the application always resolves the canonical pair (`LEAST`/`GREATEST`) before querying, regardless of who made the request first.
