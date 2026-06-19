import protobuf from "protobufjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.join(__dirname, "envelope.proto");
const root = protobuf.loadSync(protoPath);

export const ProtoMessageHeader   = root.lookupType("e2ee.MessageHeader");
export const ProtoBootstrapData   = root.lookupType("e2ee.BootstrapData");
export const ProtoMessageEnvelope = root.lookupType("e2ee.MessageEnvelope");

export interface MessageHeader {
  dhPublicKey: Uint8Array;
  n: number;
  pn: number;
}

export interface BootstrapData {
  senderIdentityKey:  Uint8Array;
  senderEphemeralKey: Uint8Array;
  pqCiphertext:       Uint8Array;
  signedPrekeyId:     number;
  pqSignedPrekeyId:   number;
  oneTimePrekeyId?:   number;
  pqOneTimePrekeyId?: number;
}

// Expected key sizes for envelope validation (M9).
const X25519_LEN = 32;          // dh public key, sender ephemeral
const ED25519_PUB_LEN = 32;     // sender identity key (Ed25519, XEdDSA)
const MLKEM768_CT_LEN = 1088;   // ML-KEM-768 ciphertext

export interface MessageEnvelope {
  header:     MessageHeader;
  ciphertext: Uint8Array;
  bootstrap?: BootstrapData;
}

export function encodeHeader(header: MessageHeader): Uint8Array {
  const message = ProtoMessageHeader.create({
    dhPublicKey: header.dhPublicKey,
    n: header.n,
    pn: header.pn,
  });
  return ProtoMessageHeader.encode(message).finish();
}

export function decodeHeader(data: Uint8Array): MessageHeader {
  const message = ProtoMessageHeader.decode(data);
  const obj = ProtoMessageHeader.toObject(message, { bytes: Uint8Array });
  return {
    dhPublicKey: obj.dhPublicKey,
    n: obj.n,
    pn: obj.pn,
  };
}

export function encodeEnvelope(envelope: MessageEnvelope): Uint8Array {
  const payload: Record<string, unknown> = {
    header: {
      dhPublicKey: envelope.header.dhPublicKey,
      n: envelope.header.n,
      pn: envelope.header.pn,
    },
    ciphertext: envelope.ciphertext,
  };

  // M8/#13: Bootstrap data is NOT encoded in protobuf — it's stored separately
  // in the bootstrap_json column. Clients consume the JSON sidecar, not the
  // protobuf field. This avoids dual-storage drift.

  const message = ProtoMessageEnvelope.create(payload);
  return ProtoMessageEnvelope.encode(message).finish();
}

export function decodeEnvelope(data: Uint8Array): MessageEnvelope {
  const message = ProtoMessageEnvelope.decode(data);
  const obj = ProtoMessageEnvelope.toObject(message, { bytes: Uint8Array });

  // M9: validate key/field sizes after decode so malformed payloads fail with a
  // clear typed error rather than a deep throw inside the ratchet/handshake.
  if (!(obj.header?.dhPublicKey instanceof Uint8Array) || obj.header.dhPublicKey.length !== X25519_LEN) {
    throw new Error("Invalid envelope: header.dhPublicKey must be 32 bytes");
  }
  if (!(obj.ciphertext instanceof Uint8Array) || obj.ciphertext.length === 0) {
    throw new Error("Invalid envelope: ciphertext is empty");
  }

  // M8/#13: Bootstrap data is NOT in protobuf — it's in the bootstrap_json column.
  // For backwards compatibility, we still check for it in legacy envelopes.
  const envelope: MessageEnvelope = {
    header: {
      dhPublicKey: obj.header.dhPublicKey,
      n: obj.header.n,
      pn: obj.header.pn,
    },
    ciphertext: obj.ciphertext,
  };

  if (obj.bootstrap?.senderIdentityKey?.length) {
    if (obj.bootstrap.senderIdentityKey.length !== ED25519_PUB_LEN) {
      throw new Error("Invalid envelope: bootstrap.senderIdentityKey must be 32 bytes");
    }
    if (obj.bootstrap.senderEphemeralKey?.length !== X25519_LEN) {
      throw new Error("Invalid envelope: bootstrap.senderEphemeralKey must be 32 bytes");
    }
    if (obj.bootstrap.pqCiphertext?.length !== MLKEM768_CT_LEN) {
      throw new Error("Invalid envelope: bootstrap.pqCiphertext must be 1088 bytes");
    }
    envelope.bootstrap = {
      senderIdentityKey:  obj.bootstrap.senderIdentityKey,
      senderEphemeralKey: obj.bootstrap.senderEphemeralKey,
      pqCiphertext:       obj.bootstrap.pqCiphertext,
      signedPrekeyId:     obj.bootstrap.signedPrekeyId,
      pqSignedPrekeyId:   obj.bootstrap.pqSignedPrekeyId,
      oneTimePrekeyId:    obj.bootstrap.oneTimePrekeyId || 0,
      pqOneTimePrekeyId:  obj.bootstrap.pqOneTimePrekeyId || 0,
    };
  }

  return envelope;
}
