import protobuf from "protobufjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.join(__dirname, "envelope.proto");
const root = protobuf.loadSync(protoPath);

export const ProtoMessageHeader = root.lookupType("e2ee.MessageHeader");
export const ProtoMessageEnvelope = root.lookupType("e2ee.MessageEnvelope");

export interface MessageHeader {
  dhPublicKey: Uint8Array;
  n: number;  // Message index in current ratchet
  pn: number; // Previous ratchet length
}

export interface MessageEnvelope {
  header: MessageHeader;
  ciphertext: Uint8Array; // AES-SIV encrypted payload
}

export function encodeHeader(header: MessageHeader): Uint8Array {
  const payload = {
    dhPublicKey: header.dhPublicKey,
    n: header.n,
    pn: header.pn,
  };
  const message = ProtoMessageHeader.create(payload);
  return ProtoMessageHeader.encode(message).finish();
}

export function decodeHeader(data: Uint8Array): MessageHeader {
  const message = ProtoMessageHeader.decode(data);
  const obj = ProtoMessageHeader.toObject(message, {
    bytes: Uint8Array,
  });
  return {
    dhPublicKey: obj.dhPublicKey,
    n: obj.n,
    pn: obj.pn,
  };
}

export function encodeEnvelope(envelope: MessageEnvelope): Uint8Array {
  const payload = {
    header: {
      dhPublicKey: envelope.header.dhPublicKey,
      n: envelope.header.n,
      pn: envelope.header.pn,
    },
    ciphertext: envelope.ciphertext,
  };
  const message = ProtoMessageEnvelope.create(payload);
  return ProtoMessageEnvelope.encode(message).finish();
}

export function decodeEnvelope(data: Uint8Array): MessageEnvelope {
  const message = ProtoMessageEnvelope.decode(data);
  const obj = ProtoMessageEnvelope.toObject(message, {
    bytes: Uint8Array,
  });
  return {
    header: {
      dhPublicKey: obj.header.dhPublicKey,
      n: obj.header.n,
      pn: obj.header.pn,
    },
    ciphertext: obj.ciphertext,
  };
}
