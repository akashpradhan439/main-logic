export interface MessageHeader {
  dhPublicKey: Uint8Array;
  n: number;  // Message index in current ratchet
  pn: number; // Previous ratchet length
}

export interface MessageEnvelope {
  header: MessageHeader;
  ciphertext: Uint8Array; // AES-SIV encrypted payload
}
