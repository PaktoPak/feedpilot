import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";
import { ensureDir, sleep } from "./util.js";

// The extension and the background helper are separate processes, so locks live on disk.
// Holders refresh the file's mtime; a lock nobody refreshed for STALE_MS belongs to a dead process.
const STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

async function tryAcquire(file: string, retryStale = true): Promise<boolean> {
  try {
    const handle = await fs.open(file, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.close();
    return true;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const stat = await fs.stat(file).catch(() => null);
    if (retryStale && stat && Date.now() - stat.mtimeMs > STALE_MS) {
      await fs.rm(file, { force: true });
      return tryAcquire(file, false);
    }
    return false;
  }
}

/** Runs fn while holding the named lock. Returns null if the lock stayed busy for waitMs. */
export async function withLock<T>(name: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T | null> {
  await ensureDir(paths.locks);
  const file = path.join(paths.locks, `${name}.lock`);
  const deadline = Date.now() + waitMs;
  while (!(await tryAcquire(file))) {
    if (Date.now() >= deadline) return null;
    await sleep(100 + Math.random() * 150);
  }
  const beat = setInterval(() => {
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await fs.rm(file, { force: true });
  }
}

export async function withLockOrThrow<T>(name: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  let ran = false;
  const result = await withLock(name, async () => {
    ran = true;
    return fn();
  }, waitMs);
  if (!ran) throw new Error(`Feedpilot's ${name} file is busy. Try again in a moment.`);
  return result as T;
}
