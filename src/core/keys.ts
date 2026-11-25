import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { hexToBech32, kemKeypairFromSeed, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { fromHex, toHex } from "./util.js";

/**
 * A party on the rollup. Two independent post-quantum keys:
 * - an ML-DSA-44 key that controls its qledger-v1 account (signs payments)
 * - an ML-KEM-1024 key that others seal data to (request/response privacy)
 * plus a qor1 address: its L1 identity (envelope member, withdrawal target).
 */
export interface Party {
  name: string;
  address: string;
  ledger: { publicKey: Uint8Array; secretKey: Uint8Array; accountId: Uint8Array };
  kem: { publicKey: Uint8Array; secretKey: Uint8Array };
}

interface StoredParty {
  address: string;
  ledgerSeed: string;
  kemSeed: string;
}

const FILE = resolve(process.cwd(), ".devkeys.json");

function load(): Record<string, StoredParty> {
  if (!existsSync(FILE)) return {};
  return JSON.parse(readFileSync(FILE, "utf8"));
}

/**
 * Load (or create once) the local test identity `name`. Seeds live in
 * .devkeys.json, which is git-ignored. These are TESTNET-ONLY keys.
 */
export function party(name: string, addressOverride?: string): Party {
  const all = load();
  let p = all[name];
  if (!p) {
    p = {
      address: addressOverride ?? hexToBech32(toHex(randomBytes(20)), "qor"),
      ledgerSeed: toHex(randomBytes(32)),
      kemSeed: toHex(randomBytes(64)),
    };
    all[name] = p;
    writeFileSync(FILE, JSON.stringify(all, null, 2));
  }
  const address = addressOverride ?? p.address;
  return {
    name,
    address,
    ledger: qledgerKeypairFromSeed(fromHex(p.ledgerSeed)),
    kem: kemKeypairFromSeed(fromHex(p.kemSeed)),
  };
}

/** Public part only: what other parties may know. */
export function publicInfo(p: Party) {
  return {
    name: p.name,
    address: p.address,
    accountId: toHex(p.ledger.accountId),
    kemKey: toHex(p.kem.publicKey),
  };
}
