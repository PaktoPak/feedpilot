import { BrowserBusyError, NoBrowserError } from "./browser.js";
import { settings } from "./config.js";
import { findScheduledPost, NoInstagramSchedulerError, PostError, publish, type PublishResult } from "./instagram/post.js";
import { cancelOnInstagram, moveOnInstagram, webChangesReady } from "./instagram/scheduled.js";
import { withLock } from "./lock.js";
import { checkPost } from "./media.js";
import { syncStatsIfDue } from "./stats.js";
import {
  getAccount,
  getJobs,
  logAction,
  patchAccount,
  patchJob,
  peekPreview,
  savePreview,
  takePreview,
  updateJobs,
  type Account,
  type Job,
  type JobStatus,
  type Preview,
  type PreviewItem,
} from "./store.js";
import { errorMessage, log, newId, normalizeUsername, sleep } from "./util.js";

const PREVIEW_TTL_MS = 30 * 60_000;
const RETRY_DELAY_MS = 10 * 60_000;
const BUSY_DELAY_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
// Instagram's scheduler starts 20 minutes out; the margin covers filling in the post.
export const INSTAGRAM_MIN_LEAD_MS = 25 * 60_000;
// After Instagram's scheduled time, look for the post on the profile every 15 minutes for a day.
const CONFIRM_AFTER_MS = 5 * 60_000;
const CONFIRM_EVERY_MS = 15 * 60_000;
const CONFIRM_GIVE_UP_MS = 24 * 3600_000;
const COUNTS_TOWARD_LIMIT: JobStatus[] = ["scheduled", "running", "on_instagram", "posted", "needs_check"];

const NO_SCHEDULER_NOTE =
  "This account has no Schedule content option on instagram.com, so Feedpilot posts it at the time itself. That needs Claude Desktop open then, or the background helper.";
const TOO_SOON_NOTE = "Less than 25 minutes away is too soon for Instagram's scheduler, so Feedpilot posts it at the time itself.";
// Closer than this to its time, a post held by Instagram may already be going out, so it's left alone.
const CHANGE_CUTOFF_MS = 3 * 60_000;

/** Errors whose message is meant for the user as-is. */
export class UserError extends Error {}

export function parsePostAt(postAt?: string | null): string | null {
  if (!postAt) return null;
  const time = Date.parse(postAt);
  if (Number.isNaN(time)) {
    throw new UserError(`"${postAt}" isn't a date and time. Use ISO 8601 with a timezone offset, like 2026-11-06T18:00:00+01:00.`);
  }
  if (time < Date.now() - 60_000) throw new UserError(`${new Date(time).toLocaleString()} is in the past.`);
  return new Date(time).toISOString();
}

/** Scheduled posts go to Instagram's own scheduler when the account has it and there's enough time. */
export function chooseMode(account: Account | undefined, runAt: string): "instagram" | "local" {
  const enoughTime = Date.parse(runAt) - Date.now() >= INSTAGRAM_MIN_LEAD_MS;
  return account && account.can_schedule_on_instagram !== false && enoughTime ? "instagram" : "local";
}

function localReason(account: Account | undefined): string {
  return account?.can_schedule_on_instagram === false ? NO_SCHEDULER_NOTE : TOO_SOON_NOTE;
}

const sameLocalDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

/** extra counts posts on the same day that aren't jobs yet, such as earlier entries in the same preview. */
export function dailyLimitIssue(jobs: Job[], username: string, runAt: string, ignoreJobId?: string, extra = 0): string | null {
  const count =
    extra +
    jobs.filter(
      (j) => j.type === "post" && j.account === username && j.id !== ignoreJobId && COUNTS_TOWARD_LIMIT.includes(j.status) && sameLocalDay(j.run_at, runAt),
    ).length;
  if (count < settings.maxPostsPerDay) return null;
  return `@${username} already has ${count} posts on ${new Date(runAt).toDateString()}, and the daily limit is ${settings.maxPostsPerDay}. Pick another day or raise the limit in the extension's settings.`;
}

export interface PostRequest {
  username: string;
  files: string[];
  caption: string;
  post_at?: string;
}

export interface PreviewOutcome {
  preview?: Preview;
  problems: string[];
  warnings: string[];
}

