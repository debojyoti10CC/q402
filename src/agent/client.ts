import { encodeQledgerTx, signQledgerTx } from "@qorechain/rdk";
import { devnetUrl, rollupEnv } from "../core/config.js";
import type { Party } from "../core/keys.js";
import { openJson, sealJson } from "../core/seal.js";
import { getJson, postJson, toHex } from "../core/util.js";
import { Q402_VERSION, SCHEME, type PaidResponse, type PaymentRequired, type PaymentRequirements } from "../core/x402.js";

export interface Limits {
  /** Refuse any single call priced above this (uqor). */
  maxPerCall: bigint;
  /** Refuse once this session has spent this much (uqor). */
  sessionBudget: bigint;
}

export interface CallResult {
  resource: string;
  paid: bigint;
  paymentId: string;
  result: unknown;
  ms: number;
}

/**
 * An agent wallet that speaks Q402: it calls an API, reads the 402, checks
 * the price against its limits, signs a qledger-v1 transfer with its
 * ML-DSA-44 key, seals the request to the provider's ML-KEM-1024 key and
 * opens the sealed response.
 */
export class Q402Agent {
  spent = 0n;
  calls = 0;

  constructor(private me: Party, public limits: Limits = { maxPerCall: 100_000n, sessionBudget: 2_000_000n }) {}

  async wallet() {
    return getJson(`${devnetUrl()}/account/${toHex(this.me.ledger.accountId)}`);
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Calls are serialized: each payment needs the next nonce. */
  call(url: string, query: Record<string, unknown>): Promise<CallResult> {
    const run = this.queue.then(() => this.callNow(url, query));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callNow(url: string, query: Record<string, unknown>): Promise<CallResult> {
    const t0 = Date.now();
    const first = await postJson<PaymentRequired>(url, {});
    if (first.status !== 402) throw new Error(`expected 402 from ${url}, got ${first.status}`);
    const req: PaymentRequirements | undefined = first.data.accepts?.find((a) => a.scheme === SCHEME);
    if (!req) throw new Error("provider offers no qledger-exact payment option");
    const env = rollupEnv();
    if (req.network !== env.chainId || req.rollupId !== env.rollupId) throw new Error("provider is on a different rollup");

    const price = BigInt(req.amount);
    if (price > this.limits.maxPerCall) throw new Error(`refused: price ${price} uqor is over the per-call limit ${this.limits.maxPerCall}`);
    if (this.spent + price > this.limits.sessionBudget)
      throw new Error(`refused: session budget ${this.limits.sessionBudget} uqor would be exceeded`);

    const acct = await this.wallet();
    const tx = signQledgerTx({
      ...env,
      secretKey: this.me.ledger.secretKey,
      publicKey: this.me.ledger.publicKey,
      nonce: BigInt(acct.nextNonce),
      amount: price,
      to: req.payTo,
    });

    const paid = await postJson<PaidResponse & { error?: string }>(url, {
      q402Version: Q402_VERSION,
      scheme: SCHEME,
      payment: toHex(encodeQledgerTx(tx)),
      sealedRequest: sealJson(req.seal, query),
      replyTo: { member: this.me.address, kemKey: toHex(this.me.kem.publicKey) },
    });
    if (paid.status !== 200) throw new Error(`payment refused: ${paid.data.error ?? paid.status}`);
    const opened = openJson<{ result: unknown }>(this.me.address, this.me.kem.secretKey, paid.data.sealedResponse);
    this.spent += price;
    this.calls += 1;
    return { resource: req.resource, paid: price, paymentId: paid.data.payment.id, result: opened.result, ms: Date.now() - t0 };
  }
}
