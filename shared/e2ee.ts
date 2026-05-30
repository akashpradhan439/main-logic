import {
  generateDHKeyPair,
  diffieHellman,
  pqEncapsulate,
  pqDecapsulate,
  verify,
  hkdf,
  hmac_sha256,
  encryptSiv,
  decryptSiv,
  memzero,
  equals,
  type SignKeyPair,
  type DHKeyPair,
  type PQKeyPair,
  ed25519ToX25519,
  ed25519skToX25519,
} from "./cryptography.js";
import {
  type MessageEnvelope,
  type MessageHeader,
  encodeHeader
} from "./types.js";

// ─── Protocol Constants ───────────────────────────────────────────────────────

/**
 * PQXDH HKDF `info` string. Per the Signal PQXDH spec §3.3 ("Sending the initial
 * message"), `info` is a versioned ASCII identifier of the protocol parameters:
 * curve, KEM, and hash. ML-KEM-768 is the standardized name for CRYSTALS-KYBER-768.
 * NOTE: changing this value is a breaking protocol change — every client must
 * derive the same string or handshakes silently produce mismatched secrets.
 */
const PQXDH_INFO = "PQXDH_25519_ML-KEM-768_SHA-256";

/**
 * AEAD key length for the Double Ratchet message cipher. AES-SIV (RFC 5297)
 * splits the key in half: K1 for S2V/CMAC and K2 for CTR. A 64-byte key therefore
 * yields true AES-256-SIV (32-byte K1 + 32-byte K2). The 32-byte message key from
 * KDF_CK is expanded to this length via HKDF (see deriveAeadKey).
 */
const AEAD_KEY_LEN = 64;
const AEAD_KDF_INFO = "DoubleRatchet_AEAD_AES256SIV";

/**
 * X3DH/PQXDH domain-separation prefix `F`. For Curve25519 this is 32 bytes of
 * 0xFF (X3DH spec §2.2: "F = encodeUTF8('FF'..) for curves; a byte sequence of
 * 0xFF of length equal to the curve field, i.e. 32 bytes for Curve25519").
 */
const F_CONSTANT = new Uint8Array(32).fill(0xff);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HandshakeBundle {
  identityKey: Uint8Array;
  signedPrekey: Uint8Array;
  pqSignedPrekey: Uint8Array;
  signature: Uint8Array;
  pqSignature: Uint8Array;
  oneTimePrekey?: Uint8Array;
  pqOneTimePrekey?: Uint8Array;
}

export interface HandshakeResult {
  sharedSecret: Uint8Array;
  ephemeralKey: Uint8Array; // This will be sent to the peer to complete handshake
  pqCiphertext?: Uint8Array; // Sent to the peer
}

// ─── PQXDH Handshake ─────────────────────────────────────────────────────────

/**
 * Initiator (Alice) performs PQXDH handshake with Bob's bundle.
 */
export async function initiateHandshake(
  aliceIdentityKeyPair: SignKeyPair & DHKeyPair,
  bobBundle: HandshakeBundle
): Promise<HandshakeResult> {
  // 1. Verify Bob's signatures on SPKb and PQSPKb by IKb
  const isValid = verify(bobBundle.signedPrekey, bobBundle.signature, bobBundle.identityKey);
  if (!isValid) throw new Error("Invalid bundle signature");

  const isValidPQ = verify(bobBundle.pqSignedPrekey, bobBundle.pqSignature, bobBundle.identityKey);
  if (!isValidPQ) throw new Error("Invalid PQ bundle signature");

  // 2. Convert Bob's Ed25519 Identity Key to X25519 for DH
  const bobIdentityKX = ed25519ToX25519(bobBundle.identityKey);

  // 3. Generate ephemeral X25519 keypair
  const aliceEphemeral = generateDHKeyPair();

  // 4. DH Handshake (X3DH / PQXDH)
  // DH1 = DH(IKa, SPKb)
  const aliceIdentityKX = ed25519skToX25519(aliceIdentityKeyPair.privateKey);
  const dh1 = diffieHellman(aliceIdentityKX, bobBundle.signedPrekey);
  // DH2 = DH(Ek, IKb)
  const dh2 = diffieHellman(aliceEphemeral.privateKey, bobIdentityKX);
  // DH3 = DH(Ek, SPKb)
  const dh3 = diffieHellman(aliceEphemeral.privateKey, bobBundle.signedPrekey);
  
  let dh4: Uint8Array | null = null;
  if (bobBundle.oneTimePrekey) {
    // DH4 = DH(Ek, OPKb)
    dh4 = diffieHellman(aliceEphemeral.privateKey, bobBundle.oneTimePrekey);
  }

  // 4. PQ Handshake (ML-KEM)
  // Use PQOPK if available, otherwise PQSPK
  const targetPQKey = bobBundle.pqOneTimePrekey || bobBundle.pqSignedPrekey;
  const { sharedSecret: pqSecret, ciphertext: pqCiphertext } = pqEncapsulate(targetPQKey);

  // 5. Combine secrets using HKDF
  const combined = new Uint8Array(
    F_CONSTANT.length + dh1.length + dh2.length + dh3.length + (dh4 ? dh4.length : 0) + pqSecret.length
  );
  let offset = 0;
  combined.set(F_CONSTANT, offset); offset += F_CONSTANT.length;
  combined.set(dh1, offset); offset += dh1.length;
  combined.set(dh2, offset); offset += dh2.length;
  combined.set(dh3, offset); offset += dh3.length;
  if (dh4) {
    combined.set(dh4, offset); offset += dh4.length;
  }
  combined.set(pqSecret, offset);

  const sharedSecret = hkdf(combined, new Uint8Array(32), PQXDH_INFO, 32);

  return {
    sharedSecret,
    ephemeralKey: aliceEphemeral.publicKey,
    pqCiphertext,
  };
}

