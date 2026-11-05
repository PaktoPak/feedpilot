import fs from "node:fs/promises";
import path from "node:path";
import { BrowserBusyError } from "./browser.js";
import { paths, settings } from "./config.js";
import { readInbox, ReplyUncertainError, sendMessage, type Chat, type ChatMessage } from "./instagram/inbox.js";
import { UserError } from "./jobs.js";
import { withLockOrThrow } from "./lock.js";
import { getAccount, getAccounts, logAction, patchAccount } from "./store.js";
import { appendJsonLines, errorMessage, mapLimit, normalizeUsername, readJson, readJsonLines, writeJsonAtomic } from "./util.js";

const REPLY_MAX_CHARS = 1000;
const dir = () => path.join(paths.state, "messages");
const inboxFile = (username: string) => path.join(dir(), `inbox-${username}.json`);
const historyFile = () => path.join(dir(), "history.jsonl");
const repliesFile = () => path.join(dir(), "replies.jsonl");

interface InboxSnapshot {
  read_at: string;
  chats: Chat[];
}

export interface StoredMessage extends ChatMessage {
  account: string;
  chat: string;
  chat_title: string;
}

export interface InboxResult {
  account: string;
  read_at: string;
  chats?: Chat[];
  error?: string;
}

/** Reads every requested account's inbox, several accounts at once, and saves what it saw. */
export async function readInboxes(usernames?: string[]): Promise<InboxResult[]> {
  const names = usernames?.map(normalizeUsername);
  const accounts = (await getAccounts()).filter((a) => !names || names.includes(a.username));
  return mapLimit(accounts, settings.maxParallel, async (account) => {
    const read_at = new Date().toISOString();
    try {
      const chats = settings.fakePoster ? fakeInbox() : await readInbox(account);
      await saveInbox(account.username, chats, read_at);
      await logAction({ action: "inbox_read", account: account.username, ok: true, detail: `${chats.length} chats` });
      return { account: account.username, read_at, chats };
    } catch (e) {
      const message = e instanceof BrowserBusyError ? "its browser window is busy with another task; try again in a minute" : errorMessage(e);
      if (/signed out|different Instagram account/i.test(message)) await patchAccount(account.username, { status: "needs_sign_in" });
      return { account: account.username, read_at, error: message };
    }
  });
}

async function saveInbox(username: string, chats: Chat[], at: string): Promise<void> {
  await writeJsonAtomic(inboxFile(username), { read_at: at, chats } satisfies InboxSnapshot);
  if (!settings.storeMessages) return;
  await withLockOrThrow("messages", async () => {
    const seen = new Set((await readJsonLines<StoredMessage>(historyFile())).map((m) => `${m.account}:${m.id}`));
    const fresh = chats.flatMap((chat) =>
      chat.messages
        .filter((m) => !seen.has(`${username}:${m.id}`))
        .map((m) => ({ account: username, chat: chat.key, chat_title: chat.title, ...m })),
    );
    await appendJsonLines(historyFile(), fresh);
  });
}

