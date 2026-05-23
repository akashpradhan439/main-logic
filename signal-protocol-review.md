# Signal Protocol Implementation Review

**Date:** 2026-05-22  
**Reviewer:** Claude Opus 4.7  
**Scope:** `shared/e2ee.ts`, `shared/cryptography.ts`, `shared/types.ts`, `shared/envelope.proto`, `routes/keys.ts`, `routes/messaging.ts`, `routes/sse.ts`, `lib/keys.ts`, `lib/messaging.ts`, all `supabase/migrations/*signal*`, and the test files exercising the above. Compared against the Signal X3DH/PQXDH specs and Double Ratchet spec.

The code is the right shape — PQXDH with ML-KEM-768 + X25519, Double Ratchet with KDF_RK/KDF_CK, atomic OPK consumption — but several pieces deviate from spec in ways that range from "wrong constants" to "session-breaking after key rotation."

---

## CRITICAL (blocks production)

### C1. AES-SIV is silently AES-128, and is the wrong AEAD for Signal
`shared/e2ee.ts:265` calls `encryptSiv(plaintext, mk, [combinedAD])` where `mk` is a 32-byte HMAC-SHA256 output. `@noble/ciphers/aes.ts:1359` requires the key length to be 32/48/64 and splits it in half — so a 32-byte key yields **AES-128-SIV** (16-byte K1 + 16-byte K2). The cryptography test at `tests/cryptography.test.ts:74` already documents this (`// SIV-AES256 requires 64-byte key`) but production uses 32 bytes.

Two problems:
1. Silent downgrade from AES-256 to AES-128. The bundle name and comments imply AES-256.
2. AES-SIV is deterministic. Signal's Double Ratchet spec calls for AES-256-CBC + HMAC-SHA256 (or AES-256-GCM), with `mk` expanded via HKDF into `(enc_key, mac_key, iv)`. Deterministic AEAD with a one-time key is technically safe, but it is not what reviewers, auditors, or interop partners will expect, and it leaks plaintext equality if the same `mk` were ever reused (e.g., from a state-restore bug).

**Fix.** Either:
- Switch to AES-256-GCM with a per-message nonce derived from `(mk, n)`, or
- Follow Signal's spec: `HKDF(mk, "")` → 80 bytes → `(32B enc, 32B mac, 16B iv)` for AES-256-CBC + HMAC-SHA256, or
- At minimum expand `mk` to 64 bytes via HKDF and pass to `aessiv` so it's actually AES-256-SIV.

**Client impact:** Breaking protocol change. Both sender and receiver must update simultaneously. Needs session-version negotiation or hard cut-over.

---

### C2. SPK rotation overwrites the only copy of the old SPK private key
`routes/keys.ts:163` `PUT /keys/signed-prekey` does an `update` that replaces `signed_prekey_public`, `signed_prekey_id`, and `signature` in place. There is no archive of the previous SPK on the server, and clients are not given a way to fetch a historic SPK by ID.

Consequence: if Alice fetched Bob's bundle with `signed_prekey_id = 5` and is offline for a day, then Bob rotates to id `6`, when Alice finally sends her initial message naming `signed_prekey_id = 5`, Bob's private SPK 5 is gone — the handshake permanently fails, and the conversation cannot bootstrap.

**Fix.** Move SPK storage to its own table keyed by `(user_id, signed_prekey_id)`, retain N most recent (or rows with `expires_at > now() - 30d`), and have `respondToHandshake` accept a `signedPrekeyId` to pick the right private key. Same for `pq_signed_prekey_id`.

**Client impact:** Mostly server-internal. Client already sends `signed_prekey_id` in the bootstrap proto — no change needed if the server resolves historic SPKs internally.

---

### C3. OPK is consumed on every bundle fetch — trivial DoS / OPK exhaustion
`lib/keys.ts:92` calls `consume_one_time_prekey` inside `getPrekeyBundle`. Every `GET /keys/bundle/:userId` permanently consumes one classical and one PQ OPK regardless of whether the caller ever sends a message. `routes/keys.ts:111` only requires a valid JWT — there is no rate limit and no relationship check between requester and target.

