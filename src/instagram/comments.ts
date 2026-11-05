import type { BrowserContext, Locator, Page } from "playwright-core";
import { dismissPopups, openProfile, screenshot } from "../browser.js";
import type { Account, PostKind } from "../store.js";
import { gotoHome, IG, sessionUserId } from "./session.js";

export interface PostComment {
  id: string;
  author: string;
  text: string;
  at: string;
  likes: number;
  replies: number;
  liked_by_me: boolean;
  mine: boolean;
  pinned: boolean;
  parent_id?: string;
}

export interface PostComments {
  code: string;
  url: string;
  kind: PostKind;
  comments: PostComment[];
}

/** An action that may or may not have gone through, so it must not be repeated blindly. */
export class CommentActionUncertainError extends Error {}

export const postUrl = (kind: PostKind, code: string) => `${IG}/${kind === "reel" ? "reel" : "p"}/${code}/`;
const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

/** Comments a post page carries in its embedded data and in what it fetches while open. */
async function commentsOnPage(page: Page, account: Account, fetched: any[]): Promise<PostComment[]> {
  const embedded: any[] = await page.evaluate(() => {
    const found: any[] = [];
    const walk = (node: any, depth: number) => {
      if (!node || typeof node !== "object" || depth > 80) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node.text === "string" && "created_at" in node && node.user?.username && (node.pk || node.id)) found.push(node);
      // A post caption looks like a comment in this data; it sits under "caption".
      for (const [key, value] of Object.entries(node)) if (key !== "caption") walk(value, depth + 1);
    };
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      const text = script.textContent ?? "";
      if (!text.includes("comments_connection")) continue;
      try {
        walk(JSON.parse(text), 0);
      } catch {
        // not every script is plain JSON
      }
    }
    return found.map((n) => ({
      pk: String(n.pk ?? n.id),
      text: n.text,
      created_at: n.created_at,
      username: n.user.username,
      likes: n.comment_like_count,
      replies: n.child_comment_count,
      liked: n.has_liked_comment,
      parent: n.parent_comment_id,
      pinned: n.is_pinned,
    }));
  });
  const all = new Map<string, PostComment>();
  for (const n of [...embedded, ...fetched]) {
    all.set(n.pk, {
      id: n.pk,
      author: n.username,
      text: n.text,
      at: new Date(Number(n.created_at) * 1000).toISOString(),
      likes: Number(n.likes ?? 0),
      replies: Number(n.replies ?? 0),
      liked_by_me: !!n.liked,
      mine: n.username === account.username,
      pinned: !!n.pinned,
      parent_id: n.parent ? String(n.parent) : undefined,
    });
  }
  return [...all.values()].sort((a, b) => a.at.localeCompare(b.at));
}

async function openSignedIn(account: Account): Promise<{ context: BrowserContext; page: Page }> {
  const opened = await openProfile(account.profile_dir);
  try {
    await gotoHome(opened.page);
    await dismissPopups(opened.page);
    const userId = await sessionUserId(opened.context);
    if (!userId) throw new Error(`@${account.username} is signed out. Connect it again with connect_account.`);
    if (userId !== account.user_id) throw new Error(`A different Instagram account is signed in to @${account.username}'s window.`);
    return opened;
  } catch (e) {
    await opened.context.close().catch(() => {});
    throw e;
  }
}

