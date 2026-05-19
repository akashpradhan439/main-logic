# Table: `messages`

Stores end-to-end encrypted message envelopes. The server treats the ciphertext as completely opaque — it stores and forwards bytes without being able to read content. The `bootstrap_json` column carries the PQXDH session-bootstrap metadata needed by a responder to derive the shared secret on reconnect or history fetch.

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key. Used as the SSE event `id` for deduplication and cursor catchup. |
| `conversation_id` | `uuid` | NO | — | The conversation this message belongs to. References `conversations.id`. CASCADE delete. |
| `sender_id` | `uuid` | NO | — | The user who sent the message. References `users.id`. |
| `envelope` | `text` | YES | — | Base64-encoded protobuf `MessageEnvelope` (defined in `shared/envelope.proto`). Contains: ratchet header (`dhPublicKey`, `n`, `pn`) + AES-256-GCM `ciphertext`. The core message payload — never decryptable by the server. |
| `bootstrap_json` | `jsonb` | YES | `NULL` | PQXDH session-bootstrap data. Present only on the first message of a new session. Persisted verbatim from the client upload. Structure documented below. |
| `content` | `text` | YES | — | Legacy plaintext field, unused in the current E2EE flow. Retained for schema compatibility. |
| `ephemeral_key` | `text` | YES | — | Legacy ephemeral key field, superseded by `envelope`. |
| `ratchet_index` | `integer` | YES | — | Legacy ratchet counter, superseded by `envelope`. |
| `previous_ratchet_index` | `integer` | YES | — | Legacy field, superseded by `envelope`. |
| `header_mac` | `text` | YES | — | Legacy header MAC, superseded by `envelope`. |
| `encryption_type` | `encryption_type` (enum) | YES | `'none'` | Enum: `none` \| `signal`. Indicates which encryption scheme was used. Current sessions always use `signal`. |
| `attachment_url` | `text` | YES | — | Optional URL to an out-of-band attachment (e.g. S3 object). |
| `attachment_type` | `text` | YES | — | MIME type of the attachment (e.g. `image/jpeg`). |
| `created_at` | `timestamptz` | NO | `now()` | Insertion timestamp. Used as the pagination cursor in `GET /messaging/conversations/:id/messages`. |

---

## `bootstrap_json` Structure

Only present on the first message of a new PQXDH session. `NULL` on all subsequent double-ratchet messages.

```jsonc
{
  "senderIdentityKey":   "<base64 X25519 public key>",
  "senderEphemeralKey":  "<base64 X25519 ephemeral public key>",
  "pqCiphertext":        "<base64 ML-KEM-768 ciphertext>",
  "signedPrekeyId":      1,          // integer — which SPK was used
  "pqSignedPrekeyId":    1,          // integer — which PQ-SPK was used
  "usedOTPPublicKey":    "<base64>", // optional — classic OTP public key that was consumed
  "usedPQOTPPublicKey":  "<base64>"  // optional — PQ OTP public key that was consumed
}
```

The bootstrap is included in:
- **SSE `new_message` events** — as a sibling `bootstrap` field alongside `envelope`.
- **`GET /messaging/conversations/:id/messages`** — nested inside the structured `envelope` object.

This ensures a responder can derive the session from history even if the real-time SSE delivery was missed.

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `messages_pkey` | PRIMARY KEY | `id` | — |
| `messages_conversation_id_fkey` | FOREIGN KEY | `conversation_id → conversations.id` | CASCADE |
| `fk_messages_sender_id` | FOREIGN KEY | `sender_id → users.id` | NO ACTION |

---

## Indexes

| Name | Definition | Purpose |
|---|---|---|
| `messages_pkey` | UNIQUE btree `(id)` | PK lookup |
| `idx_messages_conversation_created` | btree `(conversation_id, created_at DESC)` | Paginated history fetch for a conversation |
| `idx_messages_sender` | btree `(sender_id, created_at DESC)` | Messages by sender (worker / audit queries) |

---

## Message Delivery Flow

```
Client POST /messaging/conversations/:id/messages
        │
        ▼
  Validate JWT + participation + block check
        │
        ▼
  insertMessage() — stores envelope (protobuf) + bootstrap_json
        │
        ├──► Is recipient connected via SSE?
        │         YES → send "message" SSE event (envelope + bootstrap)
        │         NO  → publish messaging.new to RabbitMQ
        │                    │
        │                    └──► messagingWorker → APNs push
        ▼
  Return 201 { message: { id, conversationId, senderId, envelope, ... } }
```

---

## REST History Response Shape

`GET /messaging/conversations/:id/messages` returns structured envelopes — the protobuf is decoded server-side:

```jsonc
{
  "id": "<uuid>",
  "conversationId": "<uuid>",
  "senderId": "<uuid>",
  "envelope": {
    "header": { "dhPublicKey": "<base64>", "n": 0, "pn": 0 },
    "ciphertext": "<base64>",
    "bootstrap": { /* bootstrap_json contents, if present */ }
  },
  "attachmentUrl": null,
  "attachmentType": null,
  "createdAt": "<iso8601>"
}
```

---

## Notes

- Legacy columns (`content`, `ephemeral_key`, `ratchet_index`, `previous_ratchet_index`, `header_mac`) predate the Signal Protocol integration and are kept for schema history only. They are not written or read by the current API.
- The `bootstrap_json` column is durable for the lifetime of the message row. It must not be cleared after delivery — a responder may need it days after the message was sent (e.g. after reinstalling the app).
