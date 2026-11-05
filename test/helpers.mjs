import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverPath = path.join(root, "dist", "index.js");
export const workerPath = path.join(root, "dist", "worker.js");

// A valid 1x1 PNG. Extra bytes after the end marker make files distinct without breaking them.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export async function makeDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "feedpilot-test-"));
}

export async function writeMedia(dataDir, account, name, tag = name) {
  const dir = account ? path.join(dataDir, "media", account) : path.join(dataDir, "media");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = name.endsWith(".png") ? Buffer.concat([PNG, Buffer.from(tag)]) : Buffer.from(`fake ${tag}`);
  await fs.writeFile(file, body);
  return file;
}

export async function seedAccounts(dataDir, usernames) {
  const now = new Date().toISOString();
  const accounts = usernames.map((username, i) => ({
    username,
    user_id: String(1000 + i),
    account_type: "business",
    is_private: false,
    profile_dir: path.join(dataDir, "profiles", `acct_${username}`),
    status: "connected",
    connected_at: now,
  }));
  await fs.mkdir(path.join(dataDir, "state"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "state", "accounts.json"), JSON.stringify(accounts, null, 2));
}

export async function readState(dataDir, name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, "state", name), "utf8"));
  } catch {
    return fallback;
  }
}

export async function startClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "feedpilot-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, isError: !!result.isError, content: result.content };
}

export const idFrom = (text, prefix) => text.match(new RegExp(`\\b(${prefix}_[0-9a-f]{8})\\b`))?.[1];

export async function waitForStatus(client, jobId, wanted, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "get_post_status", { job_id: jobId })).text;
    if (last.includes(`: ${wanted} (`)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${wanted}. Last status:\n${last}`);
}

export function isoInDays(days, hour = 18) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export const minutesFromNow = (n) => new Date(Date.now() + n * 60_000).toISOString();

export async function waitForText(client, jobId, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "get_post_status", { job_id: jobId })).text;
    if (pattern.test(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${pattern}. Last status:\n${last}`);
}
