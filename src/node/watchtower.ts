import { EventEmitter } from "node:events";
import { QledgerLedger, buildQledgerFraudProof, executeQledger } from "@qorechain/rdk";
import { toHex } from "../core/util.js";
import type { L1Backend } from "../l1/types.js";

/**
 * An independent verifier. It keeps its own copy of the L2 state, re-executes
 * every batch from the inbox, and when a batch's published state root or
 * withdrawals root is wrong it sends the chain a fraud proof. The chain
 * re-executes the proof itself (qledger-v1), so the watchtower does not have
 * to be trusted: one honest watchtower is enough.
 */
export class Watchtower extends EventEmitter {
  /** key: `${index}:${stateRoot}` → state after that batch */
  private verified = new Map<string, QledgerLedger>();
  private judged = new Set<string>();
  private busy = false;

  constructor(private l1: L1Backend) {
    super();
  }

  private get env() {
    return { chainId: this.l1.chainId, rollupId: this.l1.rollupId };
  }

  async step() {
    if (this.busy) return;
    this.busy = true;
    try {
      const batches = await this.l1.batches();
      let parent = new QledgerLedger();
      for (const b of batches) {
        if (b.status === "rejected") continue;
        const key = `${b.index}:${b.stateRoot}`;
        const known = this.verified.get(key);
        if (known) {
          parent = known;
          continue;
        }
        if (this.judged.has(key)) break; // already challenged, waiting for the chain
        const entries = await this.l1.entries(b.inboxStart, b.inboxEnd);
        const accFrom = await this.l1.accAt(b.inboxStart);
        const { proof, honest } = buildQledgerFraudProof(this.env, parent.clone(), accFrom, entries);
        const rootOk = toHex(honest.stateRoot) === b.stateRoot;
        const wOk = toHex(honest.withdrawalsRoot) === b.withdrawalsRoot;
        if (rootOk && wOk) {
          const next = parent.clone();
          executeQledger(this.env, next, entries);
          this.verified.set(key, next);
          this.emit("verified", { index: b.index, txCount: b.txCount });
          parent = next;
          continue;
        }
        this.judged.add(key);
        this.emit("fraud", {
          index: b.index,
          published: b.stateRoot,
          correct: toHex(honest.stateRoot),
          withdrawalsOk: wOk,
        });
        if (b.status !== "submitted") break;
        try {
          const { ref, upheld } = await this.l1.challenge(b.index, proof);
          this.emit("challenge", { index: b.index, upheld, ref, link: this.l1.explorerLink(ref) });
        } catch (e) {
          this.emit("warn", { where: "challenge", message: (e as Error).message });
        }
        break;
      }
    } catch (e) {
      this.emit("warn", { where: "watchtower", message: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }
}