/** Checks a post for each of one or more accounts and saves them as one preview to approve together. */
export async function createPreview(requests: PostRequest[]): Promise<PreviewOutcome> {
  const jobs = await getJobs();
  const problems: string[] = [];
  const warnings: string[] = [];
  const items: PreviewItem[] = [];

  for (const request of requests) {
    const label = `@${normalizeUsername(request.username)}`;
    const account = await getAccount(request.username);
    if (!account) {
      problems.push(`${label} isn't connected. Check list_accounts, or connect it with connect_account.`);
      continue;
    }
    let postAt: string | null;
    try {
      postAt = parsePostAt(request.post_at);
    } catch (e) {
      problems.push(`${label}: ${errorMessage(e)}`);
      continue;
    }
    const checked = await checkPost(account.username, request.files, request.caption);
    problems.push(...checked.problems.map((p) => `${label}: ${p}`));
    warnings.push(...checked.warnings.map((w) => `${label}: ${w}`));
    if (account.status !== "connected") warnings.push(`${label} has to sign in again before this can go out.`);

    const runAt = postAt ?? new Date().toISOString();
    const earlierInPreview = items.filter((i) => i.account === account.username && sameLocalDay(i.post_at ?? new Date().toISOString(), runAt)).length;
    const limitIssue = dailyLimitIssue(jobs, account.username, runAt, undefined, earlierInPreview);
    if (limitIssue) problems.push(limitIssue);

    // Instagram cuts recommendation reach for accounts that post identical copies of content.
    const reusedOn = jobs
      .filter((j) => j.type === "post" && j.account !== account.username && COUNTS_TOWARD_LIMIT.includes(j.status) && j.hashes.some((h) => checked.hashes.includes(h)))
      .map((j) => `@${j.account}`);
    if (reusedOn.length) {
      warnings.push(
        `${label}: the same file is already posted or scheduled on ${[...new Set(reusedOn)].join(", ")}. Instagram reduces reach for identical reposts, so consider a different edit, cover or caption.`,
      );
    }
    items.push({ account: account.username, files: checked.files, hashes: checked.hashes, kind: checked.kind, caption: request.caption, post_at: postAt });
  }

  const sharing = new Set<string>();
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      if (a.account !== b.account && a.hashes.some((h) => b.hashes.includes(h))) sharing.add(`@${a.account}`).add(`@${b.account}`);
    }
  }
  if (sharing.size) {
    warnings.push(`The same file goes to ${[...sharing].join(", ")} in this preview. Instagram reduces reach for identical reposts, so give each account its own edit or caption.`);
  }
  if (problems.length || !items.length) return { problems: problems.length ? problems : ["Add at least one post."], warnings };

  const now = Date.now();
  const preview: Preview = {
    id: newId("preview"),
    items,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PREVIEW_TTL_MS).toISOString(),
  };
  await savePreview(preview);
  return { preview, problems, warnings };
}

/** Turns a preview into one job per account, all in one batch. An approved post uses the preview up; a test run leaves it for the real post. */
export async function jobsFromPreview(previewId: string, type: Job["type"]): Promise<{ batch_id: string; jobs: Job[] }> {
  const preview = type === "post" ? await takePreview(previewId) : await peekPreview(previewId);
  if (!preview) throw new UserError("That preview expired or was already used. Run preview_post again and show the user the new preview.");
  const batchId = newId("batch");
  const now = new Date().toISOString();
  const created: Job[] = [];
  for (const item of preview.items) {
    const account = await getAccount(item.account);
    if (!account) throw new UserError(`@${item.account} is no longer connected.`);
    const mode = item.post_at ? chooseMode(account, item.post_at) : "local";
    created.push({
      id: newId(type === "post" ? "post" : "test"),
      type,
      batch_id: batchId,
      account: item.account,
      files: item.files,
      hashes: item.hashes,
      kind: item.kind,
      caption: item.caption,
      run_at: type === "post" ? item.post_at ?? now : now,
      mode: type === "post" ? mode : "local",
      // A test run of a scheduled post also fills in Instagram's scheduler, then stops.
      schedule_at: type === "test_post" && item.post_at && mode === "instagram" ? item.post_at : undefined,
      note: item.post_at && mode === "local" ? localReason(account) : undefined,
      created_at: now,
      updated_at: now,
      status: "scheduled",
      attempts: 0,
    });
  }
  await updateJobs((jobs) => {
    // All or nothing: if one account is over its limit, none of the batch is queued.
    for (const job of created) {
      const issue = type === "post" ? dailyLimitIssue(jobs, job.account, job.run_at) : null;
      if (issue) throw new UserError(issue);
      jobs.push(job);
    }
  });
  for (const job of created) {
    const action = type === "test_post" ? "test_post" : job.mode === "instagram" || Date.parse(job.run_at) > Date.now() + 1000 ? "schedule_post" : "post_now";
    await logAction({ action, account: job.account, ok: true, detail: job.id });
  }
  return { batch_id: batchId, jobs: created };
}

