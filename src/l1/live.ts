import {
  EMPTY_INBOX_ACC,
  buildSettlementReceipt,
  createRdkClient,
  fetchQledgerEntries,
  hexToBytes,
  pqcKeypairFromEnv,
  qledgerWithdrawalProof,
  signerFromEnv,
  verifySettlementReceipt,
  type QledgerWithdrawal,
  type RdkClient,
  type RdkTxClient,
} from "@qorechain/rdk";
import { config } from "../core/config.js";
import type { BatchInfo, BatchStatus, InboxEntry, L1Backend, SubmitBatch } from "./types.js";

/**
 * QoreChain testnet through @qorechain/rdk. Every transaction is signed
 * hybrid (secp256k1 + ML-DSA-87), as the chain requires.
 *
 * STATUS: written against the RDK 0.9 API, not yet run end to end: it needs
 * a rollup, which needs the 10,000 test-QOR stake (see README).
 */
export class LiveL1 implements L1Backend {
  readonly mode = "live" as const;
  private constructor(
    readonly chainId: string,
    readonly rollupId: string,
    readonly operator: string,
    private client: RdkClient,
    private tx: RdkTxClient,
  ) {}

  static async connect(): Promise<LiveL1> {
    const client = createRdkClient({ network: "testnet" });
    const signer = await signerFromEnv(process.env);
    if (!signer) throw new Error("Live mode needs QORE_MNEMONIC in .env (a fresh testnet-only wallet).");
    const [acct] = await signer.getAccounts();
    const pqc = await pqcKeypairFromEnv(client, acct.address, process.env);
    if (!pqc) throw new Error("Could not derive the ML-DSA-87 key from QORE_MNEMONIC.");
    const tx = await client.connectTx(signer, {
      pqcKeypair: pqc.keypair,
      includePqcPublicKey: pqc.includePqcPublicKey,
      gasPrice: config.gasPrice,
    });
    return new LiveL1(client.network.chainId, config.rollupId, acct.address, client, tx);
  }

  get rdk() {
    return this.client;
  }
  get txClient() {
    return this.tx;
  }

  async postData(payload: Uint8Array) {
    const r = await this.tx.postRollupData({ rollupId: this.rollupId, data: payload });
    return { ref: r.transactionHash };
  }

  async deposit(account: Uint8Array, amount: bigint) {
    const r = await this.tx.depositToRollup({ rollupId: this.rollupId, account, amount });
    return { ref: r.transactionHash };
  }

  async inbox() {
    const v = await this.client.rest.getInbox(this.rollupId);
    return { head: v.headSequence, consumed: v.consumedSequence };
  }

  async accAt(seq: number) {
    if (seq === 0) return EMPTY_INBOX_ACC;
    const p = await this.client.rest.getPostedData(this.rollupId, seq);
    return hexToBytes(p.inboxAcc);
  }

  async entries(from: number, to: number): Promise<InboxEntry[]> {
    if (to <= from) return [];
    const list = await fetchQledgerEntries(this.client.rest, {
      chainId: this.chainId,
      rollupId: this.rollupId,
      from,
      to,
      accFrom: await this.accAt(from),
    });
    return list.map((e, i) => ({ ...e, seq: from + 1 + i }));
  }

  async submitBatch(b: SubmitBatch) {
    const r = await this.tx.submitBatch(
      {
        rollupId: this.rollupId,
        batchIndex: b.batchIndex,
        prevStateRoot: b.prevStateRoot,
        stateRoot: b.stateRoot,
        txCount: b.txCount,
        dataHash: b.dataHash,
        withdrawalsRoot: b.withdrawalsRoot,
        inboxEnd: b.inboxEnd,
      },
      { anchor: "auto" },
    );
    return { ref: r.transactionHash };
  }

  async batches(): Promise<BatchInfo[]> {
    const list = await this.client.rest.listBatches(this.rollupId);
    return list.map((b) => ({
      index: b.batchIndex,
      prevStateRoot: b.prevStateRoot,
      stateRoot: b.stateRoot,
      withdrawalsRoot: b.withdrawalsRoot,
      txCount: b.txCount,
      inboxStart: b.inboxStart,
      inboxEnd: b.inboxEnd,
      status: b.status as BatchStatus,
      submitter: "",
      challengeDeadlineMs: 0,
    }));
  }

  async challenge(batchIndex: number, proof: Uint8Array) {
    const r = await this.tx.challengeBatch({ rollupId: this.rollupId, batchIndex, proof });
    const after = await this.client.rest.getBatch(this.rollupId, batchIndex);
    return { ref: r.transactionHash, upheld: after.status === "rejected" };
  }

  async executeWithdrawal(batchIndex: number, w: QledgerWithdrawal, all: QledgerWithdrawal[]) {
    const i = all.findIndex((x) => x.index === w.index);
    if (i < 0) throw new Error("withdrawal is not in the batch");
    const r = await this.tx.executeWithdrawal({
      rollupId: this.rollupId,
      batchIndex,
      withdrawalIndex: w.index,
      recipient: w.recipient,
      denom: "uqor",
      amount: w.amount,
      proof: qledgerWithdrawalProof(this.chainId, this.rollupId, all, i),
    });
    return { ref: r.transactionHash };
  }

  async receipt(batchIndex: number) {
    const receipt = await buildSettlementReceipt(this.client, this.rollupId, batchIndex);
    const verification = await verifySettlementReceipt(receipt);
    return { receipt, verification };
  }

  async l1Balance(address: string) {
    const url = `${this.client.network.endpoints.rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`;
    const r = await fetch(url);
    if (!r.ok) return 0n;
    const j: any = await r.json();
    return BigInt(j?.balance?.amount ?? "0");
  }

  explorerLink(ref: string) {
    const tpl = process.env.Q402_EXPLORER_TX_URL; // e.g. https://<explorer>/tx/{hash}
    return tpl ? tpl.replace("{hash}", ref) : undefined;
  }
}
