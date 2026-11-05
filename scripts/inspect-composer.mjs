// Developer tool: opens the New post window for a connected account, reports its switches
// and the account's type, tries the "Schedule content" switch, and closes without sharing.
//   node scripts/inspect-composer.mjs <username> <file>
import { dismissPopups, openProfile, screenshot } from "../dist/browser.js";
import { advanceToCaption, openNewPost } from "../dist/instagram/post.js";
import { gotoHome, igFetchJson, sessionUserId } from "../dist/instagram/session.js";
import { getAccount } from "../dist/store.js";

const [username, file] = process.argv.slice(2);
const account = await getAccount(username);
const { context, page } = await openProfile(account.profile_dir);

const switches = () =>
  page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    const root = dialogs[dialogs.length - 1] ?? document.body;
    return [...root.querySelectorAll('input[type="checkbox"], [role="switch"]')].map((el) => {
      let node = el;
      let text = "";
      for (let i = 0; i < 8 && node && !text; i++) {
        node = node.parentElement;
        const t = node?.innerText?.trim() ?? "";
        if (t.length > 2) text = t.split("\n")[0];
      }
      return { tag: el.tagName, role: el.getAttribute("role"), checked: el.checked ?? null, ariaChecked: el.getAttribute("aria-checked"), label: text.slice(0, 60) };
    });
  });

try {
  await gotoHome(page);
  await dismissPopups(page);
  const uid = await sessionUserId(context);
  const info = (await igFetchJson(page, `/api/v1/users/${uid}/info/`))?.user ?? {};
  const web = (await igFetchJson(page, `/api/v1/users/web_profile_info/?username=${account.username}`))?.data?.user ?? {};
  console.log("users/info type fields:", JSON.stringify({ account_type: info.account_type, is_business: info.is_business, is_professional: info.is_professional_account }));
  console.log("web_profile_info type fields:", JSON.stringify({ is_business_account: web.is_business_account, is_professional_account: web.is_professional_account, category: web.category_name ?? null }));

  const input = await openNewPost(page);
  await input.setInputFiles([file]);
  await page.waitForTimeout(2500);
  await advanceToCaption(page);
  await page.waitForTimeout(1500);
  console.log("switches:", JSON.stringify(await switches(), null, 1));

  // Expand collapsed sections so every option is visible.
  const scheduleLabel = page.locator('div[role="dialog"]').getByText(/^Schedule content$/).first();
  if (await scheduleLabel.isVisible().catch(() => false)) {
    await scheduleLabel.scrollIntoViewIfNeeded();
    const row = scheduleLabel.locator("xpath=ancestor::*[.//input[@type='checkbox'] or .//*[@role='switch']][1]");
    await row.locator('input[type="checkbox"], [role="switch"]').first().click({ force: true });
    await page.waitForTimeout(1500);
    console.log("after schedule switch:", JSON.stringify(await switches(), null, 1));
    const fields = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
      const root = dialogs[dialogs.length - 1];
      return [...root.querySelectorAll("input, select, [role='combobox'], [role='spinbutton']")]
        .filter((el) => el.type !== "file" && el.type !== "checkbox")
        .map((el) => ({ tag: el.tagName, type: el.type ?? null, role: el.getAttribute("role"), aria: el.getAttribute("aria-label"), placeholder: el.getAttribute("placeholder"), value: el.value ?? null }));
    });
    console.log("schedule fields:", JSON.stringify(fields, null, 1));
    const header = await page.locator('div[role="dialog"]').getByRole("button", { name: /^(Share|Schedule)$/ }).allInnerTexts().catch(() => []);
    console.log("header buttons:", JSON.stringify(header));
  } else {
    console.log("no Schedule content option for this account");
  }
  console.log("screenshot:", await screenshot(page, `${account.username}-inspect`));
} finally {
  await context.close();
}
