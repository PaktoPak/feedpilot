// Developer tool: turns on "Schedule content" in the New post window, reports how the date
// picker and time fields are built, and closes without scheduling or sharing.
//   node scripts/inspect-schedule.mjs <username> <file>
import { dismissPopups, openProfile, screenshot } from "../dist/browser.js";
import { advanceToCaption, openNewPost } from "../dist/instagram/post.js";
import { gotoHome } from "../dist/instagram/session.js";
import { getAccount } from "../dist/store.js";

const [username, file] = process.argv.slice(2);
const account = await getAccount(username);
const { context, page } = await openProfile(account.profile_dir);
const dialog = page.locator('div[role="dialog"]');

const describe = (selector) =>
  page.evaluate((selector) => {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    const root = dialogs[dialogs.length - 1] ?? document.body;
    return [...root.querySelectorAll(selector)].slice(0, 60).map((el) => ({
      tag: el.tagName,
      role: el.getAttribute("role"),
      aria: el.getAttribute("aria-label"),
      disabled: el.getAttribute("aria-disabled") ?? (el.disabled ? "true" : null),
      selected: el.getAttribute("aria-selected") ?? el.getAttribute("aria-current"),
      text: (el.innerText ?? "").trim().slice(0, 40),
      value: el.value ?? null,
    }));
  }, selector);

try {
  await gotoHome(page);
  await dismissPopups(page);
  const input = await openNewPost(page);
  await input.setInputFiles([file]);
  await page.waitForTimeout(2500);
  await advanceToCaption(page);

  const scheduleRow = dialog.getByText(/^Schedule content$/).first();
  await scheduleRow.scrollIntoViewIfNeeded();
  await scheduleRow.locator("xpath=ancestor::*[.//input[@role='switch']][1]").locator('input[role="switch"]').first().click({ force: true });
  await page.waitForTimeout(1500);

  const dateLabel = dialog.getByText(/^Date$/).first();
  const dateRow = dateLabel.locator("xpath=following::*[@role='button' or @role='combobox' or self::button][1]");
  console.log("date control:", JSON.stringify(await dateRow.evaluate((el) => ({ tag: el.tagName, role: el.getAttribute("role"), aria: el.getAttribute("aria-label"), text: el.innerText.trim() }))));
  await dateRow.click();
  await page.waitForTimeout(1500);
  console.log("calendar pieces:", JSON.stringify(await describe('[role="grid"], [role="gridcell"], [role="button"][aria-label], button[aria-label], [aria-label*="month" i]'), null, 1));
  console.log("screenshot (calendar):", await screenshot(page, `${account.username}-calendar`));
  await dateRow.click().catch(() => {});
  await page.waitForTimeout(800);

  const hours = dialog.getByRole("spinbutton", { name: "Hours" });
  const minutes = dialog.getByRole("spinbutton", { name: "Minutes" });
  const ampm = dialog.getByRole("spinbutton", { name: "AM PM" });
  for (const [name, field] of [["hours", hours], ["minutes", minutes], ["ampm", ampm]]) {
    console.log(`${name} attrs:`, JSON.stringify(await field.evaluate((el) => ({ value: el.value, min: el.getAttribute("aria-valuemin"), max: el.getAttribute("aria-valuemax"), now: el.getAttribute("aria-valuenow"), text: el.getAttribute("aria-valuetext") }))));
  }
  await hours.click();
  await page.keyboard.type("07");
  await minutes.click();
  await page.keyboard.type("45");
  await ampm.click();
  await page.keyboard.type("P");
  await page.waitForTimeout(800);
  for (const [name, field] of [["hours", hours], ["minutes", minutes], ["ampm", ampm]]) {
    console.log(`${name} after typing:`, JSON.stringify(await field.evaluate((el) => ({ value: el.value, now: el.getAttribute("aria-valuenow"), text: el.getAttribute("aria-valuetext") }))));
  }
  const header = await dialog.getByRole("button", { name: /^(Share|Schedule)$/ }).allInnerTexts().catch(() => []);
  console.log("header buttons:", JSON.stringify(header));
  console.log("screenshot (time):", await screenshot(page, `${account.username}-time`));
} finally {
  await context.close();
}
