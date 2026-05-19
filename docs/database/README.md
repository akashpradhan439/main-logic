# Database Schema Reference

Supabase project · region `ap-south-1` · PostgreSQL 17

This folder documents every table, index, stored function, and security policy in the `public` schema.

---

## Table of Contents

| Table | Purpose | Rows (approx) |
|---|---|---|
| [users](tables/users.md) | Core identity — phone-number-based accounts | 3 |
| [connections](tables/connections.md) | Bidirectional social graph (pending / accepted / blocked / rejected) | 2 |
| [conversations](tables/conversations.md) | 1-to-1 E2EE conversation channels | 2 |
| [messages](tables/messages.md) | Encrypted message envelopes (protobuf + bootstrap metadata) | 163 |
| [user_prekeys](tables/user_prekeys.md) | Long-lived Signal Protocol key bundles per user | 1 |
| [one_time_prekeys](tables/one_time_prekeys.md) | Ephemeral X25519 and ML-KEM one-time pre-keys | 600 |
| [notifications](tables/notifications.md) | Proximity-overlap event log | 0 |
| [connection_proximity_notifications](tables/connection_proximity_notifications.md) | Deduplication state for proximity push alerts | 0 |
| [countries](tables/countries.md) | Reference table — country codes, dialling codes, flags | 0 |
| [expired_tokens](tables/expired_tokens.md) | JWT blocklist for logged-out / rotated tokens | 360 |
| [security_incidents](tables/security_incidents.md) | Audit log for suspicious auth events | 0 |

Additional references:
- [Stored Functions](functions.md)
- [Indexes](indexes.md)
- [RLS Policies & Security](security.md)

---

## Entity-Relationship Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  auth.users (Supabase managed)                               │
│  id (uuid)                                                   │
└───────────────────────┬──────────────────────────────────────┘
                        │ (security_incidents.user_id)
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  users                                                              │
│  PK: (country_code, phone_number)   UNIQUE: id (uuid)               │
│  first_name, last_name, dob, password_hash                          │
│  h3_cell, h3_neighbors[]            device_token                    │
└──┬──────────┬──────────┬──────────┬──────────┬──────────┬───────────┘
   │          │          │          │          │          │
   │1:N       │1:N       │1:1       │1:N       │1:N       │1:N
   ▼          ▼          ▼          ▼          ▼          ▼
connections  conv...   user_     one_time_  expired_  conn_prox_
(req/addr    ersations prekeys   prekeys    tokens    notif...
 → users.id) (p1,p2    (user_id) (user_id)  (user_id) (user_a/b
             → users.id)                               → users.id)
                │
                │1:N
                ▼
           messages
           (conversation_id → conversations.id)
           (sender_id       → users.id)
```

---

## Domain Groups

### Identity & Auth
`users` · `countries` · `expired_tokens` · `security_incidents`

### Social Graph
`connections` · `connection_proximity_notifications` · `notifications`

### Encrypted Messaging
`conversations` · `messages`

### Signal Protocol / PQXDH Key Material
`user_prekeys` · `one_time_prekeys`

---

## Migration History

| File | Description |
|---|---|
| `20250306000000_create_notifications_table.sql` | Initial notifications table |
| `20250306000001_add_device_token_to_users.sql` | APNs device token on users |
| `20260321000000_create_messaging_tables.sql` | conversations + messages |
| `20260404000000_signal_protocol_schema.sql` | user_prekeys + one_time_prekeys |
| `20260416000000_add_pq_signature.sql` | PQ signature column on user_prekeys |
| `20260417000000_fix_message_constraint.sql` | Message FK constraint fix |
| `20260418000000_atomic_opk_consume.sql` | consume_one_time_prekey RPC |
| `20260419000000_pq_signature_not_null.sql` | Make pq_signature NOT NULL |
| `20260420000000_add_spk_id.sql` | signed_prekey_id / pq_signed_prekey_id |
| `20260421000000_envelope_column_type.sql` | messages.envelope as text (base64 proto) |
| `20260422000000_add_identity_signing_key.sql` | Ed25519 identity signing key |
| `20260423000000_add_bootstrap_json.sql` | bootstrap_json on messages, initiator_user_id on conversations |
