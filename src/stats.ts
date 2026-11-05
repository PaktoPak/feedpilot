import fs from "node:fs/promises";
import path from "node:path";
import { BrowserBusyError } from "./browser.js";
import { paths, settings } from "./config.js";
import { readProfileStats, type MediaStats, type ProfileStats } from "./instagram/stats.js";
import { withLockOrThrow } from "./lock.js";
import { getAccounts, getJobs, logAction, patchAccount, type Account, type PostKind } from "./store.js";
import { ensureDir, errorMessage, mapLimit, normalizeUsername, readJson, writeJsonAtomic } from "./util.js";

// Stats are kept as append-only snapshots, so history builds up beyond what Instagram itself keeps.

export interface AccountSnapshot {
  at: string;
  account: string;
  followers?: number;
  following?: number;
  posts?: number;
}

export interface PostSnapshot extends MediaStats {
  at: string;
  account: string;
}

interface SyncEntry {
  last_at?: string;
  next_at?: string;
  ok?: boolean;
  error?: string;
  requested_at?: string;
}

const RETRY_AFTER_FAILURE_MS = 3600_000;
const dir = () => path.join(paths.state, "stats");
const file = {
  accounts: () => path.join(dir(), "accounts.jsonl"),
  posts: () => path.join(dir(), "posts.jsonl"),
  sync: () => path.join(dir(), "sync.json"),
};

