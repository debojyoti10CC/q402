/**
 * End-to-end check of the whole flow on the in-memory L1, in ~40 seconds:
 *   paid calls -> batches -> watchtower verifies -> evil batch -> fraud proof
 *   -> batch rejected -> honest re-batch -> provider withdraws -> paid on L1.
 * Exits 1 on the first broken step. Run: npm run demo
 */
process.env.Q402_MODE = "mock";
process.env.Q402_MOCK_CHALLENGE_WINDOW_SEC = "6";
process.env.Q402_BATCH_INTERVAL_MS = "800";
process.env.Q402_DEVNET_URL = "http://localhost:18402";
process.env.Q402_PROVIDER_URL = "http://localhost:18403";

const { startDevnet } = await import("../src/node/server.js");
const { startProvider } = await import("../src/provider/server.js");
const { Q402Agent } = await import("../src/agent/client.js");
const { party } = await import("../src/core/keys.js");
const { postJson, sleep, toHex, jsonStringify } = await import("../src/core/util.js");

const P = "http://localhost:18403";
let failures = 0;
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
};
async function until(what: string, f: () => Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return ok(true, what);
    await sleep(250);
  }
  ok(false, `${what} (timed out)`);
}

const net = await startDevnet({ port: 18402, quiet: true });
const prov = await startProvider({ port: 18403, quiet: true });
const events: { type: string; data: any }[] = [];
for (const [src, names] of [
  [net.watchtower, ["fraud", "challenge", "verified"]],
  [net.operator, ["batch", "withdrawal", "warn"]],
] as const)
  for (const n of names) src.on(n, (d: any) => events.push({ type: n, data: d }));

const agentKeys = party("agent");
const provKeys = party("provider");
const thief = party("operator");
const agent = new Q402Agent(agentKeys);
const acct = (p: typeof agentKeys) => net.facilitator.account(toHex(p.ledger.accountId));

try {
  const before = acct(provKeys);

  // 1. Paid calls
  const r1 = await agent.call(`${P}/api/price`, { coin: "bitcoin" });
  const r2 = await agent.call(`${P}/api/weather`, { city: "Kolkata" });
  const r3 = await agent.call(`${P}/api/price`, { coin: "ethereum" });
  console.log("      sample result:", jsonStringify(r2.result).slice(0, 120));
  ok(r1.paid === 5000n && r2.paid === 10000n, "agent paid the listed prices");
  await net.facilitator.sync();
  ok(acct(provKeys).balance - before.balance === 20000n, "provider received 0.02 QOR on the rollup");

  // 2. Limits and replay
  const tight = new Q402Agent(agentKeys, { maxPerCall: 1n, sessionBudget: 10n });
  ok(await tight.call(`${P}/api/price`, { coin: "bitcoin" }).then(() => false, (e) => /per-call limit/.test(e.message)), "agent refuses a call over its per-call limit");
  const replay = await postJson(`${P}/api/price`, { payment: "00", sealedRequest: "x", replyTo: { member: "a", kemKey: "b" } });
  ok(replay.status !== 200, "provider refuses a junk payment");

  // 3. Honest batch, verified by the watchtower
  await until("operator submitted a batch and the watchtower verified it", async () => events.some((e) => e.type === "verified"));

  // 4. Evil sequencer
  net.operator.evilNext = true;
  await agent.call(`${P}/api/price`, { coin: "solana" });
  await until("evil batch submitted", async () => events.some((e) => e.type === "batch" && e.data.evil));
  await until("watchtower detected the fraud", async () => events.some((e) => e.type === "fraud"));
  await until("fraud proof upheld by the chain's rule, batch rejected", async () =>
    events.some((e) => e.type === "challenge" && e.data.upheld),
  );
  const bs = await net.l1.batches();
  ok(bs.some((b) => b.status === "rejected"), "rejected batch is marked rejected");
  ok(acct(thief).confirmedBalance === 0n, "thief account holds 0 (the mint never became state)");
  await until("honest batch re-submitted over the same inbox range", async () => {
    const list = await net.l1.batches();
    const rej = list.find((b) => b.status === "rejected");
    return !!rej && list.some((b) => b.status !== "rejected" && b.index === rej.index);
  });

  // 5. Provider withdraws to L1 after finality
  await net.facilitator.sync();
  const w = await postJson(`${P}/admin/withdraw`, {});
  ok(w.status === 200 && w.data.ok, `provider queued a withdrawal of ${w.data.amount} uqor`);
  await until(
    "withdrawal finalized and paid out on L1",
    async () => (await net.l1.l1Balance(provKeys.address)) > 0n,
    30000,
  );
  const fin = (await net.l1.batches()).filter((b) => b.status === "finalized");
  ok(fin.length > 0, `${fin.length} batch(es) finalized`);
  console.log("      receipt:", jsonStringify(await net.l1.receipt(fin[0].index)).slice(0, 160), "…");
} catch (e) {
  ok(false, `unexpected error: ${(e as Error).stack}`);
} finally {
  await prov.close();
  await net.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
