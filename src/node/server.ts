import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, providerUrl } from "../core/config.js";
import { party, publicInfo } from "../core/keys.js";
import { HttpError, fromHex, jsonStringify, postJson, readJson, sendJson, toHex } from "../core/util.js";
import type { L1Backend } from "../l1/types.js";
import { MockL1 } from "../l1/mock.js";
import { LiveL1 } from "../l1/live.js";
import { Facilitator } from "./facilitator.js";
import { Operator } from "./operator.js";
import { Watchtower } from "./watchtower.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface Devnet {
  l1: L1Backend;
  facilitator: Facilitator;
  operator: Operator;
  watchtower: Watchtower;
  close(): Promise<void>;
  port: number;
}

/** Start the L1 backend, facilitator, operator, watchtower and dashboard. */
export async function startDevnet(opts: { port?: number; quiet?: boolean } = {}): Promise<Devnet> {
  const port = opts.port ?? config.devnetPort;
  const agent = party("agent");
  const provider = party("provider", process.env.Q402_PROVIDER_ADDRESS || undefined);
  const thief = party("operator");

  const l1: L1Backend =
    config.mode === "live"
      ? await LiveL1.connect()
      : new MockL1(config.chainId, config.rollupId, "qor1operator-mock", config.mockChallengeWindowSec * 1000);

  const facilitator = new Facilitator(l1);
  const operator = new Operator(l1, thief.ledger.accountId);
  const watchtower = new Watchtower(l1);

  // ---- event log, fanned out to the dashboard over SSE ----
  const log: { t: number; type: string; data: unknown }[] = [];
  const clients = new Set<ServerResponse>();
  const push = (type: string, data: unknown) => {
    const ev = { t: Date.now(), type, data };
    log.push(ev);
    if (log.length > 300) log.shift();
    const line = `data: ${jsonStringify(ev)}\n\n`;
    for (const c of clients) c.write(line);
    if (!opts.quiet) console.log(`[${type}]`, jsonStringify(data).slice(0, 200));
  };
  for (const [src, names] of [
    [facilitator, ["payment", "payment-rejected", "posted", "warn"]],
    [operator, ["batch", "withdrawal", "warn"]],
    [watchtower, ["verified", "fraud", "challenge", "warn"]],
  ] as const) {
    for (const n of names) src.on(n, (d: unknown) => push(src === watchtower && n === "warn" ? "watchtower-warn" : n, d));
  }
  if (l1 instanceof MockL1) l1.on("finalized", (b) => push("finalized", { index: b.index }));

  const timers = [
    setInterval(() => void operator.step(), config.batchIntervalMs),
    setInterval(() => void watchtower.step(), 1500),
    setInterval(() => void facilitator.sync().catch((e) => push("warn", { where: "sync", message: e.message })), 2000),
  ];

  // Mock mode: give the agent test balance on the rollup at boot.
  if (l1 instanceof MockL1) {
    await l1.deposit(agent.ledger.accountId, 20_000_000n);
    await facilitator.sync();
    push("deposit", { to: "agent", amount: 20_000_000n });
  }

  async function state() {
    const [inbox, batches] = await Promise.all([l1.inbox(), l1.batches()]);
    const acct = (id: Uint8Array) => facilitator.account(toHex(id));
    return {
      mode: l1.mode,
      chainId: l1.chainId,
      rollupId: l1.rollupId,
      operator: l1.operator,
      parties: {
        agent: { ...publicInfo(agent), kemKey: undefined, ...acct(agent.ledger.accountId) },
        provider: {
          ...publicInfo(provider),
          kemKey: undefined,
          ...acct(provider.ledger.accountId),
          l1Balance: await l1.l1Balance(provider.address),
        },
        thief: { ...publicInfo(thief), kemKey: undefined, ...acct(thief.ledger.accountId) },
      },
      inbox,
      batches: batches.slice(-25),
      escrow: l1 instanceof MockL1 ? l1.escrow : undefined,
      facilitator: facilitator.snapshot(),
      challengeWindowSec: config.mockChallengeWindowSec,
      log: log.slice(-80),
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(here, "dashboard.html")));
    }
    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hello\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && p === "/state") return sendJson(res, 200, await state());
    if (req.method === "GET" && p.startsWith("/account/")) return sendJson(res, 200, facilitator.account(p.slice(9).toLowerCase()));
    if (req.method === "GET" && p.startsWith("/receipt/")) return sendJson(res, 200, await l1.receipt(Number(p.slice(9))));
    if (req.method === "GET" && p.startsWith("/withdrawals/"))
      return sendJson(res, 200, operator.withdrawalsOf(Number(p.slice(13))));

    if (req.method === "POST" && p === "/verify") {
      const b = await readJson(req);
      const v = facilitator.verify(String(b.payment ?? ""), b.payTo ? { payTo: b.payTo, amount: BigInt(b.amount ?? 0) } : undefined);
      return sendJson(res, v.ok ? 200 : 402, { ok: v.ok, reason: v.reason, id: v.id, from: v.from, amount: v.amount });
    }
    if (req.method === "POST" && p === "/settle") {
      const b = await readJson(req);
      const v = facilitator.settle(
        String(b.payment ?? ""),
        b.payTo ? { payTo: b.payTo, amount: BigInt(b.amount ?? 0), resource: b.resource } : undefined,
      );
      return sendJson(res, v.ok ? 200 : 402, v);
    }
    if (req.method === "POST" && p === "/admin/faucet") {
      const b = await readJson(req);
      const account = b.accountId ? fromHex(b.accountId) : agent.ledger.accountId;
      const amount = BigInt(b.amount ?? 5_000_000);
      const { ref } = await l1.deposit(account, amount);
      push("deposit", { to: toHex(account), amount, ref });
      return sendJson(res, 200, { ok: true, ref });
    }
    if (req.method === "POST" && p === "/admin/evil") {
      operator.evilNext = true;
      push("evil-armed", { amount: operator.evilAmount, thief: toHex(thief.ledger.accountId) });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/admin/withdraw") {
      const r = await postJson(`${providerUrl()}/admin/withdraw`, await readJson(req));
      return sendJson(res, r.status, r.data);
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      sendJson(res, status, { error: (e as Error).message });
    });
  });
  await new Promise<void>((r) => server.listen(port, r));
  if (!opts.quiet) console.log(`Q402 devnet (${l1.mode}) on http://localhost:${port}  rollup=${l1.rollupId}`);

  return {
    l1,
    facilitator,
    operator,
    watchtower,
    port,
    close: async () => {
      timers.forEach(clearInterval);
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startDevnet().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
