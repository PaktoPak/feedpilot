// Live check without an account: the browser starts on a throwaway profile, Instagram's
// sign-in page loads, and Feedpilot sees the profile as signed out.
// Run with: FEEDPILOT_HEADLESS=1 node scripts/browser-smoke.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openProfile, resolveBrowser } from "../dist/browser.js";
import { IG, sessionUserId } from "../dist/instagram/session.js";

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "feedpilot-smoke-"));
console.log("browser:", resolveBrowser()?.label ?? "none");
const { context, page } = await openProfile(profile);
try {
  const response = await page.goto(`${IG}/accounts/login/?hl=en`, { waitUntil: "domcontentloaded" });
  console.log("login page status:", response?.status());
  await page.waitForTimeout(3000);
  console.log("signed in as:", (await sessionUserId(context)) ?? "nobody (correct for a fresh profile)");
  const form = await page.locator('input[name="username"], input[name="email"]').count();
  console.log("sign-in form found:", form > 0);
} finally {
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
