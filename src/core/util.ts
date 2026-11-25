import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
export const fromHex = (h: string) => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("invalid hex");
  return new Uint8Array(Buffer.from(s, "hex"));
};
export const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
export const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (u: Uint8Array) => new TextDecoder().decode(u);
export const sha256Hex = (u: Uint8Array) => createHash("sha256").update(u).digest("hex");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const short = (h: string, n = 6) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

/** JSON.stringify that turns bigint and Uint8Array into strings. */
export function jsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? toHex(x) : x,
  );
}

export async function readJson<T = any>(req: IncomingMessage, limit = 256 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const s = jsonStringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(s);
}

export async function postJson<T = any>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: jsonStringify(body) });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  return { status: r.status, data };
}

export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return (await r.json()) as T;
}
