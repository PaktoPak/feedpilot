import path from "node:path";
import { BrowserBusyError } from "./browser.js";
import { paths, settings } from "./config.js";
import {
  deleteComment,
  likeComment,
  postUrl,
  readComments,
  replyToComment,
  type PostComment,
  type PostComments,
} from "./instagram/comments.js";
import { UserError } from "./jobs.js";
import { postRows, refreshAccountStats } from "./stats.js";
import { getAccount, getAccounts, logAction, patchAccount } from "./store.js";
import { appendJsonLines, errorMessage, mapLimit, normalizeUsername, readJson, readJsonLines, writeJsonAtomic } from "./util.js";

const CAPTION_MAX = 2200;
const dir = () => path.join(paths.state, "comments");
const snapshotFile = (username: string) => path.join(dir(), `comments-${username}.json`);
const actionsFile = () => path.join(dir(), "actions.jsonl");

interface CommentsSnapshot {
  read_at: string;
  posts: PostComments[];
}

export interface CommentsResult {
  account: string;
  read_at: string;
  posts?: PostComments[];
  error?: string;
}

/**
 * Reads comments on each account's recent posts that have any, several accounts at once.
 * Which posts have comments comes from the saved stats, refreshed first if there are none.
 */
export async function readAllComments(opts: { usernames?: string[]; days: number; postsPerAccount: number }): Promise<CommentsResult[]> {
  const names = opts.usernames?.map(normalizeUsername);
  const accounts = (await getAccounts()).filter((a) => !names || names.includes(a.username));
  return mapLimit(accounts, settings.maxParallel, async (account) => {
    const read_at = new Date().toISOString();
    try {
      let rows = await postRows({ username: account.username, days: opts.days });
      if (!rows.length) {
        await refreshAccountStats(account);
        rows = await postRows({ username: account.username, days: opts.days });
      }
      const withComments = rows
        .filter((r) => (r.comments ?? 0) > 0)
        .sort((a, b) => b.posted_at.localeCompare(a.posted_at))
        .slice(0, opts.postsPerAccount);
      const posts = settings.fakePoster ? fakeComments(account.username, withComments) : await readComments(account, withComments);
      await writeJsonAtomic(snapshotFile(account.username), { read_at, posts } satisfies CommentsSnapshot);
      await logAction({ action: "comments_read", account: account.username, ok: true, detail: `${posts.length} posts` });
      return { account: account.username, read_at, posts };
    } catch (e) {
      const message = e instanceof BrowserBusyError ? "its browser window is busy with another task; try again in a minute" : errorMessage(e);
      if (/signed out|different Instagram account/i.test(message)) await patchAccount(account.username, { status: "needs_sign_in" });
      return { account: account.username, read_at, error: message };
    }
  });
}

export type CommentAction = "reply" | "like" | "delete";

/** Carries out a reply, like or delete the user approved, on a comment Feedpilot read with get_comments. */
export async function actOnComment(args: { username: string; post: string; comment: string; action: CommentAction; text?: string }): Promise<string> {
  const account = await getAccount(args.username);
  if (!account) throw new UserError(`@${normalizeUsername(args.username)} isn't connected.`);
  const snapshot = await readJson<CommentsSnapshot | null>(snapshotFile(account.username), null);
  const post = snapshot?.posts.find((p) => p.code === args.post);
  const comment = post?.comments.find((c) => c.id === args.comment);
  if (!post || !comment) throw new UserError("Feedpilot only acts on comments it has read. Call get_comments, then use the post and comment ids from it.");

  let text = "";
  if (args.action === "reply") {
    text = (args.text ?? "").trim();
    if (!text) throw new UserError("The reply is empty.");
    if (text.length > CAPTION_MAX) throw new UserError(`The reply is ${text.length} characters; Instagram allows ${CAPTION_MAX}.`);
    const lastHour = (await readJsonLines<{ at: string; account: string; action: string }>(actionsFile())).filter(
      (a) => a.account === account.username && a.action === "reply" && Date.now() - Date.parse(a.at) < 3600_000,
    ).length;
    if (lastHour >= settings.maxRepliesPerHour) {
      throw new UserError(`@${account.username} already posted ${lastHour} comment replies in the last hour, the limit is ${settings.maxRepliesPerHour}.`);
    }
  }

  try {
    if (!settings.fakePoster) {
      if (args.action === "reply") await replyToComment(account, post, comment, text);
      else if (args.action === "like") await likeComment(account, post, comment);
      else await deleteComment(account, post, comment);
    }
  } catch (e) {
    if (e instanceof BrowserBusyError) throw new UserError(`@${account.username}'s browser window is busy with another task. Try again in a minute.`);
    await logAction({ action: `comment_${args.action}_failed`, account: account.username, ok: false, detail: `${post.code}: ${errorMessage(e)}` });
    throw new UserError(errorMessage(e));
  }

  await appendJsonLines(actionsFile(), [{ at: new Date().toISOString(), account: account.username, action: args.action, post: post.code, comment: comment.id }]);
  await logAction({ action: `comment_${args.action}`, account: account.username, ok: true, detail: `${post.code} @${comment.author}` });
  // Keep the saved copy in step, so a second like or delete isn't attempted on the same comment.
  if (args.action !== "reply") {
    const updated = snapshot!.posts.map((p) =>
      p.code !== post.code
        ? p
        : {
            ...p,
            comments:
              args.action === "delete"
                ? p.comments.filter((c) => c.id !== comment.id)
                : p.comments.map((c) => (c.id === comment.id ? { ...c, liked_by_me: true } : c)),
          },
    );
    await writeJsonAtomic(snapshotFile(account.username), { ...snapshot!, posts: updated });
  }
  const done = { reply: "Replied to", like: "Liked", delete: "Deleted" }[args.action];
  return `${done} @${comment.author}'s comment on ${post.url}.`;
}

// Test-only stand-in for Instagram, selected with FEEDPILOT_FAKE_POSTER.
function fakeComments(username: string, posts: Array<{ code: string; kind: PostComments["kind"] }>): PostComments[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const make = (id: string, author: string, text: string, minutesAgo: number, extra: Partial<PostComment> = {}): PostComment => ({
    id,
    author,
    text,
    at: at(minutesAgo),
    likes: 0,
    replies: 0,
    liked_by_me: false,
    mine: author === username,
    pinned: false,
    ...extra,
  });
  return posts.map((post, i) => ({
    code: post.code,
    url: postUrl(post.kind, post.code),
    kind: post.kind,
    comments:
      i === 0
        ? [make(`c${i}1`, "happy_fan", "Where can I buy this?", 30), make(`c${i}2`, "spam_bot", "Get 10k followers now!!", 20), make(`c${i}3`, username, "Thank you!", 10)]
        : [make(`c${i}1`, "regular", "Love it", 300, { likes: 2, replies: 1 })],
  }));
}
