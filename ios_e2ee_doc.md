# iOS E2EE System Implementation (Phase 2)

This document provides technical details for implementing the End-to-End Encryption (E2EE) system on the iOS client. The system uses **PQXDH** (Post-Quantum Extended Diffie-Hellman) for initial key exchange and the **Double Ratchet** algorithm for ongoing session security.

## 🛠 Cryptographic Primitives

The system relies on the following algorithms:
- **X25519**: Elliptic Curve Diffie-Hellman (ECDH).
- **Ed25519**: Digital signatures (Identity Keys).
- **ML-KEM-768**: Post-quantum Key Encapsulation Mechanism.
- **AES-SIV**: Deterministic Authenticated Encryption with Associated Data (AEAD).
- **HKDF-SHA256**: Key derivation.
- **HMAC-SHA256**: Message key derivation.

---

## 🔑 Key Management

Each client must manage several types of keys:

1.  **Identity Keypair (IK)**: A long-term Ed25519 keypair representing the user.
2.  **Signed Prekey (SPK)**: An intermediate X25519 keypair signed by the IK.
3.  **PQ Signed Prekey (PQSPK)**: An intermediate ML-KEM-768 keypair.
4.  **One-Time Prekeys (OPK)**: A batch of X25519 keys for one-time use.
5.  **PQ One-Time Prekeys (PQOPK)**: A batch of ML-KEM-768 keys for one-time use.

### Uploading Keys
Clients must upload their public keys to the server after login/registration.

**POST `/keys/upload`**

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Body:**
```json
{
  "identityKey": "BASE64_IDENTITY_PUBLIC_KEY",
  "signedPrekey": "BASE64_SIGNED_PREKEY_PUBLIC_KEY",
  "pqSignedPrekey": "BASE64_PQ_SIGNED_PREKEY_PUBLIC_KEY",
  "signature": "BASE64_SIGNATURE_OF_SPK_BY_IK",
  "oneTimePrekeys": [
    { "key": "BASE64_OPK_1", "isPq": false },
    { "key": "BASE64_PQOPK_1", "isPq": true }
  ]
}
```

### Fetching a Prekey Bundle
To start a conversation, you must fetch the recipient's bundle.

**GET `/keys/bundle/:userId`**

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Response (200 OK):**
```json
{
  "success": true,
  "bundle": {
    "userId": "RECIPIENT_UUID",
    "identityKey": "...",
    "signedPrekey": "...",
    "pqSignedPrekey": "...",
    "signature": "...",
    "oneTimePrekey": "...",
    "pqOneTimePrekey": "..."
  }
}
```

**Error (404 Not Found):**
If the server returns a 404 error, it means the recipient has **not uploaded their prekey bundle yet**. You cannot initiate an E2EE conversation with this user until they do so.

### 📱 Swift Example: Uploading Keys

```swift
func uploadKeys(token: String, identityKey: Data, signedPrekey: Data, pqSignedPrekey: Data, signature: Data) {
    let url = URL(string: "https://api.yourdomain.com/keys/upload")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body: [String: Any] = [
        "identityKey": identityKey.base64EncodedString(),
        "signedPrekey": signedPrekey.base64EncodedString(),
        "pqSignedPrekey": pqSignedPrekey.base64EncodedString(),
        "signature": signature.base64EncodedString(),
        "oneTimePrekeys": [] // Populate with generated OPKs/PQOPKs
    ]

    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    URLSession.shared.dataTask(with: request) { data, response, error in
        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
            print("Keys uploaded successfully")
        } else {
            print("Upload failed: \(String(describing: response))")
        }
    }.resume()
}
```

---

## 🤝 PQXDH Handshake

The handshake establishes a shared secret between two users.

### Initiator (Alice)
Alice fetches Bob's "bundle" (IK, SPK, PQSPK, Signature, and optional OPK/PQOPK).

1.  **Verify**: Alice verifies the signature of Bob's SPK using his IK.
2.  **Generate Ephemeral**: Alice generates an ephemeral X25519 keypair (EK).
3.  **Calculate DHs**:
    - `DH1 = X25519(IKa_private, SPKb_public)`
    - `DH2 = X25519(EKa_private, IKb_public)`
    - `DH3 = X25519(EKa_private, SPKb_public)`
    - `DH4 = X25519(EKa_private, OPKb_public)` (if OPK exists)
