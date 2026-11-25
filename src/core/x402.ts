/**
 * Q402: the x402 "402 Payment Required" flow, adapted to a post-quantum rollup.
 *
 * Differences from x402 on EVM:
 * - the payment is a signed qledger-v1 transfer (ML-DSA-44), not an EIP-3009
 *   authorization;
 * - it travels in the JSON body, not an X-PAYMENT header: a post-quantum
 *   signed transfer is ~3.8 KB and does not fit comfortably in HTTP headers;
 * - request and response are sealed with ML-KEM-1024.
 */
export const Q402_VERSION = 1;
export const SCHEME = "qledger-exact";

export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: string; // chain id
  rollupId: string;
  resource: string;
  description: string;
  /** Price in uqor (rollup L2 balance units). */
  amount: string;
  /** Provider's qledger account id (hex). */
  payTo: string;
  /** Provider's ML-KEM-1024 key, to seal the request to. */
  seal: { member: string; kemKey: string };
  facilitator: string;
}

export interface PaymentRequired {
  q402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

/** What the client sends back. */
export interface PaidRequest {
  q402Version: number;
  scheme: typeof SCHEME;
  /** hex of encodeQledgerTx(signed transfer) */
  payment: string;
  /** base64 ML-KEM envelope of the JSON request, sealed to the provider */
  sealedRequest: string;
  /** where to seal the response */
  replyTo: { member: string; kemKey: string };
}

export interface PaidResponse {
  q402Version: number;
  /** base64 ML-KEM envelope of the JSON response, sealed to the client */
  sealedResponse: string;
  payment: { id: string; amount: string; status: string };
}
