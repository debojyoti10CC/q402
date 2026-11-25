import { EventEmitter } from "node:events";
import {
  EMPTY_INBOX_ACC,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QLEDGER_MAX_BATCH_ENTRIES,
  checkQledgerFraud,
  encodeQledgerDeposit,
  inboxRangeHash,
  postedDataHash,
  inboxAccumulate,
  qledgerEmptyRoot,
  qledgerWithdrawalsRoot,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { sha256Hex, toHex } from "../core/util.js";
import type { BatchInfo, InboxEntry, L1Backend, SubmitBatch } from "./types.js";

interface StoredBatch extends BatchInfo {
  dataHash: string;
}

/**
 * An in-memory stand-in for QoreChain's `rdk` module, for laptop demos and
 * tests. It is NOT a toy: inbox accumulators, range commitments and fraud
 * decisions use the RDK functions that reproduce the chain's own code
 * (`inboxAccumulate`, `inboxRangeHash`, `checkQledgerFraud`). What it skips:
 * consensus, fees, bonds and real ML-DSA-87 anchoring.
 */
export class MockL1 extends EventEmitter implements L1Backend {
  readonly mode = "mock" as const;
  readonly operator: string;
  private height = 1;
  private posts: InboxEntry[] = [];
  private accs: Uint8Array[] = [EMPTY_INBOX_ACC];
  private consumed = 0;
  /** Live batches: list[i].index === i. */
  private list: StoredBatch[] = [];
  /** Batches the chain rejected (kept for display). */
  private rejected: StoredBatch[] = [];
  private paid = new Set<string>();
  private balances = new Map<string, bigint>();
  escrow = 0n;

  constructor(
    readonly chainId: string,
    readonly rollupId: string,
    operator: string,
    private windowMs: number,
  ) {
    super();
    this.operator = operator;
    setInterval(() => this.tick(), 500).unref();
  }

  private ref(kind: string) {
    this.height += 1;
    return `mock-${kind}-${this.height}`;
  }

  private append(poster: string, payload: Uint8Array) {
    const seq = this.posts.length + 1;
    const height = BigInt(this.height);
    const acc = inboxAccumulate({
      chainId: this.chainId,
      rollupId: this.rollupId,
      prevAcc: this.accs[seq - 1],
      sequence: seq,
      height,
      poster,
      dataHash: postedDataHash(payload),
    });
    const e: InboxEntry = { seq, height, poster, payload };
    this.posts.push(e);
    this.accs.push(acc);
    this.emit("post", e);
    return seq;
  }

  async postData(payload: Uint8Array) {
    const ref = this.ref("post");
    this.append(this.operator, payload);
    return { ref };
  }

  async deposit(account: Uint8Array, amount: bigint) {
    const ref = this.ref("deposit");
    this.escrow += amount;
    this.append(QLEDGER_DEPOSIT_POSTER_PREFIX + this.operator, encodeQledgerDeposit(account, amount));
    return { ref };
  }

  async inbox() {
    return { head: this.posts.length, consumed: this.consumed };
  }

  async entries(from: number, to: number) {
    return this.posts.slice(from, to);
  }

  async accAt(seq: number) {
    return this.accs[seq];
  }

  private lastAccepted(): StoredBatch | undefined {
    return this.list[this.list.length - 1];
  }

  async submitBatch(b: SubmitBatch) {
    const expectedIndex = this.list.length;
    if (Number(b.batchIndex) !== expectedIndex) throw new Error(`batch index ${b.batchIndex}, expected ${expectedIndex}`);
    const parent = this.lastAccepted();
    const parentRoot = parent ? parent.stateRoot : toHex(qledgerEmptyRoot());
    if (toHex(b.prevStateRoot) !== parentRoot) throw new Error("prev_state_root does not match the latest batch");
    const end = Number(b.inboxEnd);
    if (end <= this.consumed || end > this.posts.length) throw new Error("inbox_end out of range");
    if (end - this.consumed > QLEDGER_MAX_BATCH_ENTRIES) throw new Error("batch consumes too many entries");
    const range = inboxRangeHash({
      chainId: this.chainId,
      rollupId: this.rollupId,
      from: this.consumed,
      to: end,
      accFrom: this.accs[this.consumed],
      accTo: this.accs[end],
    });
    if (toHex(range) !== toHex(b.dataHash)) throw new Error("data_hash is not the inbox range commitment");
    const ref = this.ref("batch");
    const batch: StoredBatch = {
      index: this.list.length,
      prevStateRoot: parentRoot,
      stateRoot: toHex(b.stateRoot),
      withdrawalsRoot: toHex(b.withdrawalsRoot),
      txCount: Number(b.txCount),
      inboxStart: this.consumed,
      inboxEnd: end,
      dataHash: toHex(b.dataHash),
      status: "submitted",
      submitter: this.operator,
      challengeDeadlineMs: Date.now() + this.windowMs,
    };
    this.list.push(batch);
    this.consumed = end;
    this.emit("batch", batch);
    return { ref };
  }

  async batches() {
    return [...this.rejected, ...this.list]
      .map((b) => ({ ...b }))
      .sort((a, b) => a.index - b.index || (a.status === "rejected" ? -1 : 1));
  }

  async challenge(batchIndex: number, proof: Uint8Array) {
    const b = this.list[batchIndex];
    if (!b || b.status !== "submitted") throw new Error(`batch ${batchIndex} is not open to challenge`);
    if (Date.now() > b.challengeDeadlineMs) throw new Error("challenge window closed");
    const ref = this.ref("challenge");
    const upheld = checkQledgerFraud(
      { chainId: this.chainId, rollupId: this.rollupId },
      {
        inboxStart: b.inboxStart,
        inboxEnd: b.inboxEnd,
        dataHash: b.dataHash,
        prevStateRoot: b.prevStateRoot,
        stateRoot: b.stateRoot,
        withdrawalsRoot: b.withdrawalsRoot,
      },
      proof,
    );
    if (upheld) {
      // The chain rejects the batch and every later one, and the inbox is
      // consumed again from the rejected batch's start.
      const dropped = this.list.splice(batchIndex);
      for (const x of dropped) x.status = "rejected";
      this.rejected.push(...dropped);
      this.consumed = b.inboxStart;
    }
    this.emit("challenge", { batchIndex, upheld });
    return { ref, upheld };
  }

  private tick() {
    const now = Date.now();
    // In-order finality: a batch finalizes only after every earlier one.
    for (const b of this.list) {
      if (b.status === "rejected" || b.status === "finalized") continue;
      if (b.status === "submitted" && now >= b.challengeDeadlineMs) {
        b.status = "finalized";
        this.emit("finalized", b);
        continue;
      }
      break;
    }
  }

  async executeWithdrawal(batchIndex: number, w: QledgerWithdrawal, all: QledgerWithdrawal[]) {
    const b = this.list[batchIndex];
    if (!b || b.status !== "finalized") throw new Error(`batch ${batchIndex} is not finalized`);
    // Mock simplification: check the full list against the batch's root
    // (the chain checks a Merkle path instead; LiveL1 sends that path).
    const root = toHex(qledgerWithdrawalsRoot(this.chainId, this.rollupId, all));
    if (root !== b.withdrawalsRoot) throw new Error("withdrawal list does not match the batch's withdrawals root");
    if (!all.some((x) => x.index === w.index && x.recipient === w.recipient && x.amount === w.amount))
      throw new Error("withdrawal is not in the batch");
    const key = `${w.index}`;
    if (this.paid.has(key)) throw new Error("withdrawal already paid");
    if (this.escrow < w.amount) throw new Error("escrow too low");
    this.paid.add(key);
    this.escrow -= w.amount;
    this.balances.set(w.recipient, (this.balances.get(w.recipient) ?? 0n) + w.amount);
    const ref = this.ref("withdraw");
    this.emit("withdrawal", { batchIndex, ...w });
    return { ref };
  }

  async receipt(batchIndex: number) {
    const b = this.list[batchIndex];
    if (!b) throw new Error("no such batch");
    return {
      kind: "mock-settlement-receipt",
      note: "Mock mode: on testnet this is buildSettlementReceipt() from @qorechain/rdk, an ML-DSA-87 anchored receipt verified against live chain state.",
      chainId: this.chainId,
      rollupId: this.rollupId,
      batchIndex: b.index,
      status: b.status,
      stateRoot: b.stateRoot,
      withdrawalsRoot: b.withdrawalsRoot,
      inboxRange: [b.inboxStart, b.inboxEnd],
      digest: sha256Hex(new TextEncoder().encode(`${this.chainId}|${this.rollupId}|${b.index}|${b.stateRoot}`)),
    };
  }

  async l1Balance(address: string) {
    return this.balances.get(address) ?? 0n;
  }

  explorerLink() {
    return undefined;
  }
}