export async function rescheduleJob(id: string, postAt: string): Promise<Job> {
  const runAt = parsePostAt(postAt);
  if (!runAt) throw new UserError("Give the new date and time.");
  const existing = (await getJobs()).find((j) => j.id === id && j.type === "post");
  if (!existing) throw new UserError(`There's no post with id ${id}.`);
  const account = await getAccount(existing.account);
  const job = await updateJobs((jobs) => {
    const found = jobs.find((j) => j.id === id)!;
    if (found.status === "on_instagram") {
      // Instagram holds it: the worker moves it on instagram.com's Scheduled content page.
      checkChangeAllowed(found);
      if (Date.parse(runAt) - Date.now() < INSTAGRAM_MIN_LEAD_MS) {
        throw new UserError("Instagram's scheduler needs the new time to be at least 25 minutes away.");
      }
      const issue = dailyLimitIssue(jobs, found.account, runAt, found.id);
      if (issue) throw new UserError(issue);
      Object.assign(found, { pending_change: { action: "move", run_at: runAt }, updated_at: new Date().toISOString() });
      return { ...found };
    }
    if (!["scheduled", "missed", "failed"].includes(found.status)) throw new UserError(`This post is ${found.status}, so it can't be rescheduled.`);
    const issue = dailyLimitIssue(jobs, found.account, runAt, found.id);
    if (issue) throw new UserError(issue);
    const mode = chooseMode(account, runAt);
    Object.assign(found, {
      run_at: runAt,
      mode,
      retry_at: undefined,
      note: mode === "local" ? localReason(account) : undefined,
      status: "scheduled",
      attempts: 0,
      error: undefined,
      updated_at: new Date().toISOString(),
    });
    return { ...found };
  });
  const moveTo = job.pending_change?.action === "move" ? job.pending_change.run_at : job.run_at;
  await logAction({ action: job.pending_change ? "move_requested" : "reschedule_post", account: job.account, ok: true, detail: `${job.id} → ${moveTo}` });
  return job;
}

export async function cancelJob(id: string): Promise<Job> {
  const job = await updateJobs((jobs) => {
    const found = jobs.find((j) => j.id === id);
    if (!found) throw new UserError(`There's no post with id ${id}.`);
    if (found.status === "on_instagram") {
      checkChangeAllowed(found);
      Object.assign(found, { pending_change: { action: "cancel" }, updated_at: new Date().toISOString() });
      return { ...found };
    }
    if (!["scheduled", "missed", "failed"].includes(found.status)) throw new UserError(`This post is ${found.status}, so it can't be cancelled.`);
    Object.assign(found, { status: "cancelled", updated_at: new Date().toISOString() });
    return { ...found };
  });
  await logAction({ action: job.pending_change ? "cancel_requested" : "cancel_post", account: job.account, ok: true, detail: job.id });
  return job;
}

function checkChangeAllowed(job: Job): void {
  if (!webChangesReady && !settings.fakePoster) {
    throw new UserError(
      "Moving or cancelling a post Instagram's scheduler already holds isn't available in Feedpilot yet. Do it at instagram.com/scheduled_content, or in the Instagram app (Profile, menu, Scheduled content). Feedpilot will notice the change after the post's time.",
    );
  }
  if (job.pending_change) throw new UserError("A change to this post is already under way. Check get_post_status.");
  if (Date.parse(job.run_at) - Date.now() < CHANGE_CUTOFF_MS) {
    throw new UserError("It goes out in less than 3 minutes, so Instagram may already be publishing it. It's too late to change it.");
  }
}

