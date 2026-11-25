import { providerUrl } from "../core/config.js";
import { party } from "../core/keys.js";
import { jsonStringify } from "../core/util.js";
import { Q402Agent } from "./client.js";

/**
 * Scripted agent, no AI needed:
 *   npm run agent -- weather Kolkata
 *   npm run agent -- price ethereum
 *   npm run agent -- burst 20        (20 paid calls, for load on the dashboard)
 *   npm run agent -- wallet
 */
const [cmd = "weather", arg = ""] = process.argv.slice(2);
const agent = new Q402Agent(party("agent"));

async function main() {
  if (cmd === "wallet") return console.log(jsonStringify(await agent.wallet()));
  if (cmd === "weather") return console.log(jsonStringify(await agent.call(`${providerUrl()}/api/weather`, { city: arg || "Kolkata" })));
  if (cmd === "price") return console.log(jsonStringify(await agent.call(`${providerUrl()}/api/price`, { coin: arg || "bitcoin" })));
  if (cmd === "burst") {
    const n = Number(arg || 10);
    const coins = ["bitcoin", "ethereum", "solana"];
    for (let i = 0; i < n; i++) {
      const r = await agent.call(`${providerUrl()}/api/price`, { coin: coins[i % coins.length] });
      console.log(`#${i + 1} paid ${r.paid} uqor in ${r.ms} ms -> ${jsonStringify(r.result).slice(0, 80)}`);
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
