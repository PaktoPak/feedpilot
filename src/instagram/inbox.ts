import type { Page } from "playwright-core";
import { dismissPopups, openProfile, screenshot } from "../browser.js";
import type { Account } from "../store.js";
import { gotoHome, IG, sessionUserId } from "./session.js";

export type ChatFolder = "primary" | "general" | "requests";

export interface ChatMessage {
  id: string;
  from_me: boolean;
  sender?: string;
  at: string;
  type: "text" | "link" | "share" | "media" | "other";
  text?: string;
}

export interface Chat {
  key: string;
  title: string;
  people: Array<{ username?: string; full_name?: string }>;
  folder: ChatFolder;
  is_group: boolean;
  last_activity: string;
  /** The newest message is from the other side. */
  waiting_for_reply: boolean;
  marked_unread: boolean;
  messages: ChatMessage[];
}

/** A reply that may or may not have gone out, so it must not be sent again blindly. */
export class ReplyUncertainError extends Error {}

const MAILBOX = "get_slide_mailbox_for_iris_subscription";

function messageType(contentType: string | undefined): ChatMessage["type"] {
  if (!contentType || contentType === "TEXT") return "text";
  if (/LINK/i.test(contentType)) return "link";
  if (/IMAGE|PHOTO|VIDEO|MEDIA|AUDIO|VOICE/i.test(contentType)) return "media";
  if (/XMA|SHARE|MONTAGE/i.test(contentType)) return "share";
  return "other";
}

/** The folder the thread itself names, if it names one. */
function folderOf(thread: any): ChatFolder | undefined {
  const tags = `${thread.folder ?? ""} ${thread.system_folder ?? ""} ${thread.messaging_folder_tag ?? ""}`;
  if (/PENDING|REQUEST/i.test(tags)) return "requests";
  if (/GENERAL/i.test(tags)) return "general";
  if (/PRIMARY|INBOX/i.test(tags)) return "primary";
  return undefined;
}

function toChat(thread: any, viewerFbid: string | undefined, page: ChatFolder): Chat & { folderKnown: boolean } {
  const people = (thread.usersWithoutViewer ?? thread.users ?? []).map((u: any) => ({ username: u.username, full_name: u.full_name || undefined }));
  const byFbid = new Map<string, string>((thread.users ?? []).map((u: any) => [String(u.interop_messaging_user_fbid), u.username]));
  const messages: ChatMessage[] = (thread.slide_messages?.edges ?? [])
    .map((edge: any) => edge.node)
    .filter((m: any) => m && m.timestamp_ms)
    .map((m: any) => {
      const fromMe = !!viewerFbid && String(m.sender_fbid) === String(viewerFbid);
      return {
        id: String(m.id),
        from_me: fromMe,
        sender: fromMe ? undefined : byFbid.get(String(m.sender_fbid)),
        at: new Date(Number(m.timestamp_ms)).toISOString(),
        type: messageType(m.content_type),
        text: m.text_body || m.igd_snippet || undefined,
      };
    })
    .sort((a: ChatMessage, b: ChatMessage) => a.at.localeCompare(b.at));
  const last = messages[messages.length - 1];
  const folder = folderOf(thread);
  return {
    // id is present on every copy of a thread, including the partial ones; it also opens the chat at /direct/t/<id>/.
    key: String(thread.id ?? thread.thread_key),
    title: thread.thread_title || people.map((p: { username?: string }) => p.username).filter(Boolean).join(", ") || "Chat",
    people,
    folder: folder ?? page,
    folderKnown: !!folder,
    is_group: !!thread.is_group,
    last_activity: new Date(Number(thread.last_activity_timestamp_ms ?? last?.at ?? Date.now())).toISOString(),
    waiting_for_reply: !!last && !last.from_me,
    marked_unread: !!thread.marked_as_unread,
    messages,
  };
}

/**
 * Reads the account's chats from the data instagram.com's inbox and requests pages load for
 * themselves. No chat is opened, so nobody sees "Seen".
 */
