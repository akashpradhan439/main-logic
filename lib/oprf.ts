import { Oprf, OPRFServer, EvaluationRequest, randomPrivateKey } from "@cloudflare/voprf-ts";

const SUITE = Oprf.Suite.P256_SHA256;

/**
 * Generates a random 32-byte seed for the server's OPRF key.
 */
export async function generateOprfSeed(): Promise<Uint8Array> {
  return randomPrivateKey(SUITE);
}

/**
 * Evaluates the blinded element sent by the client using the server's OPRF seed.
 * 
 * @param blindedElementBytes The serialized EvaluationRequest from the client
 * @param oprfSeed The server's secret seed for this user
 * @returns The serialized Evaluation to send back to the client
 */
export async function oprfEvaluate(
  blindedElementBytes: Uint8Array,
  oprfSeed: Uint8Array
): Promise<Uint8Array> {
  const server = new OPRFServer(SUITE, oprfSeed);
  const evalReq = EvaluationRequest.deserialize(SUITE, blindedElementBytes);
  const evaluation = await server.blindEvaluate(evalReq);
  return evaluation.serialize();
}
