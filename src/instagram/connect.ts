import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { dismissPopups, openProfile } from "../browser.js";
import { paths } from "../config.js";
import { accountMediaDir } from "../media.js";
import { getAccounts, logAction, patchAccount, upsertAccount, type Account } from "../store.js";
import { ensureDir, errorMessage, newId, sleep } from "../util.js";
import { currentProfile, gotoHome, IG, sessionUserId, type ProfileInfo } from "./session.js";

export interface ConnectState {
  id: string;
  status: "waiting" | "connected" | "cancelled" | "timed_out" | "failed";
  started_at: string;
  message: string;
  account?: Account;
}

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
// Sign-ins live in this process only; a restart simply means connecting again.
const connects = new Map<string, ConnectState>();

export function getConnect(id: string): ConnectState | undefined {
  return connects.get(id);
}

/** Opens a sign-in window and returns right away; a watcher finishes the job once the user has signed in. */
export async function startConnect(reconnect?: Account): Promise<ConnectState> {
  const profileDir = reconnect?.profile_dir ?? path.join(paths.profiles, newId("acct"));
  const state: ConnectState = {
    id: newId("connect"),
    status: "waiting",
    started_at: new Date().toISOString(),
    message: "Waiting for the user to sign in to Instagram in the Chrome window.",
  };
  connects.set(state.id, state);

  let opened: Awaited<ReturnType<typeof openProfile>>;
  try {
    opened = await openProfile(profileDir);
  } catch (e) {
    connects.delete(state.id);
    if (!reconnect) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const { context, page } = opened;
  context.on("close", () => {
    if (state.status === "waiting") {
      state.status = "cancelled";
      state.message = "The sign-in window was closed before signing in.";
    }
  });
  await page.goto(`${IG}/accounts/login/?hl=en`, { waitUntil: "domcontentloaded" }).catch(() => {});
  void watchSignIn(state, context, page, profileDir, reconnect);

  // A profile that is already signed in reports back within a few seconds.
  for (let i = 0; i < 8 && state.status === "waiting"; i++) await sleep(1000);
  return state;
}

async function watchSignIn(state: ConnectState, context: BrowserContext, page: Page, profileDir: string, reconnect?: Account) {
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  try {
    while (state.status === "waiting") {
      if (Date.now() > deadline) {
        state.status = "timed_out";
        state.message = "Nobody signed in within 10 minutes, so the window was closed.";
        break;
      }
      const userId = await sessionUserId(context).catch(() => null);
      if (userId) {
        await finishSignIn(state, context, page, profileDir, userId, reconnect);
        break;
      }
      await sleep(2000);
    }
  } catch (e) {
    state.status = "failed";
    state.message = `Sign-in failed: ${errorMessage(e)}`;
  } finally {
    await context.close().catch(() => {});
    if (state.status !== "connected" && !reconnect) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function finishSignIn(state: ConnectState, context: BrowserContext, page: Page, profileDir: string, userId: string, reconnect?: Account) {
  await sleep(2000); // let Instagram finish its post-login redirects
  const active = context.pages()[0] ?? page;
  await gotoHome(active).catch(() => {});
  await dismissPopups(active);

  if (reconnect && reconnect.user_id !== userId) {
    await patchAccount(reconnect.username, { status: "needs_sign_in" });
    state.status = "failed";
    state.message = `A different account was signed in to @${reconnect.username}'s window. Sign in as @${reconnect.username}, or connect the other account separately.`;
    return;
  }

  const profile = await currentProfile(active);
  const account = await registerAccount(userId, profile, profileDir);
  await logAction({ action: "connect", account: account.username, ok: true });
  state.account = account;
  state.status = "connected";
  state.message = `Connected @${account.username}.`;
  await sleep(1500);
}

async function registerAccount(userId: string, profile: ProfileInfo, profileDir: string): Promise<Account> {
  const now = new Date().toISOString();
  const existing = (await getAccounts()).find((a) => a.user_id === userId);
  const account: Account = {
    username: profile.username ?? existing?.username ?? `id${userId}`,
    user_id: userId,
    full_name: profile.full_name ?? existing?.full_name,
    account_type: profile.account_type !== "unknown" ? profile.account_type : existing?.account_type ?? "unknown",
    is_private: profile.is_private ?? existing?.is_private,
    profile_dir: profileDir,
    status: "connected",
    connected_at: existing?.connected_at ?? now,
    last_checked_at: now,
  };
  await upsertAccount(account);
  await ensureDir(accountMediaDir(account.username));
  // Connecting an account again from a fresh window leaves its old profile unused.
  if (existing && existing.profile_dir !== profileDir) await fs.rm(existing.profile_dir, { recursive: true, force: true }).catch(() => {});
  return account;
}

/** Opens the account's window briefly to confirm it is still signed in and refresh its details. */
export async function verifyAccount(account: Account): Promise<Account> {
  const { context, page } = await openProfile(account.profile_dir);
  try {
    await gotoHome(page);
    await dismissPopups(page);
    const userId = await sessionUserId(context);
    const now = new Date().toISOString();
    if (userId !== account.user_id) {
      await patchAccount(account.username, { status: "needs_sign_in", last_checked_at: now });
      return { ...account, status: "needs_sign_in", last_checked_at: now };
    }
    const profile = await currentProfile(page);
    const updated: Account = {
      ...account,
      full_name: profile.full_name ?? account.full_name,
      account_type: profile.account_type !== "unknown" ? profile.account_type : account.account_type,
      is_private: profile.is_private ?? account.is_private,
      status: "connected",
      last_checked_at: now,
    };
    await upsertAccount(updated);
    return updated;
  } finally {
    await context.close().catch(() => {});
  }
}
