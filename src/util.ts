import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e: any) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function readJsonLines<T>(file: string): Promise<T[]> {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

export async function appendJsonLines(file: string, rows: object[]): Promise<void> {
  if (!rows.length) return;
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const normalizeUsername = (u: string) => u.trim().replace(/^@/, "").toLowerCase();

/** Runs fn over items with at most limit running at once, keeping the results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// stdout carries the MCP protocol, so all logging goes to stderr.
export function log(...args: unknown[]): void {
  console.error("[feedpilot]", ...args);
}
