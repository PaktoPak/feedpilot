import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { paths } from "./config.js";
import { withLockOrThrow } from "./lock.js";
import { logAction } from "./store.js";
import { ensureDir, localTime, readJson, writeJsonAtomic } from "./util.js";

// The background helper is a macOS launch agent that runs the queue once a minute.
// It is never installed without the user's explicit yes: install needs a one-time
// code that only the explain step hands out, and the explain text must be shown first.

const execFileAsync = promisify(execFile);
const LABEL = "com.feedpilot.worker";
const CODE_TTL_MS = 15 * 60_000;
const INTERVAL_SECONDS = 60;
const MAC_ONLY = "The background helper is Mac-only for now. Scheduled posts still go out while Claude Desktop is open.";

interface HelperState {
  installed: boolean;
  installed_at?: string;
  node_path?: string;
  worker_path?: string;
  env?: Record<string, string>;
  pending_code?: string;
  pending_expires_at?: string;
  last_run_at?: string;
}

const stateFile = () => path.join(paths.state, "helper.json");
const agentsDir = () => process.env.FEEDPILOT_LAUNCHAGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
const logFile = () => path.join(paths.logs, "helper.log");
const useLaunchctl = () => process.env.FEEDPILOT_SKIP_LAUNCHCTL !== "1";
const supported = () => process.platform === "darwin";
const launchDomain = () => `gui/${process.getuid?.() ?? 0}`;

async function readState(): Promise<HelperState> {
  return readJson<HelperState>(stateFile(), { installed: false });
}

async function writeState(patch: Partial<HelperState>): Promise<void> {
  await withLockOrThrow("helper", async () => writeJsonAtomic(stateFile(), { ...(await readState()), ...patch }));
}

function runtime() {
  const env: Record<string, string> = { FEEDPILOT_DATA_DIR: paths.data };
  for (const key of ["FEEDPILOT_MAX_POSTS_PER_DAY", "FEEDPILOT_MAX_PARALLEL", "FEEDPILOT_MAX_LATE_MINUTES", "FEEDPILOT_BROWSER_PATH"]) {
    const value = process.env[key];
    if (value && !value.includes("${")) env[key] = value;
  }
  // Claude Desktop can run extensions on its own app binary in Node mode; the helper must start it the same way.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return { node: process.execPath, worker: fileURLToPath(new URL("./worker.js", import.meta.url)), env };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildPlist(node: string, worker: string, env: Record<string, string>): string {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(node)}</string>
\t\t<string>${xml(worker)}</string>
\t\t<string>--once</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>StartInterval</key>
\t<integer>${INTERVAL_SECONDS}</integer>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xml(logFile())}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logFile())}</string>
</dict>
</plist>
`;
}

async function writeAndLoad(node: string, worker: string, env: Record<string, string>): Promise<void> {
  await ensureDir(agentsDir());
  await ensureDir(paths.logs);
  await fs.writeFile(plistPath(), buildPlist(node, worker, env));
  if (!useLaunchctl()) return;
  await execFileAsync("launchctl", ["bootout", `${launchDomain()}/${LABEL}`]).catch(() => {});
  await execFileAsync("launchctl", ["bootstrap", launchDomain(), plistPath()]);
}

async function isLoaded(): Promise<boolean> {
  if (!useLaunchctl()) return false;
  return execFileAsync("launchctl", ["print", `${launchDomain()}/${LABEL}`]).then(() => true, () => false);
}

export async function isHelperInstalled(): Promise<boolean> {
  return supported() && (await readState()).installed;
}

export async function explainHelper(): Promise<string> {
  if (!supported()) return MAC_ONLY;
  const { node, worker } = runtime();
  const code = randomBytes(3).toString("hex").toUpperCase();
  await writeState({ pending_code: code, pending_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  return [
    "What installing the background helper would do:",
    "",
    "- Why: most scheduled posts are handed to Instagram's own scheduler and need nothing from this computer. The helper covers the rest (accounts without Instagram's scheduler, and posts less than 25 minutes away) so they go out on time even when Claude Desktop is closed. Without it, those only go out while Claude Desktop is open.",
    `- What gets added: one file, ${plistPath()}. It's a standard macOS launch agent for this user only and needs no admin password.`,
    `- What it runs: ${node} ${worker} --once`,
    `- How often: every ${INTERVAL_SECONDS} seconds while this user is logged in to the Mac. Each run checks the queue and exits unless a post is due.`,
    "- What it can do: publish only posts the user already approved and scheduled, on accounts already connected. It cannot write, approve or schedule anything itself.",
    `- Log: ${logFile()}`,
    "- How to remove it: ask Claude to remove the background helper, or delete the file above.",
    "",
    `Confirmation code: ${code} (valid for 15 minutes)`,
    "Show the user everything above. Install only if they explicitly say yes, by calling background_helper with action install and this code.",
  ].join("\n");
}

