import type { Locator, Page } from "playwright-core";
import { dismissPopups, openProfile, screenshot } from "../browser.js";
import type { Account, PostKind } from "../store.js";
import { errorMessage } from "../util.js";
import { labels } from "./labels.js";
import { gotoHome, IG, sessionUserId } from "./session.js";

export type ShareStage = "before_share" | "after_share";

/** stage tells the queue whether a retry could double-post: after_share means it might already be live or scheduled. */
export class PostError extends Error {
  constructor(message: string, readonly step: string, readonly stage: ShareStage, readonly screenshot?: string) {
    super(message);
  }
}

/** The account's New post window has no "Schedule content" option, so Feedpilot has to post at the time itself. */
export class NoInstagramSchedulerError extends Error {}

export interface PublishInput {
  account: Account;
  files: string[];
  caption: string;
  kind: PostKind;
}

export interface PublishResult {
  url?: string;
  code?: string;
  screenshot?: string;
  note?: string;
  /** Handed to Instagram's own scheduler rather than published now. */
  scheduled?: boolean;
  /** Profile grid before scheduling, used later to find the post once Instagram publishes it. */
  profileBefore?: string[];
}

/**
 * Runs Instagram's own New post flow on instagram.com. With scheduleAt, Instagram's "Schedule content"
 * option holds the post until then. With dryRun it fills everything in and stops before Share or Schedule.
 */
export async function publish(input: PublishInput, opts: { dryRun: boolean; scheduleAt?: Date }): Promise<PublishResult> {
  const { context, page } = await openProfile(input.account.profile_dir);
  const dialog = page.locator('div[role="dialog"]');
  let step = "open_instagram";
  let shared = false;
  const fail = async (message: string) =>
    new PostError(message, step, shared ? "after_share" : "before_share", await screenshot(page, `${input.account.username}-${step}`));

  try {
    await gotoHome(page);
    await dismissPopups(page);

    step = "check_account";
    const userId = await sessionUserId(context);
    if (!userId) throw await fail(`@${input.account.username} is signed out. Connect it again with connect_account.`);
    if (userId !== input.account.user_id) throw await fail(`A different Instagram account is signed in to @${input.account.username}'s window.`);

    // The new post's link is found afterwards by comparing the profile grid with this snapshot.
    step = "read_profile";
    const postsBefore = opts.dryRun ? [] : await profilePostCodes(page, input.account.username);

    step = "open_new_post";
    const fileInput = await openNewPost(page);
    if (!fileInput) throw await fail("Couldn't open Instagram's New post window.");

    step = "add_files";
    await fileInput.setInputFiles(input.files);
    await page.waitForTimeout(2500);
    // First video upload shows "Video posts are now shared as reels".
    await clickIfVisible(dialog.getByRole("button", { name: labels.ok }).first());

    step = "go_to_caption";
    const captionBox = await advanceToCaption(page);
    if (!captionBox) throw await fail("Couldn't reach the caption step of the New post window.");

    step = "write_caption";
    if (input.caption) {
      const written = await writeCaption(page, captionBox, input.caption);
      // A caption ending in a #hashtag or @mention leaves Instagram's suggestion list open; clicking
      // the window title closes it without touching the text.
      await clickIfVisible(dialog.getByRole("heading").first());
      if (!written || normalized(await captionBox.innerText()) !== normalized(input.caption)) {
        throw await fail("The caption didn't go in exactly as written.");
      }
    }

    step = "share_settings";
    if (!(await turnOffCrossPosting(page))) throw await fail("Couldn't turn off sharing to Facebook or Threads for this post.");

    if (opts.scheduleAt) {
      step = "set_schedule";
      await setSchedule(page, opts.scheduleAt);
    }

    if (opts.dryRun) {
      const when = opts.scheduleAt ? ` and Instagram's scheduler is set for ${scheduleLabel(opts.scheduleAt)}` : "";
      return {
        screenshot: await screenshot(page, `${input.account.username}-test-ready`),
        note: `Test run: every step was filled in${when}, sharing to Facebook/Threads is off, then the window closed before ${opts.scheduleAt ? "Schedule" : "Share"}. Nothing was posted or scheduled.`,
      };
    }

    step = opts.scheduleAt ? "schedule" : "share";
    await dialog.getByRole("button", { name: opts.scheduleAt ? labels.schedule : labels.share }).first().click({ timeout: 10_000 });
    shared = true;

    step = "wait_for_confirmation";
    const success = opts.scheduleAt ? labels.scheduled : labels.shared;
    const outcome = await waitForOutcome(page, success, input.kind === "reel" ? 15 * 60_000 : 5 * 60_000);
    if (outcome === "failed") {
      shared = false; // Instagram itself reported that nothing went through, so a retry is safe
      throw await fail(`Instagram said the post couldn't be ${opts.scheduleAt ? "scheduled" : "shared"}.`);
    }
    if (outcome === "unknown") {
      throw await fail(
        `${opts.scheduleAt ? "Schedule" : "Share"} was clicked, but Instagram's confirmation never appeared. Check the profile${opts.scheduleAt ? " and the app's Scheduled content" : ""} before trying again.`,
      );
    }
    const confirmation = await screenshot(page, `${input.account.username}-${opts.scheduleAt ? "scheduled" : "shared"}`);
    if (opts.scheduleAt) return { scheduled: true, profileBefore: postsBefore, screenshot: confirmation };

    step = "find_link";
    const link = await findNewPost(page, input.account.username, postsBefore);
    return { ...(link ?? { note: "Posted. The link wasn't on the profile yet." }), screenshot: confirmation };
  } catch (e) {
    if (e instanceof PostError || e instanceof NoInstagramSchedulerError) throw e;
    throw await fail(errorMessage(e));
  } finally {
    await context.close().catch(() => {});
  }
}

