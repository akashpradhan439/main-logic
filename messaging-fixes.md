# Messaging Logic — Diagnosis & Fixes

**Date:** 2026-05-30
**Scope:** server (`main-logic`) + iOS client (`DempApp`). The server is a **blind relay**;
the live Signal/PQXDH + Double Ratchet crypto runs only on the iOS clients. `shared/e2ee.ts`
is a server-side reference/test impl, **not** in the live message path.

## Fixed

### Bug 1 — simultaneous-initiation deadlock (highest impact)
Both users sending a first message before either receives → both flip to *responder* onto
opposite master secrets → permanent decrypt failure, no tie-breaker.
- **Server:** `insertMessage` returns the canonical `initiator_user_id` (first sender, set-once);
  exposed on the send response, the live SSE event, and `GET /messages`.
- **iOS:** `decrypt(…, initiatorUserID:)` — the canonical initiator *ignores* a peer bootstrap
  (`conflictingBootstrapIgnored`) and keeps its session; only the non-initiator adopts responder.
- **Tests:** `tests/messaging_scenarios.test.ts` (tie-breaker set-once, send-response, SSE event).

### Bug 2 — bootstrap unreachable past the recovery window
PQXDH bootstrap rode only on n=0; recovery fetched newest-50, so long conversations / reinstalls
could never establish a session.
- **Server:** `getConversationBootstrap` + `GET /messaging/conversations/:id/bootstrap` (earliest
  bootstrap, pagination-independent).
- **iOS:** `recoverSessionFromHistory` calls the endpoint first, falls back to history scan.
- **Tests:** route returns bootstrap after 60 later messages; 404 when none; earliest-selection unit test.

### Bug 3 / #5 / #6 — SSE catch-up robustness
- **#3 Server/iOS:** first connect had no cursor → catch-up skipped. iOS now defaults the cursor to
  epoch so the server replays pending/offline messages.
- **#6 Server:** `getMessagesSinceCursor` switched from offset to **keyset** pagination (offset over a
  set that grows mid-catch-up skips/dupes). Unit-tested.
- **#5 Server:** catch-up now dedupes against the live buffer (a message both queried and buffered is
  sent once); buffer is always flushed (even with no cursor).

### #4 — background refresh created wrong initiator sessions
`MessagingBackgroundRefreshManager` called `ensureSession` indiscriminately (manufacturing a competing
initiator session, feeding Bug 1). Removed; it now relies on `decrypt` auto-establishing the responder.

### #11 — APNs payload size
`messagingWorker` no longer embeds the full envelope (ML-KEM ciphertext + bootstrap) in the push;
the push is a wake-up and the client fetches via SSE/REST. Avoids >4KB push failures on the first message.

### #12 — `signalReady`
Server now computes whether the peer has a usable bundle (`usersWithUsableBundles`: identity key present
and non-sentinel `pq_signature`) and returns `signalReady` on create/list conversations. The iOS client
already reads it and gates the composer, so it won't attempt (and drop) a send to a not-yet-keyed peer.
Unit-tested + route-tested.

### #8 — AES-128 → AES-256 SIV (BREAKING, coordinate release)
The 32-byte chain-derived key selects AES-128-SIV. Both server-ref (`shared/e2ee.ts`) and iOS
(`DefaultRatchetService.expandAeadKey`) now HKDF-expand the message key to 64 bytes
(`info = "DoubleRatchet_AEAD_AES256SIV"`) → true AES-256-SIV. **Not wire-compatible** with old
ciphertexts — ship to all clients together.

## Documented, not implemented (rationale)

### #7 — degenerate Double Ratchet (needs a coordinated protocol redesign)
The real handshake pre-seeds *both* chains and never rotates ratchet keys (initiator keeps `ekA`,
responder keeps its SPK), so the DH ratchet effectively never fires → no forward secrecy / break-in
recovery across the ratchet. It is internally consistent (messaging works), but it is not a true Double
Ratchet. Fixing it means changing both `establishInitiatorSession`/`establishResponderSession` (responder
generates a fresh ratchet key and derives the sending chain from the first DH step, initiator starts with
`peerRatchetPublicKey = ""` so the first reply triggers a DH step — exactly the shape the *unit test*
`testDHRatchetAdvancesOnReply` already encodes, which differs from what the handshake produces). This is a
breaking protocol change requiring careful cross-client interop testing; deferred to a dedicated protocol bump.

### #9 — one lost message in the exact-simultaneity race
Residual cost of the Bug 1 fix: the non-initiator's pre-flip message can't be decrypted by the initiator
(it was encrypted under the aborted session) and is dropped; the sender should resend after flipping.
Auto-resend is a future enhancement.

### #10 — auto-retry when peer uploads keys later
Today the send text is preserved in the composer and `signalReady` (#12) now gates the composer, so the
send isn't silently lost. A true offline outbox/auto-resend queue is a future enhancement.

### #13 — bootstrap stored two ways (review M8)
The server stores the bootstrap both in protobuf field 3 and in the `bootstrap_json` column; only the JSON
sidecar is consumed by clients. Harmless but drift-prone — collapse to one canonical form later.

### #14 — C4 identity-key check adds a failure mode
The server now rejects a bootstrap whose `senderIdentityKey` ≠ the stored `identity_key_public`. If a user
reinstalls with new keys but the bundle re-upload fails, their bootstraps will 403 until they re-upload.
Intended security trade-off; monitor for it.
