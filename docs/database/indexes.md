# Indexes

All indexes in the `public` schema, grouped by table. PK indexes are included for completeness.

---

## `connection_proximity_notifications`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `connection_proximity_notifications_pkey` | UNIQUE btree | `(id)` | PK |
| `unique_pair` | UNIQUE btree | `(user_a_id, user_b_id)` | Enforces one dedup row per user pair; used for upsert ON CONFLICT |
| `idx_cpn_user_a` | btree | `(user_a_id)` | Fetch all records for a given user (a-side) |
| `idx_cpn_user_b` | btree | `(user_b_id)` | Fetch all records for a given user (b-side) |

---

## `connections`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `connections_pkey` | UNIQUE btree | `(id)` | PK |
| `connections_requester_id_addressee_id_key` | UNIQUE btree | `(requester_id, addressee_id)` | Prevents duplicate directed requests |
| `unique_connection_pair` | UNIQUE btree | `(LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))` | Symmetric dedup — one row per unordered pair regardless of who initiated |
| `idx_connections_requester` | btree | `(requester_id)` | Fetch all connections for a user (requester side) |
| `idx_connections_addressee` | btree | `(addressee_id)` | Fetch all connections for a user (addressee side) |
| `idx_connections_status` | btree | `(status)` | Filter by status; also supports `status = 'accepted'` scans in the location worker |

---

## `conversations`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `conversations_pkey` | UNIQUE btree | `(id)` | PK |
| `uq_conversation_pair` | UNIQUE btree | `(participant_one, participant_two)` | One conversation per canonical user pair |
| `idx_conversations_participant_one` | btree | `(participant_one, updated_at DESC)` | Inbox list for p1, ordered by most-recently-updated |
| `idx_conversations_participant_two` | btree | `(participant_two, updated_at DESC)` | Inbox list for p2, ordered by most-recently-updated |

---

## `countries`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `countries_pkey` | UNIQUE btree | `(country_code)` | PK; reference lookup by ISO code |

---

## `expired_tokens`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `expired_tokens_pkey` | UNIQUE btree | `(token_hash)` | PK; O(1) blocklist check on every authenticated request |
| `idx_expired_tokens_expired_at` | btree | `(expired_at)` | Range delete for pruning expired rows |

---

## `messages`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `messages_pkey` | UNIQUE btree | `(id)` | PK |
| `idx_messages_conversation_created` | btree | `(conversation_id, created_at DESC)` | Core pagination index for `GET /messaging/conversations/:id/messages` and SSE cursor replay |
| `idx_messages_sender` | btree | `(sender_id, created_at DESC)` | Worker and audit queries by sender |

---

## `notifications`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `notifications_pkey` | UNIQUE btree | `(id)` | PK |
| `idx_notifications_pair_created` | btree | `(user_a_id, user_b_id, created_at DESC)` | Recent-notification lookup for a pair (rate-limiting) |
| `idx_notifications_initiator` | btree | `(initiator_id, created_at DESC)` | Per-user notification history |

---

## `one_time_prekeys`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `one_time_prekeys_pkey` | UNIQUE btree | `(id)` | PK |
| `idx_otp_unused` | PARTIAL btree | `(user_id, is_pq)` WHERE `used_at IS NULL` | Only indexes available keys — keeps the index small as keys are consumed. Critical for `consume_one_time_prekey` performance. |

---

## `security_incidents`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `security_incidents_pkey` | UNIQUE btree | `(id)` | PK |
| `idx_security_incidents_user_id` | btree | `(user_id)` | All incidents for a user |
| `idx_security_incidents_type` | btree | `(incident_type)` | Filter by event type |
| `idx_security_incidents_created_at` | btree | `(created_at DESC)` | Recent-incidents dashboard / time-range queries |

---

## `user_prekeys`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `user_prekeys_pkey` | UNIQUE btree | `(user_id)` | PK; one row per user |

---

## `users`

| Index | Type | Columns | Notes |
|---|---|---|---|
| `users_pkey` | UNIQUE btree | `(country_code, phone_number)` | PK; phone-number identity lookup |
| `users_id_key` | UNIQUE btree | `(id)` | FK resolution from all child tables |
| `idx_users_h3_cell` | btree | `(h3_cell)` | Proximity scan — location worker queries users by H3 cell |