let workerBusy = false;
let rerunRequested = false;

/** Runs every due job. The extension and the background helper both call this; the worker lock keeps them from overlapping. */
export async function runDueJobs(source: "extension" | "helper"): Promise<number> {
  if (workerBusy) {
    // A job queued while a run is finishing would otherwise wait for the next timer tick.
    rerunRequested = true;
    return 0;
  }
  workerBusy = true;
  let total = 0;
  try {
    do {
      rerunRequested = false;
      const ran = await withLock(
        "worker",
        async () => {
          const changes = await applyPendingChanges();
          const posts = await runInParallel(source);
          await confirmScheduled();
          // Stats come last so they never hold up a post that's due.
          await syncStatsIfDue();
          return changes + posts;
        },
        0,
      );
      total += ran ?? 0;
    } while (rerunRequested);
    return total;
  } finally {
    workerBusy = false;
  }
}

/**
 * Works on up to settings.maxParallel accounts at once, each in its own browser window.
 * One account's jobs still run one after another, since its browser profile opens only once.
 */
async function runInParallel(source: string): Promise<number> {
  const running = new Map<string, { jobId: string; done: Promise<void> }>();
  let count = 0;
  for (;;) {
    while (running.size < settings.maxParallel) {
      const activeIds = new Set([...running.values()].map((r) => r.jobId));
      const job = await claimNextDue(activeIds, new Set(running.keys()));
      if (!job) break;
      const done = execute(job, source).finally(() => running.delete(job.account));
      running.set(job.account, { jobId: job.id, done });
      count++;
    }
    if (!running.size) return count;
    await Promise.race([...running.values()].map((r) => r.done));
  }
}

async function claimNextDue(activeIds = new Set<string>(), busyAccounts = new Set<string>()): Promise<Job | null> {
  const flagged: Array<{ job: Job; action: string }> = [];
  const claimed = await updateJobs((jobs) => {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    for (const job of jobs) {
      // Only the worker-lock holder runs jobs, so a "running" job this run didn't start was left behind by a crash.
      if (job.status === "running" && !activeIds.has(job.id)) {
        Object.assign(job, { status: job.type === "post" ? "needs_check" : "failed", updated_at: stamp });
        job.error = { message: "Feedpilot stopped while this was running. Check the profile before trying again.", step: "interrupted", stage: "after_share" };
        flagged.push({ job: { ...job }, action: "post_interrupted" });
      }
      // A hand-off that didn't happen in time becomes a post Feedpilot makes itself.
      if (job.status === "scheduled" && job.mode === "instagram" && Date.parse(job.run_at) - now < INSTAGRAM_MIN_LEAD_MS) {
        Object.assign(job, { mode: "local", retry_at: undefined, note: TOO_SOON_NOTE, updated_at: stamp });
      }
    }
    const isDue = (j: Job) =>
      j.status === "scheduled" &&
      !busyAccounts.has(j.account) &&
      (j.mode === "instagram" ? !j.retry_at || Date.parse(j.retry_at) <= now : Date.parse(j.run_at) <= now);
    const due = jobs.filter(isDue).sort((a, b) => a.run_at.localeCompare(b.run_at));
    for (const job of due) {
      if (job.type === "post" && job.mode !== "instagram" && (now - Date.parse(job.run_at)) / 60_000 > settings.maxLateMinutes) {
        Object.assign(job, { status: "missed", updated_at: stamp });
        flagged.push({ job: { ...job }, action: "post_missed" });
        continue;
      }
      Object.assign(job, { status: "running", attempts: job.attempts + 1, updated_at: stamp });
      return { ...job };
    }
    return null;
  });
  for (const { job, action } of flagged) await logAction({ action, account: job.account, ok: false, detail: job.id });
  return claimed;
}