async function appendLines(target: string, rows: object[]): Promise<void> {
  if (!rows.length) return;
  await ensureDir(dir());
  await fs.appendFile(target, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function readLines<T>(source: string): Promise<T[]> {
  try {
    return (await fs.readFile(source, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

export async function getSyncState(): Promise<Record<string, SyncEntry>> {
  return readJson<Record<string, SyncEntry>>(file.sync(), {});
}

async function patchSync(account: string, patch: SyncEntry): Promise<void> {
  await withLockOrThrow("stats", async () => {
    const state = await getSyncState();
    state[account] = { ...state[account], ...patch };
    await writeJsonAtomic(file.sync(), state);
  });
}

export async function requestStatsSync(usernames: string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const username of usernames) await patchSync(normalizeUsername(username), { requested_at: at });
}

/** Refreshes accounts whose stats are due (every settings.statsEveryHours) or were asked for, several at once. */
export async function syncStatsIfDue(): Promise<number> {
  const state = await getSyncState();
  const now = Date.now();
  const due = (await getAccounts()).filter((account) => {
    if (account.status !== "connected") return false;
    const entry = state[account.username];
    if (entry?.requested_at && (!entry.last_at || entry.requested_at > entry.last_at)) return true;
    return !entry?.next_at || Date.parse(entry.next_at) <= now;
  });
  await mapLimit(due, settings.maxParallel, syncOne);
  return due.length;
}

/** Refreshes one account right away, e.g. before reading its comments. */
export const refreshAccountStats = (account: Account) => syncOne(account);

async function syncOne(account: Account): Promise<void> {
  const at = new Date().toISOString();
  try {
    const stats = settings.fakePoster ? await fakeStats(account) : await readProfileStats(account, settings.statsPostsPerSync);
    await appendLines(file.accounts(), [{ at, account: account.username, followers: stats.followers, following: stats.following, posts: stats.posts }]);
    await appendLines(file.posts(), stats.media.map((m) => ({ at, account: account.username, ...m })));
    const next = new Date(Date.now() + settings.statsEveryHours * 3600_000).toISOString();
    await patchSync(account.username, { last_at: at, next_at: next, ok: true, error: undefined });
    await logAction({ action: "stats_synced", account: account.username, ok: true, detail: `${stats.media.length} posts` });
  } catch (e) {
    if (e instanceof BrowserBusyError) return; // the account's window is in use; the next tick tries again
    const message = errorMessage(e);
    if (/signed out|different Instagram account/i.test(message)) await patchAccount(account.username, { status: "needs_sign_in" });
    const next = new Date(Date.now() + RETRY_AFTER_FAILURE_MS).toISOString();
    await patchSync(account.username, { last_at: at, next_at: next, ok: false, error: message });
    await logAction({ action: "stats_failed", account: account.username, ok: false, detail: message });
  }
}

export interface PostRow {
  account: string;
  code: string;
  url: string;
  kind: PostKind;
  posted_at: string;
  caption: string;
  likes?: number;
  comments?: number;
  views?: number;
  /** The snapshot nearest to 24 hours after posting, when one exists: how fast it took off. */
  first_day?: { likes?: number; comments?: number; views?: number };
  by_feedpilot: boolean;
  engagement: number;
  checked_at: string;
}

const postUrl = (kind: PostKind, code: string) => `https://www.instagram.com/${kind === "reel" ? "reel" : "p"}/${code}/`;

export async function postRows(opts: { username?: string; days: number }): Promise<PostRow[]> {
  const name = opts.username ? normalizeUsername(opts.username) : undefined;
  const since = Date.now() - opts.days * 86400_000;
  const snapshots = (await readLines<PostSnapshot>(file.posts())).filter((s) => !name || s.account === name);
  const byCode = new Map<string, PostSnapshot[]>();
  for (const snap of snapshots) byCode.set(snap.code, [...(byCode.get(snap.code) ?? []), snap]);
  const feedpilotCodes = new Set((await getJobs()).map((j) => j.result?.code).filter((c): c is string => !!c));

  const rows: PostRow[] = [];
  for (const [code, snaps] of byCode) {
    const latest = snaps.reduce((a, b) => (a.at > b.at ? a : b));
    if (Date.parse(latest.posted_at) < since) continue;
    const dayMark = Date.parse(latest.posted_at) + 24 * 3600_000;
    const nearDay = snaps
      .filter((s) => Math.abs(Date.parse(s.at) - dayMark) <= 8 * 3600_000)
      .sort((a, b) => Math.abs(Date.parse(a.at) - dayMark) - Math.abs(Date.parse(b.at) - dayMark))[0];
    rows.push({
      account: latest.account,
      code,
      url: postUrl(latest.kind, code),
      kind: latest.kind,
      posted_at: latest.posted_at,
      caption: latest.caption,
      likes: latest.likes,
      comments: latest.comments,
      views: latest.views,
      first_day: nearDay ? { likes: nearDay.likes, comments: nearDay.comments, views: nearDay.views } : undefined,
      by_feedpilot: feedpilotCodes.has(code),
      engagement: (latest.likes ?? 0) + (latest.comments ?? 0),
      checked_at: latest.at,
    });
  }
  return rows;
}

export interface AccountReport {
  account: string;
  synced_at?: string;
  sync_error?: string;
  followers?: number;
  following?: number;
  posts?: number;
  followers_change?: number;
  change_since?: string;
  posts_in_period: number;
  likes: number;
  comments: number;
  views: number;
  best?: PostRow;
}

export async function accountReports(opts: { username?: string; days: number }): Promise<AccountReport[]> {
  const name = opts.username ? normalizeUsername(opts.username) : undefined;
  const since = Date.now() - opts.days * 86400_000;
  const accounts = (await getAccounts()).filter((a) => !name || a.username === name);
  const snapshots = await readLines<AccountSnapshot>(file.accounts());
  const sync = await getSyncState();
  const rows = await postRows({ username: name, days: opts.days });

  return accounts.map((account) => {
    const mine = snapshots.filter((s) => s.account === account.username).sort((a, b) => a.at.localeCompare(b.at));
    const latest = mine[mine.length - 1];
    const first = mine.find((s) => Date.parse(s.at) >= since);
    const posts = rows.filter((r) => r.account === account.username);
    const best = [...posts].sort((a, b) => b.engagement - a.engagement || (b.views ?? 0) - (a.views ?? 0))[0];
    return {
      account: account.username,
      synced_at: sync[account.username]?.last_at,
      sync_error: sync[account.username]?.ok === false ? sync[account.username]?.error : undefined,
      followers: latest?.followers,
      following: latest?.following,
      posts: latest?.posts,
      followers_change: first && latest && first !== latest && first.followers !== undefined && latest.followers !== undefined ? latest.followers - first.followers : undefined,
      change_since: first && first !== latest ? first.at : undefined,
      posts_in_period: posts.length,
      likes: posts.reduce((sum, p) => sum + (p.likes ?? 0), 0),
      comments: posts.reduce((sum, p) => sum + (p.comments ?? 0), 0),
      views: posts.reduce((sum, p) => sum + (p.views ?? 0), 0),
      best,
    };
  });
}

export async function latestFollowers(): Promise<Map<string, number>> {
  const latest = new Map<string, AccountSnapshot>();
  for (const snap of await readLines<AccountSnapshot>(file.accounts())) {
    const current = latest.get(snap.account);
    if (snap.followers !== undefined && (!current || snap.at > current.at)) latest.set(snap.account, snap);
  }
  return new Map([...latest].map(([account, snap]) => [account, snap.followers!]));
}

// Test-only stand-in for Instagram, selected with FEEDPILOT_FAKE_POSTER: numbers grow with every sync.
async function fakeStats(account: Account): Promise<ProfileStats> {
  const round = (await readLines<AccountSnapshot>(file.accounts())).filter((s) => s.account === account.username).length;
  const day = 86400_000;
  return {
    followers: 100 + round * 10,
    following: 50,
    posts: 2,
    media: [
      { code: `FAKE${account.username}PHOTO`, kind: "photo", posted_at: new Date(Date.now() - 2 * day).toISOString(), caption: "Fake photo", likes: 10 + round, comments: 2 },
      { code: `FAKE${account.username}REEL`, kind: "reel", posted_at: new Date(Date.now() - day).toISOString(), caption: "Fake reel", likes: 50 + round * 5, comments: 6, views: 1000 + round * 100 },
    ],
  };
}
