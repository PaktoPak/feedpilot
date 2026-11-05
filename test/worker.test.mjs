import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeDataDir, readState, seedAccounts, workerPath } from "./helpers.mjs";

const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

function job(id, patch = {}) {
  const now = new Date().toISOString();
  return {
    id,
    type: "post",
    account: "testshop",
    files: ["/tmp/none.png"],
    hashes: [id],
    kind: "photo",
    caption: "",
    run_at: minutes(-1),
    created_at: now,
    updated_at: now,
    status: "scheduled",
    attempts: 0,
    ...patch,
  };
}

async function setup(jobs) {
  const dataDir = await makeDataDir();
  await seedAccounts(dataDir, ["testshop"]);
  await fs.writeFile(path.join(dataDir, "state", "jobs.json"), JSON.stringify(jobs));
  return dataDir;
}

function runWorker(dataDir, fake) {
  execFileSync(process.execPath, [workerPath, "--once"], {
    env: { ...process.env, FEEDPILOT_DATA_DIR: dataDir, FEEDPILOT_FAKE_POSTER: fake },
    stdio: "pipe",
  });
}

const byId = async (dataDir) => Object.fromEntries((await readState(dataDir, "jobs.json", [])).map((j) => [j.id, j]));

test("posts what is due and records the link", async () => {
  const dataDir = await setup([job("post_due"), job("post_later", { run_at: minutes(60) })]);
  runWorker(dataDir, "ok");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_due.status, "posted");
  assert.match(jobs.post_due.result.url, /instagram\.com\/p\/FAKE/);
  assert.equal(jobs.post_later.status, "scheduled", "not due yet");
  assert.ok((await readState(dataDir, "helper.json", {})).last_run_at, "helper run recorded");
});

test("retries a failure before Share, then gives up after three attempts", async () => {
  const dataDir = await setup([job("post_retry"), job("post_last_try", { attempts: 2 })]);
  runWorker(dataDir, "fail_before");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_retry.status, "scheduled");
  assert.equal(jobs.post_retry.attempts, 1);
  assert.ok(Date.parse(jobs.post_retry.run_at) > Date.now() + 9 * 60_000, "retry about 10 minutes later");
  assert.equal(jobs.post_retry.error.stage, "before_share");
  assert.equal(jobs.post_last_try.status, "failed");
});

test("never retries after Share was clicked", async () => {
  const dataDir = await setup([job("post_shared")]);
  runWorker(dataDir, "fail_after");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_shared.status, "needs_check");
  assert.equal(jobs.post_shared.attempts, 1);
});

