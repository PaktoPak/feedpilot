import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { paths, settings } from "./config.js";
import { ensureDir, log } from "./util.js";

export class NoBrowserError extends Error {}
export class BrowserBusyError extends Error {}

interface BrowserChoice {
  label: string;
  executablePath: string;
}

const INSTALLED_BROWSERS: Array<[string, string[]]> = [
  [
    "Google Chrome",
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  ],
  [
    "Microsoft Edge",
    [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  ],
];

// Other Playwright-based tools often leave a Chromium in the shared cache; any recent build works.
function cachedChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
    } catch {
      continue;
    }
    dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const dir of dirs) {
      const hit = [
        ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
        ["chrome-win64", "chrome.exe"],
        ["chrome-win", "chrome.exe"],
        ["chrome-linux64", "chrome"],
        ["chrome-linux", "chrome"],
      ]
        .map((parts) => path.join(root, dir, ...parts))
        .find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  }
  return undefined;
}

export function resolveBrowser(): BrowserChoice | null {
  if (settings.browserPath && fs.existsSync(settings.browserPath)) {
    return { label: settings.browserPath, executablePath: settings.browserPath };
  }
  for (const [label, candidates] of INSTALLED_BROWSERS) {
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) return { label, executablePath: hit };
  }
  try {
    const own = chromium.executablePath();
    if (fs.existsSync(own)) return { label: "Chromium", executablePath: own };
  } catch {
    // playwright-core has no bundled browser until install_browser runs
  }
  const cached = cachedChromium();
  return cached ? { label: "Chromium", executablePath: cached } : null;
}

/** Downloads Playwright's Chromium (about 150 MB) for machines without Chrome or Edge. */
export function installChromium(): Promise<string> {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output.trim().split("\n").slice(-3).join("\n")) : reject(new Error(output.slice(-800)))));
  });
}

/** Opens a visible browser window on one account's saved profile. */
export async function openProfile(profileDir: string): Promise<{ context: BrowserContext; page: Page }> {
  const browser = resolveBrowser();
  if (!browser) {
    throw new NoBrowserError(
      "No Chrome, Edge or Chromium found on this computer. Install Google Chrome, or ask to download Chromium once (about 150 MB) with install_browser.",
    );
  }
  await ensureDir(profileDir);
  try {
    // The "controlled by automated test software" bar stays on, so it's always clear when Feedpilot is driving.
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browser.executablePath,
      headless: settings.headless,
      viewport: { width: 1280, height: 880 },
      locale: "en-US",
      // Scheduled times are typed into Instagram in the browser's time zone, so pin it to this computer's.
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      args: ["--no-first-run", "--no-default-browser-check", "--lang=en-US"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20_000);
    return { context, page };
  } catch (e: any) {
    const message = String(e?.message ?? e);
    if (/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(message)) {
      throw new BrowserBusyError("This account's browser window is already open. Close it or wait for the current task to finish.");
    }
    throw e;
  }
}

const POPUP_BUTTONS = [
  // Cookie banner: always the privacy-preserving choice.
  /^\s*(Decline optional cookies|Only allow essential cookies|Rifiuta cookie facoltativi|Consenti solo i cookie essenziali)\s*$/i,
  // "Turn on notifications?" and "Save your login info?"
  /^\s*(Not now|Non ora|Ahora no|Plus tard|Jetzt nicht|Agora não)\s*$/i,
];

export async function dismissPopups(page: Page): Promise<void> {
  for (const name of POPUP_BUTTONS) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(700);
    }
  }
}

export async function screenshot(page: Page, label: string): Promise<string | undefined> {
  try {
    await ensureDir(paths.screenshots);
    const file = path.join(paths.screenshots, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 70 });
    return file;
  } catch (e) {
    log("screenshot failed", e);
    return undefined;
  }
}
