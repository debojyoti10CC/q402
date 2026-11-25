import "dotenv/config";

export type Mode = "mock" | "live";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

const mode = (process.env.Q402_MODE ?? "mock") as Mode;
if (mode !== "mock" && mode !== "live") throw new Error(`Q402_MODE must be "mock" or "live"`);

export const config = {
  mode,
  chainId: process.env.Q402_CHAIN_ID ?? "qorechain-diana",
  rollupId: process.env.Q402_ROLLUP_ID ?? "q402-pay",
  devnetPort: num("Q402_DEVNET_PORT", 8402),
  providerPort: num("Q402_PROVIDER_PORT", 8403),
  mockChallengeWindowSec: num("Q402_MOCK_CHALLENGE_WINDOW_SEC", 20),
  batchIntervalMs: num("Q402_BATCH_INTERVAL_MS", 4000),
  gasPrice: process.env.QORE_GAS_PRICE ?? "0.1uqor",
};

export const devnetUrl = () => process.env.Q402_DEVNET_URL ?? `http://localhost:${config.devnetPort}`;
export const providerUrl = () => process.env.Q402_PROVIDER_URL ?? `http://localhost:${config.providerPort}`;

/** The pair every qledger signature and envelope is bound to. */
export const rollupEnv = () => ({ chainId: config.chainId, rollupId: config.rollupId });
