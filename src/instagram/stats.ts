import { dismissPopups, openProfile } from "../browser.js";
import type { Account, PostKind } from "../store.js";
import { gotoHome, IG, sessionUserId } from "./session.js";

export interface MediaStats {
  code: string;
  pk?: string;
  kind: PostKind;
  posted_at: string;
  caption: string;
  likes?: number;
  comments?: number;
  views?: number;
}

export interface ProfileStats {
  followers?: number;
  following?: number;
  posts?: number;
  media: MediaStats[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function kindOf(node: any): PostKind {
  if (node.media_type === 8 || node.product_type === "carousel_container") return "carousel";
  if (node.media_type === 2 || node.product_type === "clips") return "reel";
  return "photo";
}

/**
 * Opens the account's own profile and reels tab and reads the numbers instagram.com loads for them:
 * followers, following, post count, and each recent post's likes, comments and (for reels) views.
 * It only listens to what the pages fetch for themselves; it sends no requests of its own.
 */
export async function readProfileStats(account: Account, maxPosts: number): Promise<ProfileStats> {
  const { context, page } = await openProfile(account.profile_dir);
  const media = new Map<string, MediaStats>();
  const stats: ProfileStats = { media: [] };
  let listening = false;

  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const owner = node.user?.username ?? node.owner?.username;
    if (typeof node.code === "string" && "like_count" in node && owner === account.username) {
      const previous = media.get(node.code);
      media.set(node.code, {
        code: node.code,
        pk: node.pk ? String(node.pk) : previous?.pk,
        kind: kindOf(node),
        posted_at: num(node.taken_at) ? new Date(node.taken_at * 1000).toISOString() : previous?.posted_at ?? new Date().toISOString(),
        caption: String(node.caption?.text ?? previous?.caption ?? "").slice(0, 200),
        likes: num(node.like_count) ?? previous?.likes,
        comments: num(node.comment_count) ?? previous?.comments,
        views: num(node.play_count) ?? num(node.ig_play_count) ?? num(node.view_count) ?? num(node.video_view_count) ?? previous?.views,
      });
    }
    if (node.username === account.username && ("follower_count" in node || "edge_followed_by" in node)) {
      stats.followers = num(node.follower_count) ?? num(node.edge_followed_by?.count) ?? stats.followers;
      stats.following = num(node.following_count) ?? num(node.edge_follow?.count) ?? stats.following;
      stats.posts = num(node.media_count) ?? num(node.edge_owner_to_timeline_media?.count) ?? stats.posts;
    }
    for (const value of Object.values(node)) walk(value);
  };

  page.on("response", async (response) => {
    if (!listening || !/\/graphql|\/api\/v1\//.test(response.url())) return;
    try {
      const body = await response.text();
      if (body.startsWith("{") || body.startsWith("[")) walk(JSON.parse(body));
    } catch {
      // responses that aren't JSON, or that finish after the window closes
    }
  });

  try {
    await gotoHome(page);
    await dismissPopups(page);
    const userId = await sessionUserId(context);
    if (!userId) throw new Error(`@${account.username} is signed out. Connect it again with connect_account.`);
    if (userId !== account.user_id) throw new Error(`A different Instagram account is signed in to @${account.username}'s window.`);

    listening = true;
    await page.goto(`${IG}/${account.username}/?hl=en`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    // Scrolling loads older posts the way a person would, a page at a time.
    for (let i = 0; i < 3 && media.size < maxPosts; i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(2500);
    }
    // The reels tab carries reel view counts.
    if ([...media.values()].some((m) => m.kind === "reel" && m.views === undefined) || media.size === 0) {
      await page.goto(`${IG}/${account.username}/reels/?hl=en`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
    }
  } finally {
    listening = false;
    await context.close().catch(() => {});
  }
  stats.media = [...media.values()].sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, maxPosts);
  return stats;
}