/**
 * Responder (Bob) completes PQXDH handshake using Alice's initial message.
 */
export async function respondToHandshake(
  bobIdentityKeyPair: SignKeyPair & DHKeyPair,
  bobSignedPrekeyPair: DHKeyPair,
  bobOneTimePrekeyPair: DHKeyPair | null,
  bobPQSignedPrekeyPair: PQKeyPair,
  bobPQOneTimePrekeyPair: PQKeyPair | null,
  aliceIdentityPubKey: Uint8Array,
  aliceEphemeralPubKey: Uint8Array,
  alicePQCiphertext?: Uint8Array
): Promise<Uint8Array> {
  // 1. Initial Checks (Usually Bob would verify Alice's IK if this is an established contact)
  // Signal doesn't strictly sign the handshake message from Alice, but Bob needs Alice's IK.
  const aliceIdentityKX = ed25519ToX25519(aliceIdentityPubKey);
  const bobIdentityKX = ed25519skToX25519(bobIdentityKeyPair.privateKey);

  // 2. DH Handshake (X3DH / PQXDH)
  // DH1 = DH(SPKb, IKa)
  const dh1 = diffieHellman(bobSignedPrekeyPair.privateKey, aliceIdentityKX);
  // DH2 = DH(IKb, Ek)
  const dh2 = diffieHellman(bobIdentityKX, aliceEphemeralPubKey);
  // DH3 = DH(SPKb, Ek)
  const dh3 = diffieHellman(bobSignedPrekeyPair.privateKey, aliceEphemeralPubKey);

  let dh4: Uint8Array | null = null;
  if (bobOneTimePrekeyPair) {
    dh4 = diffieHellman(bobOneTimePrekeyPair.privateKey, aliceEphemeralPubKey);
  }

  // 2. PQ Handshake Completion
  let pqSecret: Uint8Array;
  if (alicePQCiphertext) {
    const targetPQKeyPair = bobPQOneTimePrekeyPair || bobPQSignedPrekeyPair;
    pqSecret = pqDecapsulate(alicePQCiphertext, targetPQKeyPair.privateKey);
  } else {
    throw new Error("PQ ciphertext required for PQXDH");
  }

  // 3. Combine secrets
  const combined = new Uint8Array(
    F_CONSTANT.length + dh1.length + dh2.length + dh3.length + (dh4 ? dh4.length : 0) + pqSecret.length
  );
  let offset = 0;
  combined.set(F_CONSTANT, offset); offset += F_CONSTANT.length;
  combined.set(dh1, offset); offset += dh1.length;
  combined.set(dh2, offset); offset += dh2.length;
  combined.set(dh3, offset); offset += dh3.length;
  if (dh4) {
    combined.set(dh4, offset); offset += dh4.length;
  }
  combined.set(pqSecret, offset);

  return hkdf(combined, new Uint8Array(32), PQXDH_INFO, 32);
}

// ─── Double Ratchet ─────────────────────────────────────────────────────────

const MAX_SKIP = 1000;