async function execute(job: Job, source: string): Promise<void> {
  const account = await getAccount(job.account);
  if (!account) {
    await patchJob(job.id, { status: "failed", error: { message: `@${job.account} is no longer connected.`, step: "start", stage: "before_share" } });
    return;
  }
  const scheduleAt = job.type === "post" ? (job.mode === "instagram" ? job.run_at : undefined) : job.schedule_at;
  try {
    const result = settings.fakePoster
      ? await fakePublish(job, scheduleAt)
      : await publish(
          { account, files: job.files, caption: job.caption, kind: job.kind },
          { dryRun: job.type === "test_post", scheduleAt: scheduleAt ? new Date(scheduleAt) : undefined },
        );
    const finished = { ...result, finished_at: new Date().toISOString() };
    if (job.type === "post" && result.scheduled) {
      await patchJob(job.id, { status: "on_instagram", retry_at: undefined, profile_before: result.profileBefore ?? [], error: undefined, result: finished });
      if (account.can_schedule_on_instagram !== true) await patchAccount(account.username, { can_schedule_on_instagram: true });
      await logAction({ action: "scheduled_on_instagram", account: job.account, ok: true, detail: `${job.id} for ${job.run_at}` });
      return;
    }
    await patchJob(job.id, { status: job.type === "post" ? "posted" : "tested", error: undefined, result: finished });
    await logAction({ action: job.type === "post" ? "posted" : "test_post_done", account: job.account, ok: true, detail: result.url ?? job.id });
  } catch (e) {
    if (e instanceof NoInstagramSchedulerError) await fallBackToLocal(job, account);
    else await handleFailure(job, e, source);
  }
}

async function fallBackToLocal(job: Job, account: Account): Promise<void> {
  await patchAccount(account.username, { can_schedule_on_instagram: false });
  if (job.type === "post") {
    await patchJob(job.id, { status: "scheduled", mode: "local", retry_at: undefined, attempts: 0, note: NO_SCHEDULER_NOTE });
  } else {
    await patchJob(job.id, { status: "tested", result: { finished_at: new Date().toISOString(), note: `Everything up to scheduling was filled in. ${NO_SCHEDULER_NOTE}` } });
  }
  await logAction({ action: "no_instagram_scheduler", account: account.username, ok: false, detail: job.id });
}

async function handleFailure(job: Job, e: unknown, source: string): Promise<void> {
  if (e instanceof BrowserBusyError) {
    // The account's window was in use; that isn't the post's fault, so it doesn't use up an attempt.
    const later = new Date(Date.now() + BUSY_DELAY_MS).toISOString();
    await patchJob(job.id, { status: "scheduled", attempts: job.attempts - 1, ...(job.mode === "instagram" ? { retry_at: later } : { run_at: later }) });
    return;
  }
  const error: NonNullable<Job["error"]> =
    e instanceof PostError
      ? { message: e.message, step: e.step, stage: e.stage, screenshot: e.screenshot }
      : { message: errorMessage(e), step: "start", stage: "before_share" };
  const signedOut = /signed out|different Instagram account/i.test(error.message);
  if (signedOut) await patchAccount(job.account, { status: "needs_sign_in" });
  const retryable = job.type === "post" && !signedOut && !(e instanceof NoBrowserError);

  const patch: Partial<Job> = { status: "failed", error };
  if (error.stage === "after_share") {
    patch.status = "needs_check";
  } else if (retryable && job.attempts < MAX_ATTEMPTS) {
    patch.status = "scheduled";
    const next = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
    // A hand-off retry keeps the publish time; claimNextDue switches it to local if it gets too close.
    if (job.mode === "instagram") patch.retry_at = next;
    else patch.run_at = next;
  } else if (retryable && job.mode === "instagram") {
    Object.assign(patch, {
      status: "scheduled",
      mode: "local",
      retry_at: undefined,
      attempts: 0,
      note: "Handing this to Instagram's scheduler kept failing, so Feedpilot posts it at the time itself.",
    });
  }
  await patchJob(job.id, patch);
  const retrying = patch.status === "scheduled" ? " (will try again)" : "";
  await logAction({ action: job.type === "post" ? "post_failed" : "test_post_failed", account: job.account, ok: false, detail: `${error.step}: ${error.message}${retrying}` });
  log(`${source}: ${job.id} ${patch.status}: ${error.message}`);
}