Consequence: any logged-in user can drain every other user's OPK pool with a tight loop, forcing subsequent handshakes to fall back to the (much longer-lived, less-forward-secret) SPK-only path.

**Fix.**
- Rate-limit `/keys/bundle/:userId` per requester per target (e.g., 1/min).
- Consider gating bundle fetches on an `accepted` connection between the two users.
- Track and alert on `remainingOtpCount` low watermarks and have clients top up automatically.
- Optionally, switch to a "reserve" pattern: hand out OPK with a short lease, only mark `used_at` when a message that actually references it arrives.

**Client impact:** Server-only. No client changes needed.

---

### C4. Sender identity key is not verified against the JWT user
`routes/messaging.ts:407` accepts `envelope.bootstrap.senderIdentityKey` verbatim from the client and stores it. The server already has the JWT user's IK in `user_prekeys.identity_key_public` and could verify equality, but doesn't.

Consequence: a malicious sender can put a victim's identity key in the bootstrap. The recipient will believe the conversation was initiated by the victim.

**Fix.** In `POST /messaging/conversations/:id/messages`, when `envelope.bootstrap` is present, fetch `user_prekeys.identity_key_public` for the JWT `userId` and reject if it doesn't match `bootstrap.senderIdentityKey`.

**Client impact:** Server-only. Client already sends its own IK correctly; the check just enforces it server-side.

---

### C5. Identity-key schema vs handshake code are inconsistent
The schema has two columns:
- `identity_key_public` (originally Ed25519)
- `identity_signing_key_public` (Ed25519, added later in `20260422000000_add_identity_signing_key.sql`)

`routes/keys.ts:9-18` uploads both, `lib/keys.ts:107-108` returns both in the bundle, and `tests/kds.test.ts:61` confirms the API contract has two distinct fields.

But `shared/e2ee.ts:27` `HandshakeBundle` has only **one** `identityKey`, used both as Ed25519 for `verify(...)` (line 53, 56) and converted to X25519 for DH via `ed25519ToX25519` (line 60). This is the XEdDSA-style single-key approach. Tests use a single `generateSignKeyPair()` for `identityKey`, ignoring `identity_signing_key_public` entirely.

Consequence: the second column is dead weight if the protocol code is authoritative, OR the protocol code is wrong if the schema is authoritative. A deployed client could put a random value in `identity_signing_key_public` and nobody would notice.

**Fix.** Pick a model and make every layer agree:
- **Option A (Signal-style, XEdDSA):** one Ed25519 key, drop `identity_signing_key_public`, document that the X25519 IK is derived by `crypto_sign_ed25519_pk_to_curve25519`.
- **Option B (separated keys):** two keys (X25519 for DH, Ed25519 for signing), update `HandshakeBundle` and both handshake functions to take both, verify SPK signatures with the Ed25519 key, do DH with the X25519 key.

**Client impact:** Requires client update. Option A: client stops uploading `identitySigningKey`. Option B: client must use the two keys in distinct roles in its handshake code.

---

## HIGH

### H1. OPK identifiers missing from the wire protocol
`shared/envelope.proto:11` `BootstrapData` carries `signed_prekey_id` and `pq_signed_prekey_id` but **not** `one_time_prekey_id` or `pq_one_time_prekey_id`. The route accepts `usedOTPPublicKey` / `usedPQOTPPublicKey` (full public keys, not IDs) in JSON but drops them in the binary envelope, storing them only in the `bootstrap_json` sidecar.

**Fix.** Add `one_time_prekey_id` / `pq_one_time_prekey_id` to the proto, return assigned IDs from the OPK upload endpoint, have the client include them in the bootstrap.

**Client impact:** Breaking API change. Client must store OPK IDs at upload time and include them in bootstrap. Coordinate with a client release.

---

### H2. Concurrent encrypt/decrypt on the same ratchet has no mutex
`DoubleRatchet.encrypt`/`decrypt` mutate `this.state` across `await` boundaries. Two concurrent encrypts can both read the same `CKs` before either advances it — producing two messages with the same `mk`, catastrophic for deterministic AEAD.

