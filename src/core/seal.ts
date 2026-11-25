import { openEnvelope, sealEnvelope } from "@qorechain/rdk";
import { rollupEnv } from "./config.js";
import { fromB64, fromHex, fromUtf8, jsonStringify, toB64, utf8 } from "./util.js";

/**
 * ML-KEM-1024 sealing of request and response bodies, using the same envelope
 * format QoreChain private rollups use (bound to chain id + rollup id).
 * Nobody but the named recipient (not the facilitator, not the operator,
 * not anyone who later breaks classical crypto) can read the payload.
 */
export interface Recipient {
  member: string; // qor1 address
  kemKey: string; // hex ML-KEM-1024 encapsulation key
}

export function sealJson(to: Recipient, value: unknown): string {
  const env = sealEnvelope({
    ...rollupEnv(),
    epoch: 0,
    recipients: [{ member: to.member, encapsulationKey: fromHex(to.kemKey) }],
    plaintext: utf8(jsonStringify(value)),
  });
  return toB64(env);
}

export function openJson<T = any>(member: string, secretKey: Uint8Array, sealedB64: string): T {
  const plain = openEnvelope({
    envelope: fromB64(sealedB64),
    ...rollupEnv(),
    member,
    decapsulationKey: secretKey,
  });
  return JSON.parse(fromUtf8(plain)) as T;
}
