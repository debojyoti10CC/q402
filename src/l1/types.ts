import type { QledgerEntry, QledgerWithdrawal } from "@qorechain/rdk";

export type BatchStatus = "submitted" | "challenged" | "rejected" | "finalized";

export interface BatchInfo {
  index: number;
  prevStateRoot: string;
  stateRoot: string;
  withdrawalsRoot: string;
  txCount: number;
  /** Inbox range consumed: posts inboxStart+1 .. inboxEnd */
  inboxStart: number;
  inboxEnd: number;
  status: BatchStatus;
  submitter: string;
  /** Unix ms when the challenge window closes (mock) or 0 when unknown (live) */
  challengeDeadlineMs: number;
}

export interface InboxEntry extends QledgerEntry {
  seq: number;
}

export interface SubmitBatch {
  batchIndex: bigint;
  prevStateRoot: Uint8Array;
  stateRoot: Uint8Array;
  txCount: bigint;
  dataHash: Uint8Array;
  withdrawalsRoot: Uint8Array;
  inboxEnd: bigint;
}

/**
 * Everything Q402 needs from the settlement layer. Two implementations:
 * MockL1 (in memory, runs the chain's own qledger rules from the RDK) and
 * LiveL1 (QoreChain testnet through the RDK).
 */
export interface L1Backend {
  readonly mode: "mock" | "live";
  readonly chainId: string;
  readonly rollupId: string;
  /** The operator account (poster, batch submitter, challenger in this demo). */
  readonly operator: string;

  postData(payload: Uint8Array): Promise<{ ref: string }>;
  deposit(account: Uint8Array, amount: bigint): Promise<{ ref: string }>;
  inbox(): Promise<{ head: number; consumed: number }>;
  /** Inbox entries from+1 .. to, in order. */
  entries(from: number, to: number): Promise<InboxEntry[]>;
  /** Inbox accumulator after post `seq` (32 zero bytes for 0). */
  accAt(seq: number): Promise<Uint8Array>;
  submitBatch(b: SubmitBatch): Promise<{ ref: string }>;
  batches(): Promise<BatchInfo[]>;
  challenge(batchIndex: number, proof: Uint8Array): Promise<{ ref: string; upheld: boolean }>;
  /**
   * Pay withdrawal `w` of a finalized batch. `all` is the batch's full
   * withdrawal list, used to build the Merkle proof.
   */
  executeWithdrawal(batchIndex: number, w: QledgerWithdrawal, all: QledgerWithdrawal[]): Promise<{ ref: string }>;
  /** A settlement receipt for a finalized, anchored batch. */
  receipt(batchIndex: number): Promise<unknown>;
  /** L1 balance of a qor1 address, in uqor (mock tracks withdrawals only). */
  l1Balance(address: string): Promise<bigint>;
  explorerLink(ref: string): string | undefined;
}