/** Reads the comments on the given posts, one browser window for all of them. */
export async function readComments(account: Account, posts: Array<{ code: string; kind: PostKind }>): Promise<PostComments[]> {
  const { context, page } = await openSignedIn(account);
  const fetched: any[] = [];
  page.on("response", async (response) => {
    if (!/graphql|\/api\/v1\//.test(response.url())) return;
    try {
      const body = await response.text();
      if (!body.includes("comment")) return;
      const walk = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node.text === "string" && "created_at" in node && node.user?.username && (node.pk || node.id)) {
          fetched.push({
            pk: String(node.pk ?? node.id),
            text: node.text,
            created_at: node.created_at,
            username: node.user.username,
            likes: node.comment_like_count,
            replies: node.child_comment_count,
            liked: node.has_liked_comment,
            parent: node.parent_comment_id,
            pinned: node.is_pinned,
          });
        }
        for (const [key, value] of Object.entries(node)) if (key !== "caption") walk(value);
      };
      walk(JSON.parse(body));
    } catch {
      // not JSON, or the window already closed
    }
  });
  const out: PostComments[] = [];
  try {
    for (const post of posts) {
      fetched.length = 0;
      await page.goto(`${postUrl(post.kind, post.code)}?hl=en`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
      out.push({ code: post.code, url: postUrl(post.kind, post.code), kind: post.kind, comments: await commentsOnPage(page, account, fetched) });
    }
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

/** Marks the comment's row on the open post page and returns it: the innermost block holding the author's link, the text and a Reply button. */
export async function findComment(page: Page, comment: PostComment): Promise<Locator | null> {
  const prefix = normalized(comment.text).slice(0, 40);
  const found = await page.evaluate(
    ({ author, prefix }) => {
      const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      document.querySelectorAll("[data-feedpilot-target]").forEach((e) => e.removeAttribute("data-feedpilot-target"));
      let best: HTMLElement | null = null;
      // Links carry query strings such as ?hl=en, so compare the path only.
      const authorLinks = Array.from(document.querySelectorAll("a[href]")).filter((a) => (a.getAttribute("href") ?? "").split("?")[0].replace(/\/$/, "") === `/${author}`);
      for (const link of authorLinks) {
        let el: HTMLElement | null = link as HTMLElement;
        for (let i = 0; i < 12 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          const hasReply = Array.from(el.querySelectorAll('[role="button"], button, span')).some((b) => norm((b as HTMLElement).innerText) === "Reply");
          if (norm(el.innerText).includes(prefix) && hasReply) {
            if (!best || norm(el.innerText).length < norm(best.innerText).length) best = el;
            break;
          }
        }
      }
      if (!best) return false;
      best.setAttribute("data-feedpilot-target", "1");
      return true;
    },
    { author: comment.author, prefix },
  );
  return found ? page.locator('[data-feedpilot-target="1"]').first() : null;
}

async function openComment(account: Account, post: PostComments, comment: PostComment) {
  const { context, page } = await openSignedIn(account);
  await page.goto(`${post.url}?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await dismissPopups(page);
  const row = await findComment(page, comment);
  if (!row) {
    await context.close().catch(() => {});
    throw new Error(`Couldn't find @${comment.author}'s comment on that post. It may have been deleted, or it is further down than the first page of comments.`);
  }
  return { context, page, row };
}

async function commentBoxValue(box: Locator): Promise<string> {
  return box.evaluate((el) => (el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement).innerText));
}

export async function replyToComment(account: Account, post: PostComments, comment: PostComment, text: string): Promise<void> {
  const { context, page, row } = await openComment(account, post, comment);
  let posted = false;
  try {
    await row.getByText(/^Reply$/).first().click();
    await page.waitForTimeout(1000);
    const box = page.locator('textarea[aria-label^="Add a comment"], [role="textbox"][aria-label^="Add a comment"], textarea[placeholder^="Add a comment"]').first();
    await box.click();
    // Instagram starts a reply with the person's @username; keep it so the reply is threaded under their comment.
    if (!normalized(await commentBoxValue(box)).startsWith(`@${comment.author}`)) await page.keyboard.insertText(`@${comment.author} `);
    await page.keyboard.press("End");
    await page.keyboard.insertText(text);
    await page.waitForTimeout(500);
    if (!normalized(await commentBoxValue(box)).includes(normalized(text))) throw new Error("The reply didn't go into the comment box exactly as written, so nothing was posted.");
    posted = true;
    await page.getByRole("button", { name: /^Post$/ }).first().click();
    await page.waitForTimeout(3500);
    if (!normalized(await page.evaluate(() => document.body.innerText)).includes(normalized(text).slice(0, 80))) {
      throw new CommentActionUncertainError(`Post was clicked but the reply didn't clearly appear. Check the post before replying again. (${(await screenshot(page, `${account.username}-comment-reply`)) ?? "no screenshot"})`);
    }
  } catch (e) {
    if (posted && !(e instanceof CommentActionUncertainError)) throw new CommentActionUncertainError(`Something went wrong after Post was clicked: ${String((e as Error)?.message ?? e)}`);
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function likeComment(account: Account, post: PostComments, comment: PostComment): Promise<void> {
  const { context, row } = await openComment(account, post, comment);
  try {
    if ((await row.locator('svg[aria-label="Unlike"]').count()) > 0) return; // already liked
    await row.locator('svg[aria-label="Like"]').first().click();
    await row.page().waitForTimeout(1500);
    if ((await row.locator('svg[aria-label="Unlike"]').count()) === 0) throw new CommentActionUncertainError("Like was clicked but Instagram didn't show the comment as liked.");
  } finally {
    await context.close().catch(() => {});
  }
}

export async function deleteComment(account: Account, post: PostComments, comment: PostComment): Promise<void> {
  const { context, page, row } = await openComment(account, post, comment);
  let pressed = false;
  try {
    await row.hover();
    await page.waitForTimeout(600);
    const options = row.locator('svg[aria-label="Comment Options"], svg[aria-label="More options"]').first();
    if (!(await options.isVisible().catch(() => false))) throw new Error("Couldn't find the comment's options menu, so nothing was deleted.");
    await options.click();
    await page.waitForTimeout(1000);
    const remove = page.locator('div[role="dialog"]').getByRole("button", { name: /^Delete$/ }).first();
    if (!(await remove.isVisible().catch(() => false))) throw new Error("The comment's menu has no Delete option, so nothing was deleted.");
    pressed = true;
    await remove.click();
    await page.waitForTimeout(2500);
    if (await findComment(page, comment)) throw new CommentActionUncertainError("Delete was clicked but the comment is still showing. Check the post.");
  } catch (e) {
    if (pressed && !(e instanceof CommentActionUncertainError)) throw new CommentActionUncertainError(`Something went wrong after Delete was clicked: ${String((e as Error)?.message ?? e)}`);
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}