/** After Instagram's scheduled time: finds the post on the profile by its caption. */
export async function findScheduledPost(account: Account, before: string[], caption: string): Promise<PublishResult | null> {
  const { context, page } = await openProfile(account.profile_dir);
  try {
    await gotoHome(page);
    const fresh = (await profilePostCodes(page, account.username)).filter((c) => !before.includes(c));
    const firstLine = normalized(caption.split("\n")[0] ?? "");
    for (const entry of fresh.slice(0, 5)) {
      const [type, code] = entry.split("/");
      const url = `${IG}/${type}/${code}/`;
      if (!firstLine) return { code, url };
      await page.goto(`${url}?hl=en`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      if (normalized(await page.evaluate(() => document.body.innerText)).includes(firstLine)) return { code, url };
    }
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click().catch(() => {});
  await locator.page().waitForTimeout(1200);
  return true;
}

export async function openNewPost(page: Page): Promise<Locator | null> {
  const dialogInput = page.locator('div[role="dialog"] input[type="file"]');
  const triggers = [
    ...labels.newPostIcon.map((name) => page.locator(`svg[aria-label="${name}"]`).first()),
    page.getByRole("link", { name: labels.create }).first(),
    page.getByRole("button", { name: labels.create }).first(),
  ];
  for (const trigger of triggers) {
    if (!(await clickIfVisible(trigger))) continue;
    // Newer layouts open a small menu (Post, Live video, Ad) before the upload window.
    const postItem = page
      .locator('svg[aria-label="Post"]')
      .or(page.getByRole("menuitem", { name: labels.postMenuItem }))
      .or(page.getByRole("link", { name: labels.postMenuItem }))
      .first();
    await clickIfVisible(postItem);
    if ((await dialogInput.count()) > 0) return dialogInput.first();
  }
  const anyInput = page.locator('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
  return (await anyInput.count()) > 0 ? anyInput.first() : null;
}

// Crop and Edit come before the caption step; each has a Next button. A video needs a
// few seconds of processing before Next responds, so keep trying until the deadline.
export async function advanceToCaption(page: Page, timeoutMs = 60_000): Promise<Locator | null> {
  const dialog = page.locator('div[role="dialog"]');
  const captionBox = dialog.locator('div[contenteditable="true"]').first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await captionBox.isVisible().catch(() => false)) return captionBox;
    await clickIfVisible(dialog.getByRole("button", { name: labels.next }).first());
    await page.waitForTimeout(1500);
  }
  return null;
}

const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

/** Pastes the caption (keeps line breaks and emoji), falls back to typing, and reads it back before Share. */
async function writeCaption(page: Page, box: Locator, caption: string): Promise<boolean> {
  await box.click();
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, caption);
  await page.waitForTimeout(800);
  if (normalized(await box.innerText()) === normalized(caption)) return true;

  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  const lines = caption.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }
  await page.waitForTimeout(800);
  return normalized(await box.innerText()) === normalized(caption);
}

async function waitForOutcome(page: Page, success: RegExp, timeoutMs: number): Promise<"done" | "failed" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await page.locator('div[role="dialog"]').allInnerTexts().catch(() => [])).join("\n");
    if (success.test(text)) return "done";
    if (labels.shareFailed.test(text)) return "failed";
    await page.waitForTimeout(2000);
  }
  return "unknown";
}

/** "p/CODE" or "reel/CODE" for each post linked from the account's profile grid. */
async function profilePostCodes(page: Page, username: string): Promise<string[]> {
  await page.goto(`${IG}/${username}/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))
      .map((a) => (a.getAttribute("href") ?? "").match(/\/(p|reel)\/([A-Za-z0-9_-]+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${m[1]}/${m[2]}`);
    return Array.from(new Set(codes));
  });
}