/**
 * Skipped message keys are retained only long enough to absorb realistic
 * out-of-order/offline delivery. Evicting older entries bounds the window in
 * which a compromised device leaks past plaintext (H3 — forward secrecy).
 */
const MK_SKIPPED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * KDF_CK constants (Double Ratchet spec §5.2). The spec uses a single-byte
 * constant input to HMAC to derive the next chain key vs. the message key.
 * These values are part of the wire-compatible KDF and MUST match every client.
 */
const KDF_CK_CHAIN_CONSTANT = new Uint8Array([0x01]);   // → next chain key
const KDF_CK_MESSAGE_CONSTANT = new Uint8Array([0x02]); // → message key

interface SkippedKey {
  mk: Uint8Array;
  addedAt: number;
}

export interface RatchetState {
  RK: Uint8Array;
  DHs: DHKeyPair;
  DHr: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, SkippedKey>;
  /**
   * Associated data bound into every message AEAD. Per Signal spec this is
   * `Encode(IK_A) || Encode(IK_B)` (M4), preventing identity-key substitution.
   */
  AD: Uint8Array;
}

/**
 * KDF_RK(rk, dh_out) returns [newRK, newCK]
 */
function KDF_RK(rk: Uint8Array, dh_out: Uint8Array): [Uint8Array, Uint8Array] {
  const output = hkdf(dh_out, rk, "DoubleRatchet_Root", 64);
  return [output.subarray(0, 32), output.subarray(32, 64)];
}

/**
 * KDF_CK(ck) returns [newCK, mk]
 */
function KDF_CK(ck: Uint8Array): [Uint8Array, Uint8Array] {
  // Use internal SHA256 HMAC for chain ratchets
  const ck_next = hmac_sha256(ck, KDF_CK_CHAIN_CONSTANT);
  const mk = hmac_sha256(ck, KDF_CK_MESSAGE_CONSTANT);
  return [ck_next, mk];
}

/**
 * Expand a 32-byte Double Ratchet message key into a 64-byte AES-256-SIV key
 * (C1). The raw `mk` is HMAC-SHA256 output (32 bytes) which, passed directly to
 * AES-SIV, would silently select AES-128. HKDF expansion restores AES-256.
 */
function deriveAeadKey(mk: Uint8Array): Uint8Array {
  return hkdf(mk, new Uint8Array(0), AEAD_KDF_INFO, AEAD_KEY_LEN);
}

const cloneBytes = (b: Uint8Array): Uint8Array => Uint8Array.prototype.slice.call(b);
const cloneNullable = (b: Uint8Array | null): Uint8Array | null => (b ? cloneBytes(b) : null);

export class DoubleRatchet {
  private state: RatchetState;

  // H2: serialize all encrypt/decrypt operations so concurrent calls cannot read
  // the same CKs/CKr before it advances (which would reuse a message key).
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(state: RatchetState) {
    this.state = state;
  }

  /**
   * Alice (Initiator) initialization.
   * @param ad Associated data to bind into every message (IK_A || IK_B). M4.
   */
  static async initiate(
    sharedSecret: Uint8Array,
    bobPublicKey: Uint8Array,
    ad: Uint8Array = new Uint8Array()
  ): Promise<DoubleRatchet> {
    const dhs = generateDHKeyPair();
    const [rk, cks] = KDF_RK(sharedSecret, diffieHellman(dhs.privateKey, bobPublicKey));

    return new DoubleRatchet({
      RK: rk,
      DHs: dhs,
      DHr: bobPublicKey,
      CKs: cks,
      CKr: null,
      Ns: 0,
      Nr: 0,
      PN: 0,
      MKSKIPPED: new Map(),
      AD: cloneBytes(ad),
    });
  }

  /**
   * Bob (Responder) initialization.
   * @param ad Associated data to bind into every message (IK_A || IK_B). M4.
   */
  static async respond(
    sharedSecret: Uint8Array,
    bobDHKeyPair: DHKeyPair,
    ad: Uint8Array = new Uint8Array()
  ): Promise<DoubleRatchet> {
    return new DoubleRatchet({
      RK: sharedSecret,
      DHs: bobDHKeyPair,
      DHr: null,
      CKs: null,
      CKr: null,
      Ns: 0,
      Nr: 0,
      PN: 0,
      MKSKIPPED: new Map(),
      AD: cloneBytes(ad),
    });
  }

