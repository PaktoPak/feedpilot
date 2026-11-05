import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";
import { withLockOrThrow } from "./lock.js";
import { ensureDir, normalizeUsername, readJson, writeJsonAtomic } from "./util.js";

export type AccountType = "personal" | "business" | "creator" | "unknown";

export interface Account {
  username: string;
  user_id: string;
  full_name?: string;
  account_type: AccountType;
  is_private?: boolean;
  profile_dir: string;
  status: "connected" | "needs_sign_in";
  connected_at: string;
  last_checked_at?: string;
  /** Learned on the first scheduled post: false when the account's New post window has no Schedule content option. */
  can_schedule_on_instagram?: boolean;
}

export type PostKind = "photo" | "carousel" | "reel";

export interface PreviewItem {
  account: string;
  files: string[];
  hashes: string[];
  kind: PostKind;
  caption: string;
  post_at: string | null; // null means post right away
}

/** One approval covering a post for each of one or more accounts. */
export interface Preview {
  id: string;
  items: PreviewItem[];
  created_at: string;
  expires_at: string;
}

export type JobStatus =
  | "scheduled"
  | "running"
  | "on_instagram"
  | "posted"
  | "tested"
  | "failed"
  | "needs_check"
  | "missed"
  | "unconfirmed"
  | "cancelled";

export interface Job {
  id: string;
  type: "post" | "test_post";
  /** Jobs approved together share a batch id. */
  batch_id?: string;
  account: string;
  files: string[];
  hashes: string[];
  kind: PostKind;
  caption: string;
  /** When the post should go live. */
  run_at: string;
  /**
   * "instagram": handed to Instagram's own scheduler right away, which publishes it at run_at.
   * "local": Feedpilot publishes it itself at run_at. Missing on older jobs, meaning local.
   */
  mode?: "local" | "instagram";
  /** Earliest next attempt at handing a post to Instagram after a failed try. */
  retry_at?: string;
  /** For test runs of a scheduled post: the time to set in Instagram's scheduler. */
  schedule_at?: string;
  /** Profile grid before a hand-off, used to find the post once Instagram publishes it. */
  profile_before?: string[];
  /** Last look at the profile for a post Instagram should have published. */
  checked_at?: string;
  /** A move or cancel the user approved for a post Instagram's scheduler holds; the worker carries it out. */
  pending_change?: { action: "cancel" } | { action: "move"; run_at: string };
  note?: string;
  created_at: string;
  updated_at: string;
  status: JobStatus;
  attempts: number;
  result?: { url?: string; code?: string; finished_at: string; screenshot?: string; note?: string };
  error?: { message: string; step: string; stage: "before_share" | "after_share"; screenshot?: string };
}

export interface Action {
  at: string;
  action: string;
  account?: string;
  ok: boolean;
  detail?: string;
}

const file = {
  accounts: () => path.join(paths.state, "accounts.json"),
  jobs: () => path.join(paths.state, "jobs.json"),
  previews: () => path.join(paths.state, "previews.json"),
  actions: () => path.join(paths.state, "actions.jsonl"),
};

// One lock covers every state file: writes are small and rare, so contention is not a concern.
function locked<T>(fn: () => Promise<T>): Promise<T> {
  return withLockOrThrow("state", fn);
}

export async function getAccounts(): Promise<Account[]> {
  return readJson<Account[]>(file.accounts(), []);
}

export async function getAccount(username: string): Promise<Account | undefined> {
  const name = normalizeUsername(username);
  return (await getAccounts()).find((a) => a.username === name);
}

export async function upsertAccount(account: Account): Promise<void> {
  await locked(async () => {
    const all = await getAccounts();
    const rest = all.filter((a) => a.user_id !== account.user_id && a.username !== account.username);
    await writeJsonAtomic(file.accounts(), [...rest, account].sort((a, b) => a.username.localeCompare(b.username)));
  });
}

export async function patchAccount(username: string, patch: Partial<Account>): Promise<void> {
  await locked(async () => {
    const all = await getAccounts();
    const name = normalizeUsername(username);
    await writeJsonAtomic(file.accounts(), all.map((a) => (a.username === name ? { ...a, ...patch } : a)));
  });
}

export async function removeAccount(username: string): Promise<void> {
  await locked(async () => {
    const name = normalizeUsername(username);
    await writeJsonAtomic(file.accounts(), (await getAccounts()).filter((a) => a.username !== name));
  });
}

export async function getJobs(): Promise<Job[]> {
  return readJson<Job[]>(file.jobs(), []);
}

/** Read-modify-write on the job list under the state lock. */
export async function updateJobs<T>(fn: (jobs: Job[]) => T): Promise<T> {
  return locked(async () => {
    const jobs = await getJobs();
    const result = fn(jobs);
    await writeJsonAtomic(file.jobs(), jobs);
    return result;
  });
}

export async function patchJob(id: string, patch: Partial<Job>): Promise<Job | undefined> {
  return updateJobs((jobs) => {
    const job = jobs.find((j) => j.id === id);
    if (job) Object.assign(job, patch, { updated_at: new Date().toISOString() });
    return job;
  });
}

export async function savePreview(preview: Preview): Promise<void> {
  await locked(async () => {
    const now = Date.now();
    const all = await readJson<Preview[]>(file.previews(), []);
    const live = all.filter((p) => Date.parse(p.expires_at) > now);
    await writeJsonAtomic(file.previews(), [...live, preview]);
  });
}

export async function peekPreview(id: string): Promise<Preview | undefined> {
  const found = (await readJson<Preview[]>(file.previews(), [])).find((p) => p.id === id);
  return found && Date.parse(found.expires_at) > Date.now() ? found : undefined;
}

/** Removes and returns a preview, so each approval is used once. */
export async function takePreview(id: string): Promise<Preview | undefined> {
  return locked(async () => {
    const all = await readJson<Preview[]>(file.previews(), []);
    const found = all.find((p) => p.id === id);
    await writeJsonAtomic(file.previews(), all.filter((p) => p.id !== id));
    if (found && Date.parse(found.expires_at) < Date.now()) return undefined;
    return found;
  });
}

export async function logAction(entry: Omit<Action, "at">): Promise<void> {
  await ensureDir(paths.state);
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await fs.appendFile(file.actions(), line + "\n");
}

export async function readActions(opts: { account?: string; limit?: number } = {}): Promise<Action[]> {
  let text = "";
  try {
    text = await fs.readFile(file.actions(), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const name = opts.account ? normalizeUsername(opts.account) : undefined;
  const all = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Action)
    .filter((a) => !name || a.account === name);
  return all.slice(-(opts.limit ?? 30)).reverse();
}
