import { EventEmitter } from "node:events";
import {
  QLEDGER_MAX_BATCH_ENTRIES,
  QledgerLedger,
  executeQledger,
  inboxRangeHash,
  planQledgerBatch,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { toHex } from "../core/util.js";
import type { BatchInfo, L1Backend } from "../l1/types.js";
import { LiveL1 } from "../l1/live.js";

interface Settled {
  stateRoot: string;
  ledger: QledgerLedger;
  withdrawals: QledgerWithdrawal[];
}

/**
 * The batch submitter. Every few seconds it takes up to 64 inbox entries,
 * executes them with the chain's qledger-v1 rules and submits an ML-DSA-87
 * anchored settlement batch with the new state root and withdrawals root.
 *
 * `evilNext` makes the NEXT batch lie: it mints balance to a thief account.
 * That is what the watchtower must catch on stage.
 */
export class Operator extends EventEmitter {
  private settled = new Map<number, Settled>();
  private busy = false;
  private paidOut = new Set<string>();
  evilNext = false;
  evilAmount = 50_000_000n; // 50 QOR

  constructor(private l1: L1Backend, private thiefAccount: Uint8Array) {
    super();
  }

  private get env() {
    return { chainId: this.l1.chainId, rollupId: this.l1.rollupId };
  }

  withdrawalsOf(index: number) {
    return this.settled.get(index)?.withdrawals ?? [];
  }

  /** The state after the latest batch the chain still accepts. */
  private parentState(batches: BatchInfo[]): { index: number; ledger: QledgerLedger } {
    const accepted = batches.filter((b) => b.status !== "rejected");
    // forget anything the chain rejected
    for (const b of batches)
      if (b.status === "rejected" && this.settled.get(b.index)?.stateRoot === b.stateRoot) this.settled.delete(b.index);
    const last = accepted[accepted.length - 1];
    if (!last) return { index: 0, ledger: new QledgerLedger() };
    const s = this.settled.get(last.index);
    if (!s || s.stateRoot !== last.stateRoot)
      throw new Error(`no local state for batch ${last.index}: restart with an empty rollup or resync`);
    return { index: last.index + 1, ledger: s.ledger };
  }

  async step() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.payFinalizedWithdrawals();
      const batches = await this.l1.batches();
      const { index, ledger } = this.parentState(batches);
      const { head, consumed } = await this.l1.inbox();
      if (head <= consumed) return;

      let stateRoot: Uint8Array, next: QledgerLedger, withdrawals: QledgerWithdrawal[];
      let input: Parameters<L1Backend["submitBatch"]>[0];
      if (this.l1 instanceof LiveL1) {
        const plan = await planQledgerBatch(this.l1.rdk.rest, {
          ...this.env,
          submitter: this.l1.operator,
          ledger: ledger.clone(),
        });
        input = plan.input;
        next = plan.ledger;
        stateRoot = plan.input.stateRoot;
        withdrawals = plan.result.withdrawals;
      } else {
        const end = Math.min(head, consumed + QLEDGER_MAX_BATCH_ENTRIES);
        const entries = await this.l1.entries(consumed, end);
        next = ledger.clone();
        const result = executeQledger(this.env, next, entries);
        stateRoot = result.stateRoot;
        withdrawals = result.withdrawals;
        const dataHash = inboxRangeHash({
          ...this.env,
          from: consumed,
          to: end,
          accFrom: await this.l1.accAt(consumed),
          accTo: await this.l1.accAt(end),
        });
        input = {
          batchIndex: BigInt(index),
          prevStateRoot: ledger.root(),
          stateRoot,
          txCount: BigInt(entries.length),
          dataHash,
          withdrawalsRoot: result.withdrawalsRoot,
          inboxEnd: BigInt(end),
        };
      }

      let evil = false;
      if (this.evilNext) {
        this.evilNext = false;
        evil = true;
        const cur = next.get(this.thiefAccount);
        next = next.clone();
        next.set(this.thiefAccount, cur.balance + this.evilAmount, cur.nonce);
        stateRoot = next.root();
        input = { ...input, stateRoot };
      }

      const { ref } = await this.l1.submitBatch(input);
      this.settled.set(Number(input.batchIndex), { stateRoot: toHex(stateRoot), ledger: next, withdrawals });
      this.emit("batch", {
        index: Number(input.batchIndex),
        txCount: Number(input.txCount),
        stateRoot: toHex(stateRoot),
        withdrawals: withdrawals.length,
        evil,
        stolen: evil ? this.evilAmount : 0n,
        ref,
        link: this.l1.explorerLink(ref),
      });
    } catch (e) {
      this.emit("warn", { where: "operator", message: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  /** Relayer duty: once a batch is final, pay its withdrawals on L1. */
  private async payFinalizedWithdrawals() {
    const batches = await this.l1.batches();
    for (const b of batches) {
      if (b.status !== "finalized") continue;
      const s = this.settled.get(b.index);
      if (!s || s.stateRoot !== b.stateRoot) continue;
      for (const w of s.withdrawals) {
        const key = `${b.index}:${w.index}`;
        if (this.paidOut.has(key)) continue;
        try {
          const { ref } = await this.l1.executeWithdrawal(b.index, w, s.withdrawals);
          this.paidOut.add(key);
          this.emit("withdrawal", { batchIndex: b.index, recipient: w.recipient, amount: w.amount, ref, link: this.l1.explorerLink(ref) });
        } catch (e) {
          this.emit("warn", { where: "withdrawal", message: (e as Error).message });
        }
      }
    }
  }
}