  /**
   * Reconstruct a ratchet from previously exported state (H6). Validates and
   * deep-copies so the caller cannot mutate live internal state afterwards.
   */
  static importState(exported: RatchetState): DoubleRatchet {
    if (!exported || !(exported.RK instanceof Uint8Array) || !exported.DHs) {
      throw new Error("Invalid ratchet state");
    }
    const skipped = new Map<string, SkippedKey>();
    for (const [k, v] of exported.MKSKIPPED) {
      skipped.set(k, { mk: cloneBytes(v.mk), addedAt: v.addedAt });
    }
    return new DoubleRatchet({
      RK: cloneBytes(exported.RK),
      DHs: { publicKey: cloneBytes(exported.DHs.publicKey), privateKey: cloneBytes(exported.DHs.privateKey) },
      DHr: cloneNullable(exported.DHr),
      CKs: cloneNullable(exported.CKs),
      CKr: cloneNullable(exported.CKr),
      Ns: exported.Ns,
      Nr: exported.Nr,
      PN: exported.PN,
      MKSKIPPED: skipped,
      AD: cloneBytes(exported.AD ?? new Uint8Array()),
    });
  }

  // H2: chained-promise mutex. Each op waits for the prior op to settle.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Encrypt a message. `ad` overrides the session AD when provided.
   */
  encrypt(plaintext: Uint8Array, ad?: Uint8Array): Promise<MessageEnvelope> {
    return this.enqueue(async () => this._encrypt(plaintext, ad));
  }

  private _encrypt(plaintext: Uint8Array, ad?: Uint8Array): MessageEnvelope {
    this.evictExpiredSkippedKeys();

    const [ck_next, mk] = KDF_CK(this.state.CKs!);
    const header: MessageHeader = {
      dhPublicKey: this.state.DHs.publicKey,
      n: this.state.Ns,
      pn: this.state.PN,
    };

    this.state.CKs = ck_next;
    this.state.Ns++;

    const ciphertext = this.aeadSeal(plaintext, mk, header, ad ?? this.state.AD);

    // Strict deletion of Message Key for Forward Secrecy
    memzero(mk);

    return { header, ciphertext };
  }

  /**
   * Decrypt a message. `ad` overrides the session AD when provided.
   */
  decrypt(envelope: MessageEnvelope, ad?: Uint8Array): Promise<Uint8Array> {
    return this.enqueue(async () => this._decrypt(envelope, ad));
  }

  private _decrypt(envelope: MessageEnvelope, ad?: Uint8Array): Uint8Array {
    this.evictExpiredSkippedKeys();
    const effectiveAd = ad ?? this.state.AD;

    // 1. Try to fetch from skipped keys
    const mkSkipped = this.tryGetSkippedKey(envelope.header);
    if (mkSkipped) {
      const plaintext = this.aeadOpen(envelope, mkSkipped, effectiveAd);
      memzero(mkSkipped);
      return plaintext;
    }

    // 2. Perform DH Ratchet if necessary
    if (this.state.DHr === null || !equals(envelope.header.dhPublicKey, this.state.DHr)) {
      this.skipMessageKeys(envelope.header.pn);
      this.dhRatchet(envelope.header.dhPublicKey);
    }

    // 3. Skip message keys in current chain
    this.skipMessageKeys(envelope.header.n);

    // 4. Symmetric Ratchet
    const [ck_next, mk] = KDF_CK(this.state.CKr!);
    this.state.CKr = ck_next;
    this.state.Nr++;

    const plaintext = this.aeadOpen(envelope, mk, effectiveAd);
    memzero(mk);
    return plaintext;
  }

  private dhRatchet(headerDhPubKey: Uint8Array) {
    this.state.PN = this.state.Ns;
    this.state.Ns = 0;
    this.state.Nr = 0;
    this.state.DHr = headerDhPubKey;

    const [rk1, ckr] = KDF_RK(this.state.RK, diffieHellman(this.state.DHs.privateKey, this.state.DHr));
    this.state.RK = rk1;
    this.state.CKr = ckr;

    this.state.DHs = generateDHKeyPair();
    const [rk2, cks] = KDF_RK(this.state.RK, diffieHellman(this.state.DHs.privateKey, this.state.DHr));
    this.state.RK = rk2;
    this.state.CKs = cks;
  }