export async function installHelper(code: string | undefined): Promise<string> {
  if (!supported()) return MAC_ONLY;
  const state = await readState();
  const valid =
    !!code && !!state.pending_code && code.trim().toUpperCase() === state.pending_code && Date.parse(state.pending_expires_at ?? "") > Date.now();
  if (!valid) {
    throw new Error(
      "Not installed. This needs the confirmation code from background_helper action explain, after the user has read that explanation and said yes. Codes expire after 15 minutes.",
    );
  }
  const { node, worker, env } = runtime();
  await writeAndLoad(node, worker, env);
  await writeState({
    installed: true,
    installed_at: new Date().toISOString(),
    node_path: node,
    worker_path: worker,
    env,
    pending_code: undefined,
    pending_expires_at: undefined,
  });
  await logAction({ action: "helper_install", ok: true, detail: plistPath() });
  return `Background helper installed (${plistPath()}). Scheduled posts now go out even when Claude Desktop is closed, as long as the Mac is on and this user is logged in.`;
}

export async function removeHelper(): Promise<string> {
  if (!supported()) return MAC_ONLY;
  if (useLaunchctl()) await execFileAsync("launchctl", ["bootout", `${launchDomain()}/${LABEL}`]).catch(() => {});
  await fs.rm(plistPath(), { force: true });
  await writeState({ installed: false, installed_at: undefined, pending_code: undefined, pending_expires_at: undefined });
  await logAction({ action: "helper_remove", ok: true });
  return "Background helper removed. Scheduled posts now go out only while Claude Desktop is open.";
}

export async function helperStatus(): Promise<string> {
  if (!supported()) return MAC_ONLY;
  const state = await readState();
  const fileExists = await fs.stat(plistPath()).then(() => true, () => false);
  if (!state.installed && !fileExists) {
    return "The background helper is not installed, so scheduled posts go out only while Claude Desktop is open. To offer it, call background_helper with action explain and show the user the result.";
  }
  return [
    `Installed: ${state.installed && fileExists ? "yes" : "partly (the file and Feedpilot's records disagree; remove and reinstall it)"}`,
    `Loaded in macOS: ${(await isLoaded()) ? "yes" : "no"}`,
    `Last run: ${state.last_run_at ? localTime(state.last_run_at) : "not yet"}`,
    `File: ${plistPath()}`,
  ].join("\n");
}

/** Keeps an already-approved helper pointed at the current files after Claude Desktop or the extension updates. */
export async function refreshHelper(): Promise<void> {
  if (!supported()) return;
  const state = await readState();
  if (!state.installed) return;
  const { node, worker, env } = runtime();
  if (state.node_path === node && state.worker_path === worker && JSON.stringify(state.env ?? {}) === JSON.stringify(env)) return;
  await writeAndLoad(node, worker, env);
  await writeState({ node_path: node, worker_path: worker, env });
  await logAction({ action: "helper_refresh", ok: true, detail: "Pointed the helper at the updated extension files." });
}

export async function markHelperRun(): Promise<void> {
  await writeState({ last_run_at: new Date().toISOString() });
}