/** Sends a reply the user approved, in a chat Feedpilot has seen in that account's inbox. */
export async function sendReply(args: { username: string; chat: string; text: string; acceptRequest: boolean }): Promise<string> {
  const account = await getAccount(args.username);
  if (!account) throw new UserError(`@${normalizeUsername(args.username)} isn't connected.`);
  const snapshot = await readJson<InboxSnapshot | null>(inboxFile(account.username), null);
  const chat = snapshot?.chats.find((c) => c.key === args.chat);
  // Replies only go into existing chats; there is deliberately no way to message someone new.
  if (!chat) throw new UserError("Feedpilot only replies in chats it has seen in this account's inbox. Call get_inbox, then use a chat id from it.");
  if (chat.folder === "requests" && !args.acceptRequest) {
    throw new UserError(`This is a message request from ${chat.title}. Replying accepts it. Ask the user first, then call again with accept_request true.`);
  }
  const text = args.text.trim();
  if (!text) throw new UserError("The reply is empty.");
  if (text.length > REPLY_MAX_CHARS) throw new UserError(`The reply is ${text.length} characters; Instagram allows ${REPLY_MAX_CHARS}.`);
  const lastHour = (await readJsonLines<{ at: string; account: string }>(repliesFile())).filter(
    (r) => r.account === account.username && Date.now() - Date.parse(r.at) < 3600_000,
  ).length;
  if (lastHour >= settings.maxRepliesPerHour) {
    throw new UserError(`@${account.username} already sent ${lastHour} replies in the last hour, the limit is ${settings.maxRepliesPerHour}. Wait a bit, or raise the limit in the extension's settings.`);
  }

  try {
    if (!settings.fakePoster) await sendMessage(account, chat, text);
  } catch (e) {
    if (e instanceof BrowserBusyError) throw new UserError(`@${account.username}'s browser window is busy with another task. Try again in a minute.`);
    await logAction({ action: "reply_failed", account: account.username, ok: false, detail: `${chat.title}: ${errorMessage(e)}` });
    throw new UserError(errorMessage(e));
  }
  await appendJsonLines(repliesFile(), [{ at: new Date().toISOString(), account: account.username, chat: chat.key, chars: text.length }]);
  await logAction({ action: "reply_sent", account: account.username, ok: true, detail: chat.title });
  return `Sent to ${chat.title} from @${account.username}.${chat.folder === "requests" ? " The message request is now accepted." : ""}`;
}

/** Deletes the saved message history and inbox snapshots on this computer. Instagram isn't touched. */
export async function forgetMessages(username?: string): Promise<number> {
  const name = username ? normalizeUsername(username) : undefined;
  return withLockOrThrow("messages", async () => {
    const all = await readJsonLines<StoredMessage>(historyFile());
    const keep = all.filter((m) => name && m.account !== name);
    await fs.rm(historyFile(), { force: true });
    await appendJsonLines(historyFile(), keep);
    const accounts = name ? [name] : (await getAccounts()).map((a) => a.username);
    for (const account of accounts) await fs.rm(inboxFile(account), { force: true });
    return all.length - keep.length;
  });
}

export async function messageHistory(opts: { username?: string; days: number }): Promise<StoredMessage[]> {
  const name = opts.username ? normalizeUsername(opts.username) : undefined;
  const since = Date.now() - opts.days * 86400_000;
  return (await readJsonLines<StoredMessage>(historyFile())).filter((m) => (!name || m.account === name) && Date.parse(m.at) >= since);
}

// Test-only stand-in for Instagram, selected with FEEDPILOT_FAKE_POSTER.
function fakeInbox(): Chat[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return [
    {
      key: "1001",
      title: "Fan One",
      people: [{ username: "fan_one", full_name: "Fan One" }],
      folder: "primary",
      is_group: false,
      last_activity: at(5),
      waiting_for_reply: true,
      marked_unread: false,
      messages: [
        { id: "m1", from_me: true, at: at(60), type: "text", text: "Thanks for following!" },
        { id: "m2", from_me: false, sender: "fan_one", at: at(5), type: "text", text: "Do you ship to Italy?" },
      ],
    },
    {
      key: "1002",
      title: "Brand X",
      people: [{ username: "brand_x" }],
      folder: "requests",
      is_group: false,
      last_activity: at(30),
      waiting_for_reply: true,
      marked_unread: false,
      messages: [{ id: "m3", from_me: false, sender: "brand_x", at: at(30), type: "text", text: "Interested in a collab?" }],
    },
    {
      key: "1003",
      title: "Old Friend",
      people: [{ username: "old_friend" }],
      folder: "primary",
      is_group: false,
      last_activity: at(600),
      waiting_for_reply: false,
      marked_unread: false,
      messages: [{ id: "m4", from_me: true, at: at(600), type: "share", text: "Shared a post" }],
    },
  ];
}
