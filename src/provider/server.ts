import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { signQledgerTx, encodeQledgerTx, decodeQledgerTx } from "@qorechain/rdk";
import { config, devnetUrl, rollupEnv } from "../core/config.js";
import { party, publicInfo } from "../core/keys.js";
import { openJson, sealJson } from "../core/seal.js";
import { HttpError, getJson, postJson, readJson, sendJson, sha256Hex, toHex, fromHex } from "../core/util.js";
import { Q402_VERSION, SCHEME, type PaidRequest, type PaymentRequired, type PaymentRequirements } from "../core/x402.js";

/**
 * A paid API in the style of x402: call it without paying and it answers
 * 402 with what to pay; call it with a signed qledger transfer and a sealed
 * request and it answers with a sealed response.
 *
 * The data itself comes from free, keyless public APIs (Open-Meteo,
 * CoinGecko). If they are unreachable the API says so and returns a sample.
 */
interface Resource {
  path: string;
  description: string;
  price: bigint; // uqor
  handler: (req: any) => Promise<unknown>;
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const resources: Resource[] = [
  {
    path: "/api/weather",
    description: "Current weather for a city (Open-Meteo)",
    price: 10_000n, // 0.01 QOR
    handler: async (q: { city?: string }) => {
      const city = String(q.city ?? "").slice(0, 80) || "Kolkata";
      try {
        const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
        const g = geo.results?.[0];
        if (!g) return { city, error: "city not found" };
        const w = await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
        );
        return { city: `${g.name}, ${g.country}`, current: w.current, units: w.current_units, source: "open-meteo.com" };
      } catch (e) {
        return { city, current: null, note: `live source unreachable (${(e as Error).message}); no data served` };
      }
    },
  },
  {
    path: "/api/price",
    description: "Spot price of a crypto asset in USD (CoinGecko)",
    price: 5_000n, // 0.005 QOR
    handler: async (q: { coin?: string }) => {
      const coin = String(q.coin ?? "bitcoin").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "bitcoin";
      try {
        const j = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_24hr_change=true&ids=${coin}`);
        if (!j[coin]) return { coin, error: "unknown coin id (use CoinGecko ids like bitcoin, ethereum, solana)" };
        return { coin, usd: j[coin].usd, change24h: j[coin].usd_24h_change, source: "coingecko.com" };
      } catch (e) {
        return { coin, usd: null, note: `live source unreachable (${(e as Error).message}); no price served` };
      }
    },
  },
];

export async function startProvider(opts: { port?: number; quiet?: boolean } = {}) {
  const port = opts.port ?? config.providerPort;
  const me = party("provider", process.env.Q402_PROVIDER_ADDRESS || undefined);
  const info = publicInfo(me);
  const served = { calls: 0, earned: 0n };

  const requirements = (r: Resource): PaymentRequirements => ({
    scheme: SCHEME,
    network: config.chainId,
    rollupId: config.rollupId,
    resource: r.path,
    description: r.description,
    amount: r.price.toString(),
    payTo: info.accountId,
    seal: { member: info.address, kemKey: info.kemKey },
    facilitator: devnetUrl(),
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && url.pathname === "/catalog")
      return sendJson(res, 200, { provider: { name: "Q402 demo data provider", address: info.address }, resources: resources.map(requirements), served });

    if (req.method === "POST" && url.pathname === "/admin/withdraw") {
      // Withdraw the provider's rollup balance to its L1 address.
      const acct = await getJson(`${devnetUrl()}/account/${info.accountId}`);
      const amount = BigInt(acct.balance);
      if (amount <= 0n) throw new HttpError(400, "nothing to withdraw yet (payments still being included?)");
      const tx = signQledgerTx({
        ...rollupEnv(),
        secretKey: me.ledger.secretKey,
        publicKey: me.ledger.publicKey,
        nonce: BigInt(acct.nextNonce),
        amount,
        recipient: me.address,
      });
      const r = await postJson(`${devnetUrl()}/settle`, { payment: toHex(encodeQledgerTx(tx)) });
      return sendJson(res, r.status, { ...r.data, amount, recipient: me.address });
    }

    const resource = resources.find((r) => r.path === url.pathname);
    if (!resource || req.method !== "POST") throw new HttpError(404, "not found; see GET /catalog");

    const body = (await readJson(req)) as Partial<PaidRequest>;
    const reqs = requirements(resource);
    if (!body.payment) {
      const pr: PaymentRequired = { q402Version: Q402_VERSION, error: "payment required", accepts: [reqs] };
      return sendJson(res, 402, pr);
    }
    if (!body.sealedRequest || !body.replyTo?.member || !body.replyTo?.kemKey)
      throw new HttpError(400, "sealedRequest and replyTo are required");

    // 1. Only we can open the request (checked before taking any money).
    let query: unknown;
    try {
      query = openJson(me.address, me.kem.secretKey, body.sealedRequest);
    } catch {
      throw new HttpError(400, "could not open sealedRequest with our ML-KEM-1024 key");
    }

    // 2. Ask the facilitator to verify and queue the payment.
    const settle = await postJson(`${devnetUrl()}/settle`, {
      payment: body.payment,
      payTo: reqs.payTo,
      amount: reqs.amount,
      resource: resource.path,
    });
    if (settle.status !== 200 || !settle.data.ok) {
      return sendJson(res, 402, { q402Version: Q402_VERSION, error: settle.data.reason ?? "payment refused", accepts: [reqs] });
    }

    // 3. Serve, sealed to the caller.
    const result = await resource.handler(query);
    served.calls += 1;
    served.earned += resource.price;
    const tx = decodeQledgerTx(fromHex(body.payment));
    return sendJson(res, 200, {
      q402Version: Q402_VERSION,
      sealedResponse: sealJson(body.replyTo, { resource: resource.path, result, servedAt: new Date().toISOString() }),
      payment: { id: settle.data.id ?? sha256Hex(fromHex(body.payment)), amount: String(tx?.amount ?? reqs.amount), status: "accepted" },
    });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => sendJson(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message }));
  });
  await new Promise<void>((r) => server.listen(port, r));
  if (!opts.quiet) console.log(`Q402 provider on http://localhost:${port}  payTo=${info.accountId.slice(0, 12)}…`);
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startProvider().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
