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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HandshakeBundle {
  identityKey: Uint8Array;
  signedPrekey: Uint8Array;
  pqSignedPrekey: Uint8Array;
  signature: Uint8Array;
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
  // 1. Verify Bob's signature on SPKb by IKb
  const isValid = verify(bobBundle.signedPrekey, bobBundle.signature, bobBundle.identityKey);
  if (!isValid) throw new Error("Invalid bundle signature");

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
    dh1.length + dh2.length + dh3.length + (dh4 ? dh4.length : 0) + pqSecret.length
  );
  let offset = 0;
  combined.set(dh1, offset); offset += dh1.length;
  combined.set(dh2, offset); offset += dh2.length;
  combined.set(dh3, offset); offset += dh3.length;
  if (dh4) {
    combined.set(dh4, offset); offset += dh4.length;
  }
  combined.set(pqSecret, offset);

  const sharedSecret = hkdf(combined, new Uint8Array(32), "PQXDH_Shared_Secret", 32);

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
    dh1.length + dh2.length + dh3.length + (dh4 ? dh4.length : 0) + pqSecret.length
  );
  let offset = 0;
  combined.set(dh1, offset); offset += dh1.length;
  combined.set(dh2, offset); offset += dh2.length;
  combined.set(dh3, offset); offset += dh3.length;
  if (dh4) {
    combined.set(dh4, offset); offset += dh4.length;
  }
  combined.set(pqSecret, offset);

  return hkdf(combined, new Uint8Array(32), "PQXDH_Shared_Secret", 32);
}

// ─── Double Ratchet ─────────────────────────────────────────────────────────

const MAX_SKIP = 1000;

export interface RatchetState {
  RK: Uint8Array;
  DHs: DHKeyPair;
  DHr: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, Uint8Array>;
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
  const ck_next = hmac_sha256(ck, new Uint8Array([0x01]));
  const mk = hmac_sha256(ck, new Uint8Array([0x02]));
  return [ck_next, mk];
}

export class DoubleRatchet {
  private state: RatchetState;

  constructor(state: RatchetState) {
    this.state = state;
  }

  /**
   * Alice (Initiator) initialization
   */
  static async initiate(sharedSecret: Uint8Array, bobPublicKey: Uint8Array): Promise<DoubleRatchet> {
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
    });
  }

  /**
   * Bob (Responder) initialization
   */
  static async respond(sharedSecret: Uint8Array, bobDHKeyPair: DHKeyPair): Promise<DoubleRatchet> {
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
    });
  }

  /**
   * Encrypt a message
   */
  async encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array()): Promise<MessageEnvelope> {
    const [ck_next, mk] = KDF_CK(this.state.CKs!);
    const header: MessageHeader = {
      dhPublicKey: this.state.DHs.publicKey,
      n: this.state.Ns,
      pn: this.state.PN,
    };
    
    this.state.CKs = ck_next;
    this.state.Ns++;

    const headerSerialized = this.serializeHeader(header);
    const combinedAD = new Uint8Array(ad.length + headerSerialized.length);
    combinedAD.set(ad);
    combinedAD.set(headerSerialized, ad.length);

    const ciphertext = encryptSiv(plaintext, mk, [combinedAD]);
    
    // Strict deletion of Message Key for Forward Secrecy
    memzero(mk);

    return { header, ciphertext };
  }

  /**
   * Decrypt a message
   */
  async decrypt(envelope: MessageEnvelope, ad: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    // 1. Try to fetch from skipped keys
    const mkSkipped = this.tryGetSkippedKey(envelope.header);
    if (mkSkipped) {
      const plaintext = this.decryptWithKey(envelope, mkSkipped, ad);
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

    const plaintext = this.decryptWithKey(envelope, mk, ad);
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
        this.state.MKSKIPPED.set(key, mk);
        this.state.Nr++;

        if (this.state.MKSKIPPED.size > MAX_SKIP) {
          // Remove and zero oldest key (FIFO)
          const firstKey = this.state.MKSKIPPED.keys().next().value;
          if (firstKey) {
            const oldMk = this.state.MKSKIPPED.get(firstKey);
            if (oldMk) memzero(oldMk);
            this.state.MKSKIPPED.delete(firstKey);
          }
        }
      }
    }
  }

  private tryGetSkippedKey(header: MessageHeader): Uint8Array | undefined {
    const key = this.getSkippedKeyIdentifier(header.dhPublicKey, header.n);
    const mk = this.state.MKSKIPPED.get(key);
    if (mk) {
      this.state.MKSKIPPED.delete(key);
    }
    return mk;
  }

  private decryptWithKey(envelope: MessageEnvelope, mk: Uint8Array, ad: Uint8Array): Uint8Array {
    const headerSerialized = this.serializeHeader(envelope.header);
    const combinedAD = new Uint8Array(ad.length + headerSerialized.length);
    combinedAD.set(ad);
    combinedAD.set(headerSerialized, ad.length);

    return decryptSiv(envelope.ciphertext, mk, [combinedAD]);
  }

  private serializeHeader(header: MessageHeader): Uint8Array {
    return encodeHeader(header);
  }

  private getSkippedKeyIdentifier(pubKey: Uint8Array, n: number): string {
    return `${Buffer.from(pubKey).toString('hex')}:${n}`;
  }

  /**
   * Export state (should be encrypted with a PIN/Bio-key before storage)
   */
  exportState() {
    return {
      RK: this.state.RK,
      DHs: this.state.DHs,
      DHr: this.state.DHr,
      CKs: this.state.CKs,
      CKr: this.state.CKr,
      Ns: this.state.Ns,
      Nr: this.state.Nr,
      PN: this.state.PN,
      MKSKIPPED: this.state.MKSKIPPED,
    };
  }
}