  private skipMessageKeys(until: number) {
    if (this.state.Nr + MAX_SKIP < until) {
      throw new Error("Too many skipped messages");
    }
    if (this.state.CKr !== null) {
      while (this.state.Nr < until) {
        const [ck_next, mk] = KDF_CK(this.state.CKr);
        this.state.CKr = ck_next;

        const key = this.getSkippedKeyIdentifier(this.state.DHr!, this.state.Nr);
        this.state.MKSKIPPED.set(key, { mk, addedAt: Date.now() });
        this.state.Nr++;

        if (this.state.MKSKIPPED.size > MAX_SKIP) {
          // Remove and zero oldest key (FIFO)
          const firstKey = this.state.MKSKIPPED.keys().next().value;
          if (firstKey) {
            const old = this.state.MKSKIPPED.get(firstKey);
            if (old) memzero(old.mk);
            this.state.MKSKIPPED.delete(firstKey);
          }
        }
      }
    }
  }

  // H3: drop (and zero) skipped keys older than the TTL.
  private evictExpiredSkippedKeys() {
    const cutoff = Date.now() - MK_SKIPPED_TTL_MS;
    for (const [key, entry] of this.state.MKSKIPPED) {
      if (entry.addedAt < cutoff) {
        memzero(entry.mk);
        this.state.MKSKIPPED.delete(key);
      }
    }
  }

  private tryGetSkippedKey(header: MessageHeader): Uint8Array | undefined {
    const key = this.getSkippedKeyIdentifier(header.dhPublicKey, header.n);
    const entry = this.state.MKSKIPPED.get(key);
    if (entry) {
      this.state.MKSKIPPED.delete(key);
      return entry.mk;
    }
    return undefined;
  }

  private aeadSeal(
    plaintext: Uint8Array,
    mk: Uint8Array,
    header: MessageHeader,
    ad: Uint8Array
  ): Uint8Array {
    const combinedAD = this.buildAd(header, ad);
    const aeadKey = deriveAeadKey(mk);
    try {
      return encryptSiv(plaintext, aeadKey, [combinedAD]);
    } finally {
      memzero(aeadKey);
    }
  }

  private aeadOpen(envelope: MessageEnvelope, mk: Uint8Array, ad: Uint8Array): Uint8Array {
    const combinedAD = this.buildAd(envelope.header, ad);
    const aeadKey = deriveAeadKey(mk);
    try {
      return decryptSiv(envelope.ciphertext, aeadKey, [combinedAD]);
    } finally {
      memzero(aeadKey);
    }
  }

  private buildAd(header: MessageHeader, ad: Uint8Array): Uint8Array {
    const headerSerialized = this.serializeHeader(header);
    const combinedAD = new Uint8Array(ad.length + headerSerialized.length);
    combinedAD.set(ad);
    combinedAD.set(headerSerialized, ad.length);
    return combinedAD;
  }

  private serializeHeader(header: MessageHeader): Uint8Array {
    return encodeHeader(header);
  }

  private getSkippedKeyIdentifier(pubKey: Uint8Array, n: number): string {
    return `${Buffer.from(pubKey).toString('hex')}:${n}`;
  }

  /**
   * Export a deep copy of the ratchet state (H6). Callers receive owned buffers
   * and cannot mutate live internal state. Should be encrypted with a
   * PIN/Bio-derived key before being persisted.
   */
  exportState(): RatchetState {
    const skipped = new Map<string, SkippedKey>();
    for (const [k, v] of this.state.MKSKIPPED) {
      skipped.set(k, { mk: cloneBytes(v.mk), addedAt: v.addedAt });
    }
    return {
      RK: cloneBytes(this.state.RK),
      DHs: { publicKey: cloneBytes(this.state.DHs.publicKey), privateKey: cloneBytes(this.state.DHs.privateKey) },
      DHr: cloneNullable(this.state.DHr),
      CKs: cloneNullable(this.state.CKs),
      CKr: cloneNullable(this.state.CKr),
      Ns: this.state.Ns,
      Nr: this.state.Nr,
      PN: this.state.PN,
      MKSKIPPED: skipped,
      AD: cloneBytes(this.state.AD),
    };
  }

  /**
   * Zeroize all secret material and clear skipped keys (H7). The instance must
   * not be used after disposal.
   */
  dispose(): void {
    memzero(this.state.RK);
    memzero(this.state.DHs.privateKey);
    if (this.state.CKs) memzero(this.state.CKs);
    if (this.state.CKr) memzero(this.state.CKr);
    for (const entry of this.state.MKSKIPPED.values()) {
      memzero(entry.mk);
    }
    this.state.MKSKIPPED.clear();
  }
}