test("holds very late posts and flags interrupted ones", async () => {
  const dataDir = await setup([job("post_late", { run_at: minutes(-180) }), job("post_orphan", { status: "running", attempts: 1 })]);
  runWorker(dataDir, "ok");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_late.status, "missed");
  assert.equal(jobs.post_orphan.status, "needs_check");
  const actions = (await fs.readFile(path.join(dataDir, "state", "actions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).action);
  assert.ok(actions.includes("post_missed") && actions.includes("post_interrupted"), actions.join(","));
});

test("waits while another worker holds the lock, and takes over a dead one's lock", async () => {
  const dataDir = await setup([job("post_locked")]);
  const lock = path.join(dataDir, "state", "locks", "worker.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, "{}");
  runWorker(dataDir, "ok");
  assert.equal((await byId(dataDir)).post_locked.status, "scheduled", "a live lock blocks the run");

  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(lock, old, old);
  runWorker(dataDir, "ok");
  assert.equal((await byId(dataDir)).post_locked.status, "posted", "a stale lock is taken over");
});

test("hands a scheduled post to Instagram's scheduler right away", async () => {
  const dataDir = await setup([job("post_native", { mode: "instagram", run_at: minutes(120) })]);
  runWorker(dataDir, "ok");
  const { post_native } = await byId(dataDir);
  assert.equal(post_native.status, "on_instagram");
  assert.deepEqual(post_native.profile_before, ["p/OLD"]);
  const [account] = await readState(dataDir, "accounts.json", []);
  assert.equal(account.can_schedule_on_instagram, true);
});

test("posts it itself when the account has no Instagram scheduler", async () => {
  const dataDir = await setup([job("post_fallback", { mode: "instagram", run_at: minutes(120) })]);
  runWorker(dataDir, "no_scheduler");
  const { post_fallback } = await byId(dataDir);
  assert.equal(post_fallback.status, "scheduled");
  assert.equal(post_fallback.mode, "local");
  assert.match(post_fallback.note, /no Schedule content option/);
  const [account] = await readState(dataDir, "accounts.json", []);
  assert.equal(account.can_schedule_on_instagram, false);
});

test("a hand-off that got too close to its time becomes a post Feedpilot makes", async () => {
  const dataDir = await setup([job("post_close", { mode: "instagram", run_at: minutes(10) })]);
  runWorker(dataDir, "ok");
  const { post_close } = await byId(dataDir);
  assert.equal(post_close.mode, "local");
  assert.equal(post_close.status, "scheduled", "not due for another 10 minutes");
});

test("finds posts Instagram published, and gives up on ones it never finds", async () => {
  const dataDir = await setup([
    job("post_went_live", { mode: "instagram", status: "on_instagram", run_at: minutes(-10), profile_before: [] }),
    job("post_vanished", { mode: "instagram", status: "on_instagram", run_at: minutes(-25 * 60), profile_before: [] }),
    job("post_not_yet", { mode: "instagram", status: "on_instagram", run_at: minutes(30), profile_before: [] }),
  ]);
  runWorker(dataDir, "ok");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_went_live.status, "posted");
  assert.match(jobs.post_went_live.result.url, /FAKE/);
  assert.equal(jobs.post_vanished.status, "unconfirmed");
  assert.equal(jobs.post_not_yet.status, "on_instagram");
});

test("carries out approved moves and cancels for posts Instagram holds", async () => {
  const dataDir = await setup([
    job("post_move", { mode: "instagram", status: "on_instagram", run_at: minutes(120), pending_change: { action: "move", run_at: minutes(300) } }),
    job("post_cancel", { mode: "instagram", status: "on_instagram", run_at: minutes(120), pending_change: { action: "cancel" } }),
    job("post_too_late", { mode: "instagram", status: "on_instagram", run_at: minutes(1), pending_change: { action: "cancel" } }),
  ]);
  runWorker(dataDir, "ok");
  const jobs = await byId(dataDir);
  assert.equal(jobs.post_move.status, "on_instagram");
  assert.ok(Date.parse(jobs.post_move.run_at) > Date.now() + 280 * 60_000, "moved to the new time");
  assert.equal(jobs.post_move.pending_change, undefined);
  assert.equal(jobs.post_cancel.status, "cancelled");
  assert.equal(jobs.post_too_late.status, "on_instagram", "left alone that close to its time");
  assert.match(jobs.post_too_late.note, /about to go out/);
});

test("a failed move leaves the post at its original time and says so", async () => {
  const original = minutes(120);
  const dataDir = await setup([job("post_move_fail", { mode: "instagram", status: "on_instagram", run_at: original, pending_change: { action: "move", run_at: minutes(300) } })]);
  runWorker(dataDir, "fail_change");
  const { post_move_fail } = await byId(dataDir);
  assert.equal(post_move_fail.run_at, original);
  assert.equal(post_move_fail.pending_change, undefined);
  assert.match(post_move_fail.note, /Couldn't move it on instagram\.com/);
});

test("works on different accounts at the same time, one job per account at a time", async () => {
  const dataDir = await makeDataDir();
  await seedAccounts(dataDir, ["shop_a", "shop_b"]);
  await fs.writeFile(
    path.join(dataDir, "state", "jobs.json"),
    JSON.stringify([job("post_a1", { account: "shop_a" }), job("post_b1", { account: "shop_b" }), job("post_a2", { account: "shop_a", run_at: minutes(-0.5) })]),
  );
  const started = Date.now();
  execFileSync(process.execPath, [workerPath, "--once"], {
    env: { ...process.env, FEEDPILOT_DATA_DIR: dataDir, FEEDPILOT_FAKE_POSTER: "ok", FEEDPILOT_FAKE_DELAY_MS: "2000" },
    stdio: "pipe",
  });
  const elapsed = Date.now() - started;
  const jobs = await byId(dataDir);
  for (const id of ["post_a1", "post_b1", "post_a2"]) assert.equal(jobs[id].status, "posted", id);
  // a1 and b1 run together, then a2 after a1: about 4 s rather than 6 s one after another.
  assert.ok(elapsed < 5600, `took ${elapsed} ms`);
  const gap = Date.parse(jobs.post_a2.result.finished_at) - Date.parse(jobs.post_a1.result.finished_at);
  assert.ok(gap >= 1800, `shop_a's second job waited for its first (gap ${gap} ms)`);
  const together = Math.abs(Date.parse(jobs.post_b1.result.finished_at) - Date.parse(jobs.post_a1.result.finished_at));
  assert.ok(together < 1000, `shop_a and shop_b ran side by side (${together} ms apart)`);
});
