# Table: `user_prekeys`

One row per user. Stores the long-lived Signal Protocol key material used during PQXDH session initiation: the identity key pair (X25519 + Ed25519 signing key), the current signed pre-key, and the current post-quantum signed pre-key (ML-KEM-768).

RLS: **disabled**.

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `user_id` | `uuid` | NO | — | Primary key. References `users.id`. Cascade-deleted when the user is removed. |
| `identity_key_public` | `text` | NO | — | Base64 X25519 public key. Used as the static DH identity key in the PQXDH handshake. |
| `identity_signing_key_public` | `text` | YES | — | Base64 Ed25519 public key. Used by the initiator to verify SPK and PQ-SPK signatures before trusting them. Separate from the X25519 identity key. |
| `signed_prekey_public` | `text` | NO | — | Base64 X25519 public key of the current signed pre-key (SPK). |
| `signed_prekey_id` | `integer` | NO | `1` | Monotonically increasing ID, incremented on each SPK rotation. Lets the responder identify which SPK was used from `bootstrap_json.signedPrekeyId`. |
| `signature` | `text` | NO | — | Base64 Ed25519 signature of `signed_prekey_public` by the identity signing key. Verified by the initiator before use. |
| `pq_signed_prekey_public` | `text` | NO | — | Base64 ML-KEM-768 public key of the current PQ signed pre-key. |
| `pq_signed_prekey_id` | `integer` | NO | `1` | Monotonically increasing ID for PQ-SPK rotations. Matched against `bootstrap_json.pqSignedPrekeyId`. |
| `pq_signature` | `text` | NO | — | Base64 Ed25519 signature of `pq_signed_prekey_public` by the identity signing key. An empty string signals that the bundle must be re-uploaded. |
| `created_at` | `timestamptz` | NO | `now()` | Row creation timestamp. |
| `updated_at` | `timestamptz` | NO | `now()` | Last key rotation timestamp. |

---

## Constraints

| Name | Type | Columns | On Delete |
|---|---|---|---|
| `user_prekeys_pkey` | PRIMARY KEY | `user_id` | — |
| `user_prekeys_user_id_fkey` | FOREIGN KEY | `user_id → users.id` | CASCADE |

---

## Indexes

| Name | Definition |
|---|---|
| `user_prekeys_pkey` | UNIQUE btree `(user_id)` |

---

## Key Bundle Fetch Flow (`GET /keys/bundle/:userId`)

1. Query `user_prekeys` for the target user.
2. Atomically consume one X25519 OTP and one ML-KEM OTP via `consume_one_time_prekey()` RPC.
3. Return the full bundle to the initiator:

```jsonc
{
  "userId": "<uuid>",
  "identityKey":        "<base64 X25519>",
  "identitySigningKey": "<base64 Ed25519>",
  "signedPrekey":       "<base64 X25519>",
  "signedPrekeyId":     1,
  "signature":          "<base64>",
  "pqSignedPrekey":     "<base64 ML-KEM-768>",
  "pqSignedPrekeyId":   1,
  "pqSignature":        "<base64>",
  "oneTimePrekey":      "<base64>",    // optional — absent if pool exhausted
  "pqOneTimePrekey":    "<base64>",    // optional
  "remainingOtpCount":  42
}
```

---

## SPK Rotation (`PUT /keys/signed-prekey`)

Updates `signed_prekey_public`, `signed_prekey_id`, and `signature` in place. The `signed_prekey_id` must be incremented by the client on each rotation.

---

## Notes

- `pq_signature = ''` (empty string) is a sentinel meaning the bundle is stale and must be re-uploaded. The API returns the raw string; clients should treat empty-string signatures as invalid.
- There is intentionally no historical record of past SPKs. Once rotated, an old SPK cannot be looked up. Sessions started with an old SPK can still continue via the double ratchet.
