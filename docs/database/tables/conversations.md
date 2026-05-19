# Table: `conversations`

A 1-to-1 conversation channel between exactly two users. Participant ordering is canonical (smaller UUID first) so there is always exactly one row per pair, enforced by `uq_conversation_pair`.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. Referenced by `messages.conversation_id`. |
| `participant_one` | `uuid` | NO | — | The lexicographically smaller of the two user UUIDs. References `users.id`. |
| `participant_two` | `uuid` | NO | — | The lexicographically larger of the two user UUIDs. References `users.id`. |
| `initiator_user_id` | `uuid` | YES | `NULL` | The user who sent the first message in this conversation. Set on the first `insertMessage` call when the column is still NULL, then never overwritten. Used by clients as a role hint to determine whether to act as PQXDH initiator or responder. References `users.id`. |
| `created_at` | `timestamptz` | NO | `now()` | When the conversation was first created. |
| `updated_at` | `timestamptz` | NO | `now()` | Bumped on every new message insertion. Used for inbox ordering. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `conversations_pkey` | PRIMARY KEY | `id` | — |
| `uq_conversation_pair` | UNIQUE | `(participant_one, participant_two)` | — |
| `fk_conversations_participant_one` | FOREIGN KEY | `participant_one → users.id` | NO ACTION |
| `fk_conversations_participant_two` | FOREIGN KEY | `participant_two → users.id` | NO ACTION |
| `conversations_initiator_user_id_fkey` | FOREIGN KEY | `initiator_user_id → users.id` | NO ACTION |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `conversations_pkey` | UNIQUE btree `(id)` | PK lookup |
| `uq_conversation_pair` | UNIQUE btree `(participant_one, participant_two)` | One conversation per pair |
| `idx_conversations_participant_one` | btree `(participant_one, updated_at DESC)` | Inbox list ordered by recency for p1 |
| `idx_conversations_participant_two` | btree `(participant_two, updated_at DESC)` | Inbox list ordered by recency for p2 |

---

## Referenced by

| Table | Column | On Delete |
|---|---|---|
| `messages` | `conversation_id` | CASCADE — deleting a conversation purges all its messages. |

---

## Participant Ordering

The application always normalises the pair before inserting or querying:

```ts
// lib/messaging.ts — getConversationParticipants()
participantOne = userIdA < userIdB ? userIdA : userIdB;
participantTwo = userIdA < userIdB ? userIdB : userIdA;
```

This makes the `uq_conversation_pair` unique constraint effective regardless of which user initiates the query.

---

## Role Hint (`initiator_user_id`)

`initiator_user_id` is set atomically by the server on the first message insert:

```sql
UPDATE conversations
SET initiator_user_id = $senderId
WHERE id = $conversationId
  AND initiator_user_id IS NULL;
```

Client logic:
- `initiator_user_id == self` → act as PQXDH **initiator** (call `ensureSession`).
- `initiator_user_id == other` → act as PQXDH **responder** (fetch history → bootstrap → derive session).
- `initiator_user_id IS NULL` → no message sent yet; either side may initiate.
