import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { providerUrl } from "../core/config.js";
import { party } from "../core/keys.js";
import { jsonStringify } from "../core/util.js";
import { Q402Agent } from "./client.js";

/**
 * MCP server that gives Claude (Desktop or Code) a post-quantum wallet on the
 * Q402 rollup and paid tools. Every tool call pays the provider per call.
 * stdout is the MCP channel: log to stderr only.
 */
const agent = new Q402Agent(party("agent"), {
  maxPerCall: BigInt(process.env.Q402_MAX_PER_CALL ?? 100_000),
  sessionBudget: BigInt(process.env.Q402_SESSION_BUDGET ?? 2_000_000),
});

const server = new McpServer({ name: "q402-wallet", version: "0.1.0" });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: jsonStringify(v) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });

server.tool(
  "get_weather",
  "Current weather for a city. Paid API: costs 0.01 QOR per call, paid from the Q402 rollup wallet.",
  { city: z.string().describe("City name, e.g. Kolkata") },
  async ({ city }) => {
    try {
      return text(await agent.call(`${providerUrl()}/api/weather`, { city }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_crypto_price",
  "USD spot price of a crypto asset by CoinGecko id (bitcoin, ethereum, solana...). Paid API: 0.005 QOR per call.",
  { coin: z.string().describe("CoinGecko id, e.g. bitcoin") },
  async ({ coin }) => {
    try {
      return text(await agent.call(`${providerUrl()}/api/price`, { coin }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool("wallet_status", "Balance, nonce, and what this session has spent on paid APIs.", {}, async () => {
  try {
    const w = await agent.wallet();
    return text({ ...w, sessionSpent: agent.spent, sessionCalls: agent.calls, limits: agent.limits, unit: "uqor (1 QOR = 1,000,000 uqor)" });
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
console.error("q402-wallet MCP server ready");