**Fix.** Wrap per-session state in a chained-promise mutex so each call serializes.

**Client impact:** Client-side only (server doesn't encrypt/decrypt). Client's Signal implementation needs the mutex.

---

### H3. MKSKIPPED has no time-based expiry
Skipped message keys accumulate indefinitely, weakening forward secrecy over time.

**Fix.** Store `(mk, addedAt)` and evict entries older than 7 days at every encrypt/decrypt entry point.

**Client impact:** Client-side only.

---

### H4. OPK consumed at fetch, wasted if handshake aborts
Even without malice, a network drop after bundle fetch and before message send permanently wastes an OPK.

**Fix.** Two-phase consume: hand out a `lease_id` with short TTL; commit `used_at` only when a message referencing it arrives.

**Client impact:** Server-side API change. Client may need to include `lease_id` in the first message.

---

### H5. PQ-SPK rotation endpoint missing
`PUT /keys/signed-prekey` rotates the classical SPK only. No equivalent for `pq_signed_prekey_public` / `pq_signed_prekey_id`. ML-KEM signed prekeys must also rotate.

**Fix.** Add `PUT /keys/pq-signed-prekey`.

**Client impact:** Client must call the new endpoint on its PQ-SPK rotation schedule.

---

### H6. `exportState` returns mutable internal references
`shared/e2ee.ts:375` returns live references to internal arrays and the `MKSKIPPED` Map. Callers can mutate live state.

**Fix.** Deep-copy on export; provide a matching `importState()` that validates and copies in.

**Client impact:** Client-side only.

---

### H7. No state-zeroize / dispose method
On session destruction there is no way to scrub `RK`, `CKs`, `CKr`, `DHs.privateKey`, and `MKSKIPPED` values from memory.

**Fix.** Add `DoubleRatchet.dispose()` that calls `memzero` on every byte array in state and clears the map.

**Client impact:** Client-side only.

---

## MEDIUM

### M1. PQXDH info string is non-canonical
`shared/e2ee.ts:101` passes `"PQXDH_Shared_Secret"` as the HKDF `info`. Signal's PQXDH spec mandates a versioned info string such as `"PQXDH_25519_CRYSTALS-KYBER-768_SHA-256"`.

**Client impact:** Breaking protocol change. Both sides must change the info string simultaneously.

---

### M2. F-constant length — verify with spec citation
`shared/e2ee.ts:87` uses `F = 0xff * 32`. Correct for Curve25519, but needs a code comment with a literal spec citation.

**Client impact:** None.

---

### M3. KDF_CK constants are bare numbers
`KDF_CK` uses `0x01` and `0x02` without named constants or spec citation.

**Client impact:** None (clarity/maintenance only).

---

### M4. First message ciphertext not bound by identity keys (AD)
Per Signal spec, AD should be `Encode(IK_A) || Encode(IK_B)`. Current code defaults `ad` to empty (`shared/e2ee.ts:249`).

**Fix.** Always pass `ad = IK_A || IK_B` into `encrypt`/`decrypt`.

**Client impact:** Breaking protocol change. Both sides must adopt the same AD simultaneously.

---

### M5. Classical and PQ OPK consumed in two separate RPCs, no atomic rollback
`lib/keys.ts:92-95` runs both consumes in `Promise.all`. If one succeeds and the other fails, one OPK is wasted.

**Fix.** Combine into a single SQL function / transaction.

**Client impact:** Server-only.

---

### M6. `remainingOtpCount` only counts classical OPKs
`lib/keys.ts:97-102` queries `is_pq = false`. PQ pool size isn't reported.

**Fix.** Return both counts.

**Client impact:** Additive response field; client can adopt when convenient.

---

### M7. `pq_signature = ''` sentinel not surfaced to clients
`20260419000000_pq_signature_not_null.sql:5` sets empty string for legacy rows. The bundle endpoint should return a clear error ("re-upload needed") rather than a corrupt bundle.

**Client impact:** Client receives a 422/error instead of silently failing during handshake.

---

### M8. `bootstrap_json` and binary envelope carry the same data in two shapes
Risk of drift. Pick one canonical form (extended proto fields per H1) and remove the other.

**Client impact:** Once H1 is implemented, client stops sending the JSON sidecar fields.

---

### M9. `decodeEnvelope` doesn't validate key sizes
`shared/types.ts:42` doesn't check that `dhPublicKey` is 32 bytes, `pqCiphertext` is 1088 bytes, etc.

**Fix.** Add explicit length checks after decode.

**Client impact:** Server-only validation. Malformed payloads get a clear 400 instead of a deep throw.

---

### M10. No server-side replay-window dedup
The server stores every message as-is. The ratchet already rejects replays at the client, but the server could short-circuit obvious replays by deduplicating on `(conversation_id, sender_id, header.n, header.dhPublicKey)`.

**Client impact:** Server-only.

---

### M11. JWT tokens carry no per-device claim
`AccessTokenPayload` has no device ID. Multi-device sessions (each with its own ratchet) are unsupported at the protocol level.

**Client impact:** Out of scope for now; flag as a known gap for future multi-device support.

---

## LOW

### L1. Test AES-SIV key size doesn't match production
`tests/cryptography.test.ts:74` uses 64-byte key; production never exercises that path. After C1's fix, align both.

### L2. No check for X25519 all-zero DH output
Maliciously-crafted low-order points cause `crypto_scalarmult` to return all-zeros (libsodium already throws, but a defensive typed error at the API boundary is clearer).

### L3. `debug-handshake.ts` ships in `shared/` with dummy signatures
`shared/debug-handshake.ts:16,26` use `new Uint8Array(64)` as dummy signatures and `as any` casts. Move to `scripts/` or `tests/`.

### L4. `MAX_SKIP = 1000` is generous
Adversarial input (`header.n = 999` on a fresh chain) triggers 999 KDF_CK iterations. Acceptable, but worth noting.

### L5. `getSkippedKeyIdentifier` uses hex string keys
Fine for correctness; could be a `Map<Uint8Array, Map<number, Uint8Array>>` for memory efficiency at scale. Optional micro-optimization.

### L6. `protobufjs` `loadSync` at module init
Fails in bundled client environments. Consider code-generated types or `protobufjs/light`.

### L7. `verify` doesn't enforce signature length before libsodium
Typed error at the boundary would be more debuggable than a libsodium throw.

### L8. SSE catch-up re-sends bootstrap data
Recipient must idempotently handle re-seeing bootstrap. Document this contract for the mobile client.

---

## Client Impact Summary

| Category | Issues | Client change required |
|---|---|---|
| Breaking protocol (coordinate) | C1, M1, M4 | Yes — must ship client + server simultaneously |
| API contract change | C5, H1, H5 | Yes — new/changed request/response fields |
| Server-only | C2, C3, C4, M5, M6, M7, M8, M9, M10 | No |
| Client-side only (reference impl) | H2, H3, H6, H7 | Yes — client's own Signal stack |

---

## Summary Verdict

The cryptographic primitives are sourced from reputable libraries (`@noble/*`, libsodium), the high-level shape (PQXDH + Double Ratchet) is correct, atomic OPK consumption is in place, and there is a real out-of-order delivery test.

**Not production-ready as-is.** Ship-blockers:

1. **C1** — AEAD is silently AES-128-SIV, not AES-256. Fix before any external launch.
2. **C2** — SPK rotation destroys the only copy of the old private key, breaking in-flight handshakes. Will manifest as random "messages won't decrypt" in prod.

**Recommended remediation order:**
1. Server-only fixes (C2 SPK archive, C3 rate limit, C4 IK cross-check, H5 PQ-SPK endpoint)
2. Additive API changes (M6 OPK counts, H5 new endpoint)
3. H1 (OPK IDs in proto) — coordinate with a client release
4. C1 + M1 + M4 as a single coordinated protocol-version bump — ship together to all client platforms