4.  **PQ Encapsulate**:
    - Alice uses Bob's `PQOPK` (or `PQSPK` if no OPK) to run `ML-KEM.Encapsulate()`.
    - Result: `PQ_Secret` and `PQ_Ciphertext`.
5.  **Derive Shared Secret**:
    - `SK = HKDF(DH1 || DH2 || DH3 || DH4 || PQ_Secret, salt=0, info="PQXDH_Shared_Secret")`

Alice sends her `IKa_public`, `EKa_public`, and `PQ_Ciphertext` to Bob in the first message.

---

## 🔄 Double Ratchet

Once a shared secret (`SK`) is established, it initializes the Double Ratchet.

### Root Chain
- `KDF_RK(RK, DH_out)` -> `(RK, CK)`
- Uses HKDF-SHA256.

### Sending/Receiving Chains
- `KDF_CK(CK)` -> `(CK_next, MK)`
- `CK_next = HMAC-SHA256(CK, 0x01)`
- `MK = HMAC-SHA256(CK, 0x02)` (Message Key)

### Encryption
For each message:
1.  Perform a Symmetric Ratchet step on the Sending Chain to get a new `MK`.
2.  Encrypt the plaintext using `AES-SIV` with the `MK`.
3.  Include the current `DH_public`, `N` (message index), and `PN` (previous chain length) in the header.

---

## 📦 Message Envelope (Protobuf)

The `envelope` field in the API is a Protobuf-encoded message.

```protobuf
syntax = "proto3";

message MessageHeader {
  bytes dhPublicKey = 1;
  int32 n = 2;
  int32 pn = 3;
}

message MessageEnvelope {
  MessageHeader header = 1;
  bytes ciphertext = 2;
}
```

---

## 📱 Swift Implementation Tips

### 1. Libraries
Use [Swift-sodium](https://github.com/jedisct1/swift-sodium) (for X25519/Ed25519) and a Post-Quantum library like [QuantumSafeSwift](https://github.com/open-quantum-safe/liboqs-swift) or similar for ML-KEM.

### 2. SIV Encryption
AES-SIV is not natively in CryptoKit. You may need a library like [CryptoSwift](https://github.com/krzyzanowskim/CryptoSwift) or a custom C wrapper for LibTomCrypt.

### 3. HKDF & HMAC
Use Apple's `CryptoKit`:
```swift
import CryptoKit

// HKDF
let sharedSecret = HKDF<SHA256>.deriveKey(
    inputKeyMaterial: SymmetricKey(data: combinedSecrets),
    outputByteCount: 32,
    info: "PQXDH_Shared_Secret".data(using: .utf8)!
)

// HMAC for Chain Ratchet
let ckNext = HMAC<SHA256>.authenticationCode(for: Data([0x01]), using: ck)
let mk = HMAC<SHA256>.authenticationCode(for: Data([0x02]), using: ck)
```

### 4. Zeroing Memory
Ensure private keys and message keys are wiped from memory after use using `UnsafeMutableRawBufferPointer` or similar techniques.

## 💻 Swift Example: Symmetric Ratchet

```swift
import Foundation
import CryptoKit

struct SymmetricRatchet {
    var chainKey: SymmetricKey

    mutating func next() -> SymmetricKey {
        // CK_next = HMAC-SHA256(CK, 0x01)
        let ckNextData = HMAC<SHA256>.authenticationCode(
            for: Data([0x01]),
            using: chainKey
        )

        // MK = HMAC-SHA256(CK, 0x02)
        let mkData = HMAC<SHA256>.authenticationCode(
            for: Data([0x02]),
            using: chainKey
        )

        // Update state
        self.chainKey = SymmetricKey(data: ckNextData)

        // Return Message Key
        return SymmetricKey(data: mkData)
    }
}
```

## 🔐 AES-SIV with Associated Data

The server uses the Protobuf-encoded `MessageHeader` as Associated Data for AES-SIV.

```swift
func encrypt(plaintext: Data, messageKey: SymmetricKey, header: Data) -> Data {
    // Note: AD must include the serialized header
    // The server expects: ciphertext = AES-SIV-Encrypt(key=MK, plaintext=PT, ad=[header])
    // Implementation depends on your chosen AES-SIV library.
}
```