/** Carries out approved moves and cancels for posts Instagram's scheduler holds. */
async function applyPendingChanges(): Promise<number> {
  const pending = (await getJobs()).filter((j) => j.status === "on_instagram" && j.pending_change);
  for (const job of pending) {
    const change = job.pending_change!;
    const verb = change.action === "cancel" ? "cancel" : "move";
    const account = await getAccount(job.account);
    if (!account || Date.parse(job.run_at) - Date.now() < CHANGE_CUTOFF_MS) {
      const why = account ? "it was about to go out" : `@${job.account} is no longer connected`;
      await patchJob(job.id, { pending_change: undefined, note: `Didn't ${verb} it: ${why}. It is still scheduled for its original time.` });
      await logAction({ action: `${verb}_skipped`, account: job.account, ok: false, detail: job.id });
      continue;
    }
    try {
      if (settings.fakePoster === "fail_change") throw new Error("Fake failure while changing.");
      if (!settings.fakePoster) {
        if (change.action === "cancel") await cancelOnInstagram(account, job);
        else await moveOnInstagram(account, job, new Date(change.run_at));
      }
      if (change.action === "cancel") {
        await patchJob(job.id, { status: "cancelled", pending_change: undefined, note: "Cancelled on Instagram's scheduler." });
      } else {
        await patchJob(job.id, { run_at: change.run_at, pending_change: undefined, checked_at: undefined, note: "Moved on Instagram's scheduler." });
      }
      await logAction({ action: change.action === "cancel" ? "cancelled_on_instagram" : "moved_on_instagram", account: job.account, ok: true, detail: job.id });
    } catch (e) {
      await patchJob(job.id, {
        pending_change: undefined,
        note: `Couldn't ${verb} it on instagram.com: ${errorMessage(e)} It should still be scheduled for its original time; instagram.com/scheduled_content shows what Instagram holds.`,
      });
      await logAction({ action: `${verb}_failed`, account: job.account, ok: false, detail: `${job.id}: ${errorMessage(e)}` });
    }
  }
  return pending.length;
}

/** Looks on the profile for posts Instagram's scheduler should have published, and records their links. */
async function confirmScheduled(): Promise<void> {
  const now = Date.now();
  const stamp = () => new Date().toISOString();
  const waiting = (await getJobs()).filter(
    (j) =>
      j.status === "on_instagram" &&
      Date.parse(j.run_at) + CONFIRM_AFTER_MS <= now &&
      (!j.checked_at || now - Date.parse(j.checked_at) >= CONFIRM_EVERY_MS),
  );
  for (const job of waiting) {
    if (now - Date.parse(job.run_at) > CONFIRM_GIVE_UP_MS) {
      await patchJob(job.id, {
        status: "unconfirmed",
        note: "Its time passed a day ago and Feedpilot never found it on the profile. It may have been changed or cancelled in the Instagram app.",
      });
      await logAction({ action: "scheduled_post_not_found", account: job.account, ok: false, detail: job.id });
      continue;
    }
    const account = await getAccount(job.account);
    if (!account) continue;
    try {
      const found = settings.fakePoster
        ? { url: `https://www.instagram.com/p/FAKE${job.id.slice(-4)}/`, code: "FAKE" }
        : await findScheduledPost(account, job.profile_before ?? [], job.caption);
      if (found) {
        await patchJob(job.id, { status: "posted", checked_at: stamp(), result: { ...job.result, ...found, finished_at: stamp() } });
        await logAction({ action: "posted", account: job.account, ok: true, detail: found.url });
      } else {
        await patchJob(job.id, { checked_at: stamp() });
      }
    } catch (e) {
      await patchJob(job.id, { checked_at: stamp() });
      log(`couldn't check ${job.id}: ${errorMessage(e)}`);
    }
  }
}

// Test-only stand-in for Instagram, selected with FEEDPILOT_FAKE_POSTER.
async function fakePublish(job: Job, scheduleAt?: string): Promise<PublishResult> {
  if (settings.fakeDelayMs) await sleep(settings.fakeDelayMs);
  if (settings.fakePoster === "fail_before") throw new PostError("Fake failure before Share.", "fake", "before_share");
  if (settings.fakePoster === "fail_after") throw new PostError("Fake failure after Share.", "fake", "after_share");
  if (scheduleAt && settings.fakePoster === "no_scheduler") throw new NoInstagramSchedulerError("Fake: no Schedule content option.");
  if (job.type === "test_post") return { note: "Fake test run." };
  if (scheduleAt) return { scheduled: true, profileBefore: ["p/OLD"] };
  return { url: `https://www.instagram.com/p/FAKE${job.id.slice(-4)}/`, code: "FAKE" };
}