export async function readInbox(account: Account): Promise<Chat[]> {
  const { context, page } = await openProfile(account.profile_dir);
  const captured: Array<{ data: any; page: ChatFolder }> = [];
  let current: ChatFolder | null = null;

  page.on("response", async (response) => {
    const at = current;
    if (!at || !/graphql/.test(response.url())) return;
    try {
      const body = await response.text();
      if (body.includes(MAILBOX)) captured.push({ data: JSON.parse(body), page: at });
    } catch {
      // not JSON, or the window already closed
    }
  });

  try {
    await gotoHome(page);
    await dismissPopups(page);
    await checkSignedIn(account, page);
    const pages: Array<[ChatFolder, string]> = [["primary", "/direct/inbox/"], ["requests", "/direct/requests/"]];
    if (account.account_type === "business" || account.account_type === "creator") pages.splice(1, 0, ["general", "/direct/general/"]);
    for (const [folder, path] of pages) {
      current = folder;
      await page.goto(`${IG}${path}?hl=en`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5500);
    }
    current = null;
  } finally {
    await context.close().catch(() => {});
  }

  const threads = captured.flatMap(({ data, page: folder }) =>
    (data?.data?.[MAILBOX]?.threads_by_folder?.edges ?? []).map((edge: any) => ({ thread: edge?.node?.as_ig_direct_thread, folder })),
  );
  const viewerFbid = threads.map((t) => t.thread?.viewer?.interop_messaging_user_fbid).find(Boolean);
  const chats = new Map<string, ReturnType<typeof toChat>>();
  for (const { thread, folder } of threads) {
    if (!thread) continue;
    const chat = toChat(thread, viewerFbid, folder);
    const known = chats.get(chat.key);
    if (!known) {
      chats.set(chat.key, chat);
      continue;
    }
    // Some responses are partial copies of a chat; keep the fullest one, and a folder the thread itself names.
    const fuller = chat.messages.length > known.messages.length ? chat : known;
    const other = fuller === chat ? known : chat;
    if (!fuller.folderKnown && other.folderKnown) Object.assign(fuller, { folder: other.folder, folderKnown: true });
    chats.set(chat.key, fuller);
  }
  return [...chats.values()]
    // A copy with no folder and no messages is an echo of a chat already listed elsewhere, not a chat of its own.
    .filter((c) => c.folderKnown || c.messages.length > 0)
    .map(({ folderKnown: _, ...chat }) => chat)
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity));
}

async function checkSignedIn(account: Account, page: Page): Promise<void> {
  const userId = await sessionUserId(page.context());
  if (!userId) throw new Error(`@${account.username} is signed out. Connect it again with connect_account.`);
  if (userId !== account.user_id) throw new Error(`A different Instagram account is signed in to @${account.username}'s window.`);
}

const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

/** Opens the chat (which shows the other side "Seen"), writes the reply, sends it and checks it appeared. */
export async function sendMessage(account: Account, chat: Chat, text: string): Promise<{ screenshot?: string }> {
  const { context, page } = await openProfile(account.profile_dir);
  let pressedSend = false;
  try {
    await gotoHome(page);
    await dismissPopups(page);
    await checkSignedIn(account, page);
    await page.goto(`${IG}/direct/t/${chat.key}/?hl=en`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    await dismissPopups(page);

    const body = await page.evaluate(() => document.body.innerText);
    const names = [chat.title, ...chat.people.flatMap((p) => [p.username, p.full_name])].filter((n): n is string => !!n);
    if (!names.some((n) => body.includes(n))) throw new Error("The chat that opened doesn't look like the right one, so nothing was sent.");

    const box = page.locator('div[role="textbox"][contenteditable="true"]').first();
    if (!(await box.isVisible().catch(() => false))) throw new Error("Couldn't find the message box in that chat.");
    await box.click();
    await box.evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    await page.waitForTimeout(700);
    if (normalized(await box.innerText()) !== normalized(text)) {
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(text);
      await page.waitForTimeout(700);
    }
    if (normalized(await box.innerText()) !== normalized(text)) throw new Error("The reply didn't go into the message box exactly as written, so nothing was sent.");

    pressedSend = true;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3500);
    const boxEmpty = normalized(await box.innerText().catch(() => "")) === "";
    const shown = normalized(await page.evaluate(() => document.body.innerText)).includes(normalized(text).slice(0, 80));
    if (!boxEmpty || !shown) {
      throw new ReplyUncertainError(`Enter was pressed but the reply didn't clearly appear in the chat. Check the chat before sending again. (${await screenshot(page, `${account.username}-reply-check`) ?? "no screenshot"})`);
    }
    return { screenshot: await screenshot(page, `${account.username}-reply-sent`) };
  } catch (e) {
    if (pressedSend && !(e instanceof ReplyUncertainError)) throw new ReplyUncertainError(`Something went wrong after the reply was sent: ${String((e as Error)?.message ?? e)}`);
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}
