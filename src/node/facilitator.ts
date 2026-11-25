import { EventEmitter } from "node:events";
import {
  QLEDGER_KIND_TRANSFER,
  QLEDGER_KIND_WITHDRAW,
  QledgerLedger,
  decodeQledgerTx,
  executeQledger,
  qledgerAccountId,
  verifyQledgerTx,
  type QledgerTx,
} from "@qorechain/rdk";
import { fromHex, sha256Hex, toHex } from "../core/util.js";
import type { L1Backend } from "../l1/types.js";

interface Pending {
  id: string; // sha256 of the posted bytes
  bytes: Uint8Array;
  from: string; // account id hex
  amount: bigint;
  kind: number;
  posted: boolean;
  ref?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  id?: string;
  from?: string;
  amount?: bigint;
}

/**
 * The x402 "facilitator", for a based qledger-v1 rollup.
 *
 * - verify: checks a signed transfer the way the chain will execute it
 *   (ML-DSA-44 signature bound to this chain + rollup, next nonce, balance
 *   after everything still in flight), so a provider can serve immediately.
 * - settle: queues the transfer and posts it to the rollup inbox on L1. The
 *   facilitator pays the L1 posting fee, so agents never need L1 gas.
 *
 * Its ledger replays every inbox entry in order, which on a based rollup IS
 * the canonical L2 state; batches only commit to it.
 */
export class Facilitator extends EventEmitter {
  private soft = new QledgerLedger();
  private applied = 0;
  private pending: Pending[] = [];
  private posting = false;
  stats = { payments: 0, volume: 0n, rejected: 0 };

  constructor(private l1: L1Backend) {
    super();
  }

  private get env() {
    return { chainId: this.l1.chainId, rollupId: this.l1.rollupId };
  }

  /** Replay new inbox entries into the soft ledger and retire posted items. */
  async sync() {
    const { head } = await this.l1.inbox();
    if (head <= this.applied) return;
    const list = await this.l1.entries(this.applied, head);
    executeQledger(this.env, this.soft, list);
    for (const e of list) {
      const id = sha256Hex(e.payload);
      const i = this.pending.findIndex((p) => p.id === id);
      if (i >= 0) this.pending.splice(i, 1);
      this.emit("included", { seq: e.seq, id });
    }
    this.applied = head;
  }

  /** Balance and next nonce, counting transfers accepted but not yet included. */
  account(idHex: string) {
    const id = fromHex(idHex);
    const base = this.soft.get(id);
    const mine = this.pending.filter((p) => p.from === idHex);
    const out = mine.reduce((s, p) => s + p.amount, 0n);
    const inflow = this.pending
      .filter((p) => p.kind === QLEDGER_KIND_TRANSFER)
      .reduce((s, p) => s + (this.toOf(p) === idHex ? p.amount : 0n), 0n);
    return {
      accountId: idHex,
      confirmedBalance: base.balance,
      confirmedNonce: base.nonce,
      balance: base.balance - out,
      incoming: inflow,
      nextNonce: base.nonce + BigInt(mine.length),
      pending: mine.length,
    };
  }

  private toOf(p: Pending): string | undefined {
    const tx = decodeQledgerTx(p.bytes);
    return tx?.to ? toHex(tx.to) : undefined;
  }

  verify(txHex: string, req?: { payTo: string; amount: bigint }): VerifyResult & { tx?: QledgerTx; bytes?: Uint8Array } {
    let bytes: Uint8Array;
    try {
      bytes = fromHex(txHex);
    } catch {
      return { ok: false, reason: "payment is not hex" };
    }
    const tx = decodeQledgerTx(bytes);
    if (!tx) return { ok: false, reason: "not a well-formed qledger-v1 transaction" };
    if (!verifyQledgerTx(tx, this.l1.chainId, this.l1.rollupId))
      return { ok: false, reason: "ML-DSA-44 signature invalid for this chain and rollup" };
    const from = toHex(qledgerAccountId(tx.publicKey, tx.scheme));
    const id = sha256Hex(bytes);
    if (this.pending.some((p) => p.id === id)) return { ok: false, reason: "duplicate payment" };
    const acct = this.account(from);
    if (tx.nonce !== acct.nextNonce) return { ok: false, reason: `nonce ${tx.nonce}, expected ${acct.nextNonce}` };
    if (tx.amount <= 0n) return { ok: false, reason: "amount must be positive" };
    if (tx.amount > acct.balance) return { ok: false, reason: `insufficient balance (${acct.balance} uqor available)` };
    if (req) {
      if (tx.kind !== QLEDGER_KIND_TRANSFER) return { ok: false, reason: "payment must be a transfer" };
      if (!tx.to || toHex(tx.to) !== req.payTo.toLowerCase()) return { ok: false, reason: "payment goes to the wrong account" };
      if (tx.amount < req.amount) return { ok: false, reason: `underpaid: ${tx.amount} < ${req.amount}` };
    } else if (tx.kind !== QLEDGER_KIND_WITHDRAW && tx.kind !== QLEDGER_KIND_TRANSFER) {
      return { ok: false, reason: "unknown transaction kind" };
    }
    return { ok: true, id, from, amount: tx.amount, tx, bytes };
  }

  /** Verify, then queue for posting. Returns the payment id. */
  settle(txHex: string, req?: { payTo: string; amount: bigint; resource?: string }): VerifyResult {
    const v = this.verify(txHex, req);
    if (!v.ok || !v.bytes || !v.tx) {
      this.stats.rejected += 1;
      this.emit("payment-rejected", { reason: v.reason });
      return { ok: false, reason: v.reason };
    }
    this.pending.push({ id: v.id!, bytes: v.bytes, from: v.from!, amount: v.amount!, kind: v.tx.kind, posted: false });
    if (v.tx.kind === QLEDGER_KIND_TRANSFER) {
      this.stats.payments += 1;
      this.stats.volume += v.amount!;
    }
    this.emit("payment", {
      id: v.id,
      kind: v.tx.kind === QLEDGER_KIND_WITHDRAW ? "withdraw" : "transfer",
      from: v.from,
      to: v.tx.to ? toHex(v.tx.to) : v.tx.recipient,
      amount: v.amount,
      resource: req?.resource,
      bytes: v.bytes.length,
    });
    void this.flush();
    return { ok: true, id: v.id, from: v.from, amount: v.amount };
  }

  /** Post queued transactions to the inbox, one post per transaction, in order. */
  private async flush() {
    if (this.posting) return;
    this.posting = true;
    try {
      for (const p of this.pending) {
        if (p.posted) continue;
        const { ref } = await this.l1.postData(p.bytes);
        p.posted = true;
        p.ref = ref;
        this.emit("posted", { id: p.id, ref, link: this.l1.explorerLink(ref) });
      }
    } catch (e) {
      this.emit("warn", { where: "post", message: (e as Error).message });
    } finally {
      this.posting = false;
    }
    await this.sync();
  }

  snapshot() {
    return {
      applied: this.applied,
      pending: this.pending.map((p) => ({ id: p.id, from: p.from, amount: p.amount, posted: p.posted })),
      stats: this.stats,
    };
  }
}
