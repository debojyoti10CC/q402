/**
 * One-time testnet setup (live mode). Run AFTER the operator account holds
 * the rollup stake (10,000 test QOR + fees + a 1,000 QOR submitter bond):
 *
 *   Q402_MODE=live npm run setup:live            (dry run: shows what it would do)
 *   Q402_MODE=live npm run setup:live -- --yes   (sends the transactions)
 *
 * Steps: create the rollup (optimistic, qledger-v1 execution, based
 * sequencing, native DA), bond the submitter, and deposit test QOR into the
 * agent's L2 account.
 * TODO: publish the provider's ML-KEM-1024 key in the chain's KEM registry
 * (registerKemKey), signed by the provider's own L1 account.
 *
 * STATUS: written against RDK 0.9, not yet run (waiting for the stake).
 */
process.env.Q402_MODE = "live";
const { LiveL1 } = await import("../src/l1/live.js");
const { party } = await import("../src/core/keys.js");
const { config } = await import("../src/core/config.js");

const yes = process.argv.includes("--yes");
const l1 = await LiveL1.connect();
const params = await l1.rdk.params();
const balance = await l1.l1Balance(l1.operator);
console.log(`operator ${l1.operator}  balance ${balance} uqor`);
console.log(`stake ${params.minStakeForRollup} uqor, submitter bond ${params.minSubmitterBond} uqor`);

const agent = party("agent");
const provider = party("provider", process.env.Q402_PROVIDER_ADDRESS || undefined);
const plan = [
  `createRollup ${config.rollupId} (custom, optimistic, qledger-v1, based, native DA)`,
  `bondRollupSubmitter ${params.minSubmitterBond}`,
  `depositToRollup agent ${agent.ledger.accountId.length}-byte account, 20 QOR`,
];
console.log(plan.map((s) => " - " + s).join("\n"));
if (!yes) {
  console.log("\nDry run. Re-run with --yes to send.");
  process.exit(0);
}

const tx = l1.txClient;
let r = await tx.createRollup({
  rollupId: config.rollupId,
  profile: "custom",
  vmType: "custom",
  stakeAmount: params.minStakeForRollup,
  sequencing: "based",
  executionVm: "qledger-v1",
});
console.log("created:", r.transactionHash);
r = await tx.bondRollupSubmitter({ rollupId: config.rollupId, amount: params.minSubmitterBond ?? "1000000000" });
console.log("bonded:", r.transactionHash);
r = await tx.depositToRollup({ rollupId: config.rollupId, account: agent.ledger.accountId, amount: 20_000_000n });
console.log("deposited:", r.transactionHash);
console.log(`\nProvider withdrawals go to ${provider.address}. Set Q402_PROVIDER_ADDRESS to an address you control.`);
console.log("Done. Start the stack with Q402_MODE=live npm run devnet");
