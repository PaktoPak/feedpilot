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

// The background helper runs the queue once a minute: a launch agent on macOS, a scheduled task
// on Windows. It is never installed without the user's explicit yes: install needs a one-time
// code that only the explain step hands out, and the explain text must be shown first.

const execFileAsync = promisify(execFile);
const CODE_TTL_MS = 15 * 60_000;
const INTERVAL_SECONDS = 60;
const UNSUPPORTED = "The background helper works on Mac and Windows. On this computer, scheduled posts go out while Claude Desktop is open.";

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
const logFile = () => path.join(paths.logs, "helper.log");
// Tests generate the helper's files without registering anything with the system.
const useSystemScheduler = () => process.env.FEEDPILOT_SKIP_SYSTEM_SCHEDULER !== "1" && process.env.FEEDPILOT_SKIP_LAUNCHCTL !== "1";
const platform = () => process.env.FEEDPILOT_HELPER_PLATFORM || process.platform;

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

interface Scheduler {
  /** "What gets added" line for the explanation. */
  added: () => string;
  signedIn: string;
  removal: string;
  location: () => string;
  write: (node: string, worker: string, env: Record<string, string>) => Promise<void>;
  remove: () => Promise<void>;
  present: () => Promise<boolean>;
  registered: () => Promise<boolean>;
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

// macOS: a launch agent in ~/Library/LaunchAgents.

const LABEL = "com.feedpilot.worker";
const agentsDir = () => process.env.FEEDPILOT_LAUNCHAGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
const launchDomain = () => `gui/${process.getuid?.() ?? 0}`;

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

const macScheduler: Scheduler = {
  added: () => `one file, ${plistPath()}. It's a standard macOS launch agent for this user only and needs no admin password.`,
  signedIn: "logged in to the Mac",
  removal: "or delete the file above",
  location: plistPath,
  async write(node, worker, env) {
    await ensureDir(agentsDir());
    await ensureDir(paths.logs);
    await fs.writeFile(plistPath(), buildPlist(node, worker, env));
    if (!useSystemScheduler()) return;
    await execFileAsync("launchctl", ["bootout", `${launchDomain()}/${LABEL}`]).catch(() => {});
    await execFileAsync("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  },
  async remove() {
    if (useSystemScheduler()) await execFileAsync("launchctl", ["bootout", `${launchDomain()}/${LABEL}`]).catch(() => {});
    await fs.rm(plistPath(), { force: true });
  },
  present: () => exists(plistPath()),
  registered: async () =>
    useSystemScheduler() && execFileAsync("launchctl", ["print", `${launchDomain()}/${LABEL}`]).then(() => true, () => false),
};

// Windows: a scheduled task for this user that starts the worker through a hidden launcher.

const TASK_NAME = "Feedpilot worker";
const winDir = () => path.join(paths.data, "helper");
const winFiles = () => ({
  cmd: path.join(winDir(), "run-worker.cmd"),
  vbs: path.join(winDir(), "run-worker.vbs"),
  task: path.join(winDir(), "task.xml"),
});

function buildCmd(node: string, worker: string, env: Record<string, string>): string {
  // In a batch file a literal % has to be doubled.
  const quote = (s: string) => s.replace(/%/g, "%%");
  const sets = Object.entries(env).map(([key, value]) => `set "${key}=${quote(value)}"`);
  return ["@echo off", ...sets, `"${quote(node)}" "${quote(worker)}" --once >> "${quote(logFile())}" 2>&1`, ""].join("\r\n");
}

// wscript runs the batch file with its window hidden, so nothing flashes on screen every minute.
const buildVbs = (cmdPath: string) =>
  `' Starts Feedpilot's worker without showing a console window.\r\nCreateObject("WScript.Shell").Run Chr(34) & "${cmdPath}" & Chr(34), 0, True\r\n`;

function buildTaskXml(vbsPath: string): Buffer {
  const body = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Feedpilot: sends Instagram posts you already approved and scheduled. Remove it by asking Claude to remove the background helper, or by deleting this task.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  // Task Scheduler reads task definitions as UTF-16 with a byte order mark.
  return Buffer.from("﻿" + body.replace(/\n/g, "\r\n"), "utf16le");
}

const windowsScheduler: Scheduler = {
  added: () =>
    `a Windows scheduled task named "${TASK_NAME}", for this user only and with no admin rights, plus three small files in ${winDir()} that it runs with its window hidden.`,
  signedIn: "signed in to Windows",
  removal: `or delete the "${TASK_NAME}" task in Task Scheduler`,
  location: () => `Task Scheduler: ${TASK_NAME} (files in ${winDir()})`,
  async write(node, worker, env) {
    const files = winFiles();
    await ensureDir(winDir());
    await ensureDir(paths.logs);
    await fs.writeFile(files.cmd, buildCmd(node, worker, env));
    await fs.writeFile(files.vbs, buildVbs(files.cmd));
    await fs.writeFile(files.task, buildTaskXml(files.vbs));
    if (!useSystemScheduler()) return;
    await execFileAsync("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", files.task, "/F"], { windowsHide: true });
  },
  async remove() {
    if (useSystemScheduler()) await execFileAsync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { windowsHide: true }).catch(() => {});
    await fs.rm(winDir(), { recursive: true, force: true });
  },
  present: () => exists(winFiles().cmd),
  registered: async () =>
    useSystemScheduler() && execFileAsync("schtasks", ["/Query", "/TN", TASK_NAME], { windowsHide: true }).then(() => true, () => false),
};

function scheduler(): Scheduler | null {
  if (platform() === "darwin") return macScheduler;
  if (platform() === "win32") return windowsScheduler;
  return null;
}

export async function isHelperInstalled(): Promise<boolean> {
  return !!scheduler() && (await readState()).installed;
}

export async function explainHelper(): Promise<string> {
  const system = scheduler();
  if (!system) return UNSUPPORTED;
  const { node, worker } = runtime();
  const code = randomBytes(3).toString("hex").toUpperCase();
  await writeState({ pending_code: code, pending_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  return [
    "What installing the background helper would do:",
    "",
    "- Why: most scheduled posts are handed to Instagram's own scheduler and need nothing from this computer. The helper covers the rest (accounts without Instagram's scheduler, and posts less than 25 minutes away) so they go out on time even when Claude Desktop is closed. Without it, those only go out while Claude Desktop is open.",
    `- What gets added: ${system.added()}`,
    `- What it runs: ${node} ${worker} --once`,
    `- How often: every ${INTERVAL_SECONDS} seconds while this user is ${system.signedIn}. Each run checks the queue and exits unless a post is due.`,
    "- What it can do: publish only posts the user already approved and scheduled, on accounts already connected. It cannot write, approve or schedule anything itself.",
    `- Log: ${logFile()}`,
    `- How to remove it: ask Claude to remove the background helper, ${system.removal}.`,
    "",
    `Confirmation code: ${code} (valid for 15 minutes)`,
    "Show the user everything above. Install only if they explicitly say yes, by calling background_helper with action install and this code.",
  ].join("\n");
}

export async function installHelper(code: string | undefined): Promise<string> {
  const system = scheduler();
  if (!system) return UNSUPPORTED;
  const state = await readState();
  const valid =
    !!code && !!state.pending_code && code.trim().toUpperCase() === state.pending_code && Date.parse(state.pending_expires_at ?? "") > Date.now();
  if (!valid) {
    throw new Error(
      "Not installed. This needs the confirmation code from background_helper action explain, after the user has read that explanation and said yes. Codes expire after 15 minutes.",
    );
  }
  const { node, worker, env } = runtime();
  await system.write(node, worker, env);
  await writeState({
    installed: true,
    installed_at: new Date().toISOString(),
    node_path: node,
    worker_path: worker,
    env,
    pending_code: undefined,
    pending_expires_at: undefined,
  });
  await logAction({ action: "helper_install", ok: true, detail: system.location() });
  return `Background helper installed (${system.location()}). Scheduled posts now go out even when Claude Desktop is closed, as long as the computer is on and this user is ${system.signedIn}.`;
}

export async function removeHelper(): Promise<string> {
  const system = scheduler();
  if (!system) return UNSUPPORTED;
  await system.remove();
  await writeState({ installed: false, installed_at: undefined, pending_code: undefined, pending_expires_at: undefined });
  await logAction({ action: "helper_remove", ok: true });
  return "Background helper removed. Scheduled posts that Feedpilot sends itself now go out only while Claude Desktop is open.";
}

export async function helperStatus(): Promise<string> {
  const system = scheduler();
  if (!system) return UNSUPPORTED;
  const state = await readState();
  const present = await system.present();
  if (!state.installed && !present) {
    return "The background helper is not installed, so scheduled posts that Feedpilot sends itself go out only while Claude Desktop is open. To offer it, call background_helper with action explain and show the user the result.";
  }
  return [
    `Installed: ${state.installed && present ? "yes" : "partly (the files and Feedpilot's records disagree; remove and reinstall it)"}`,
    `Registered with the system: ${(await system.registered()) ? "yes" : "no"}`,
    `Last run: ${state.last_run_at ? localTime(state.last_run_at) : "not yet"}`,
    `Where: ${system.location()}`,
  ].join("\n");
}

/** Keeps an already-approved helper pointed at the current files after Claude Desktop or the extension updates. */
export async function refreshHelper(): Promise<void> {
  const system = scheduler();
  if (!system) return;
  const state = await readState();
  if (!state.installed) return;
  const { node, worker, env } = runtime();
  if (state.node_path === node && state.worker_path === worker && JSON.stringify(state.env ?? {}) === JSON.stringify(env)) return;
  await system.write(node, worker, env);
  await writeState({ node_path: node, worker_path: worker, env });
  await logAction({ action: "helper_refresh", ok: true, detail: "Pointed the helper at the updated extension files." });
}

export async function markHelperRun(): Promise<void> {
  await writeState({ last_run_at: new Date().toISOString() });
}
