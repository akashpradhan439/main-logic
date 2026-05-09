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
}

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

  if (envelope.bootstrap) {
    payload.bootstrap = {
      senderIdentityKey:  envelope.bootstrap.senderIdentityKey,
      senderEphemeralKey: envelope.bootstrap.senderEphemeralKey,
      pqCiphertext:       envelope.bootstrap.pqCiphertext,
      signedPrekeyId:     envelope.bootstrap.signedPrekeyId,
      pqSignedPrekeyId:   envelope.bootstrap.pqSignedPrekeyId,
    };
  }

  const message = ProtoMessageEnvelope.create(payload);
  return ProtoMessageEnvelope.encode(message).finish();
}

export function decodeEnvelope(data: Uint8Array): MessageEnvelope {
  const message = ProtoMessageEnvelope.decode(data);
  const obj = ProtoMessageEnvelope.toObject(message, { bytes: Uint8Array });

  const envelope: MessageEnvelope = {
    header: {
      dhPublicKey: obj.header.dhPublicKey,
      n: obj.header.n,
      pn: obj.header.pn,
    },
    ciphertext: obj.ciphertext,
  };

  if (obj.bootstrap?.senderIdentityKey?.length) {
    envelope.bootstrap = {
      senderIdentityKey:  obj.bootstrap.senderIdentityKey,
      senderEphemeralKey: obj.bootstrap.senderEphemeralKey,
      pqCiphertext:       obj.bootstrap.pqCiphertext,
      signedPrekeyId:     obj.bootstrap.signedPrekeyId,
      pqSignedPrekeyId:   obj.bootstrap.pqSignedPrekeyId,
    };
  }

  return envelope;
}