async function findNewPost(page: Page, username: string, before: string[]): Promise<PublishResult | null> {
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 3000 : 5000);
    const fresh = (await profilePostCodes(page, username)).find((c) => !before.includes(c));
    if (fresh) {
      const [type, code] = fresh.split("/");
      return { code, url: `${IG}/${type}/${code}/` };
    }
  }
  return null;
}

/** Every switch in the New post window with the text of the row it sits in. */
async function switchRows(page: Page): Promise<Array<{ toggle: Locator; text: string }>> {
  const all = page.locator('div[role="dialog"]').locator('input[role="switch"], input[type="checkbox"]');
  const rows = [];
  for (let i = 0; i < (await all.count()); i++) {
    const toggle = all.nth(i);
    const text = await toggle.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      for (let k = 0; k < 8 && node; k++) {
        node = node.parentElement;
        const found = node?.innerText?.trim() ?? "";
        if (found.length > 2) return found;
      }
      return "";
    });
    rows.push({ toggle, text });
  }
  return rows;
}

/**
 * Instagram remembers "Share to Facebook" and "Share to Threads" between posts. Feedpilot only
 * posts where the user approved, so it switches those off and checks they stayed off.
 */
async function turnOffCrossPosting(page: Page): Promise<boolean> {
  const crossPost = async () => (await switchRows(page)).filter((r) => /Facebook|Threads/i.test(r.text)).map((r) => r.toggle);
  let toggles = await crossPost();
  if (!toggles.length) {
    // The "Share to" section may be collapsed; open it to see what Instagram remembered.
    await clickIfVisible(page.locator('div[role="dialog"]').getByText(/^(Share to|Condividi su)$/).first());
    toggles = await crossPost();
  }
  for (const toggle of toggles) {
    if (await toggle.isChecked().catch(() => false)) {
      await toggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }
    if (await toggle.isChecked().catch(() => false)) return false;
  }
  return true;
}

const dateLabel = (d: Date) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
const monthLabel = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(d);
const scheduleLabel = (d: Date) => `${dateLabel(d)} ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d)}`;

/** Turns on "Schedule content" and sets Instagram's date and time fields, then reads them back. */
async function setSchedule(page: Page, when: Date): Promise<void> {
  const dialog = page.locator('div[role="dialog"]');
  const row = (await switchRows(page)).find((r) => labels.scheduleSwitch.test(r.text.split("\n")[0] ?? ""));
  if (!row) throw new NoInstagramSchedulerError("This account's New post window on instagram.com has no Schedule content option.");
  if (!(await row.toggle.isChecked())) {
    await row.toggle.click({ force: true });
    await page.waitForTimeout(1200);
  }
  if (!(await row.toggle.isChecked())) throw new Error("Couldn't turn on Schedule content.");

  const dateButton = dialog.getByText(/^Date$/).first().locator("xpath=following::*[@role='button'][1]");
  if ((await dateButton.innerText()).trim() !== dateLabel(when)) {
    await dateButton.click();
    await page.waitForTimeout(800);
    for (let i = 0; i < 4 && !(await page.getByText(monthLabel(when), { exact: true }).isVisible().catch(() => false)); i++) {
      await page.getByRole("button", { name: "Next month" }).click();
      await page.waitForTimeout(500);
    }
    const day = page.locator('[role="gridcell"]').filter({ hasText: new RegExp(`^${when.getDate()}$`) }).first();
    if (!(await day.isVisible().catch(() => false)) || (await day.getAttribute("aria-disabled")) === "true") {
      throw new Error(`Instagram's scheduler doesn't allow ${dateLabel(when)}.`);
    }
    await day.click();
    await page.waitForTimeout(800);
    if ((await dateButton.innerText()).trim() !== dateLabel(when)) throw new Error("Couldn't pick the date in Instagram's calendar.");
  }

  const hours = dialog.getByRole("spinbutton", { name: "Hours" });
  const minutes = dialog.getByRole("spinbutton", { name: "Minutes" });
  const ampm = dialog.getByRole("spinbutton", { name: "AM PM" });
  const twelveHour = (await ampm.count()) > 0;
  const hour = twelveHour ? when.getHours() % 12 || 12 : when.getHours();
  const pm = when.getHours() >= 12;
  await hours.click();
  await page.keyboard.type(String(hour).padStart(2, "0"));
  await minutes.click();
  await page.keyboard.type(String(when.getMinutes()).padStart(2, "0"));
  if (twelveHour) {
    await ampm.click();
    await page.keyboard.type(pm ? "P" : "A");
  }
  await page.waitForTimeout(600);
  const valueOf = async (field: Locator) => Number(await field.getAttribute("aria-valuenow"));
  const timeOk =
    (await valueOf(hours)) === hour && (await valueOf(minutes)) === when.getMinutes() && (!twelveHour || (await valueOf(ampm)) === (pm ? 1 : 0));
  if (!timeOk) throw new Error("Instagram's time field didn't take the time.");
}
