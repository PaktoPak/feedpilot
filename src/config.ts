import os from "node:os";
import path from "node:path";

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  // An empty MCPB user_config field can arrive as "" or as an unexpanded placeholder.
  if (!value || value.includes("${")) return undefined;
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DATA_DIR = envPath("FEEDPILOT_DATA_DIR") ?? path.join(os.homedir(), "Feedpilot");

export const paths = {
  data: DATA_DIR,
  profiles: path.join(DATA_DIR, "profiles"),
  media: path.join(DATA_DIR, "media"),
  state: path.join(DATA_DIR, "state"),
  locks: path.join(DATA_DIR, "state", "locks"),
  screenshots: path.join(DATA_DIR, "screenshots"),
  logs: path.join(DATA_DIR, "logs"),
};

export const settings = {
  maxPostsPerDay: envInt("FEEDPILOT_MAX_POSTS_PER_DAY", 5),
  // A post this late is held for the user instead of going out at an unexpected time.
  maxLateMinutes: envInt("FEEDPILOT_MAX_LATE_MINUTES", 120),
  // How many accounts Feedpilot works on at the same time, each in its own browser window.
  maxParallel: Math.min(envInt("FEEDPILOT_MAX_PARALLEL", 3), 5),
  maxRepliesPerHour: envInt("FEEDPILOT_MAX_REPLIES_PER_HOUR", 20),
  // Messages are kept on this computer for later analysis unless this is turned off.
  storeMessages: process.env.FEEDPILOT_STORE_MESSAGES !== "0" && process.env.FEEDPILOT_STORE_MESSAGES !== "false",
  statsEveryHours: envInt("FEEDPILOT_STATS_EVERY_HOURS", 6),
  statsPostsPerSync: envInt("FEEDPILOT_STATS_POSTS", 24),
  browserPath: envPath("FEEDPILOT_BROWSER_PATH"),
  headless: process.env.FEEDPILOT_HEADLESS === "1",
  // Test-only: "ok", "fail_before", "fail_after", "no_scheduler" or "fail_change" replaces the real Instagram poster.
  fakePoster: process.env.FEEDPILOT_FAKE_POSTER,
  fakeDelayMs: envInt("FEEDPILOT_FAKE_DELAY_MS", 0),
};
