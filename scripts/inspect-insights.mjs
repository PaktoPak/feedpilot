// Developer tool, read-only: reports where instagram.com shows an account's numbers.
//   node scripts/inspect-insights.mjs <username> <post-path, e.g. p/CODE>
import { dismissPopups, openProfile, screenshot } from "../dist/browser.js";
import { gotoHome, IG } from "../dist/instagram/session.js";
import { getAccount } from "../dist/store.js";

const [username, postPath] = process.argv.slice(2);
const account = await getAccount(username);
const { context, page } = await openProfile(account.profile_dir);
const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ");

try {
  await gotoHome(page);
  await dismissPopups(page);
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")]
      .map((a) => ({ href: a.getAttribute("href"), label: (a.getAttribute("aria-label") || a.innerText || "").trim().slice(0, 30) }))
      .filter((l) => /insight|dashboard|professional|account/i.test(l.href + " " + l.label)),
  );
  console.log("insight-ish links on home:", JSON.stringify(nav));

  await page.goto(`${IG}/${username}/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const header = await page.evaluate(() => (document.querySelector("header")?.innerText ?? "").replace(/\n+/g, " | "));
  console.log("profile header:", header.slice(0, 300));
  const profileLinks = await page.evaluate(() =>
    [...document.querySelectorAll("a[href], [role=button]")]
      .map((a) => (a.getAttribute("href") || "") + " :: " + (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 40))
      .filter((l) => /insight|dashboard|professional/i.test(l)),
  );
  console.log("insight-ish controls on profile:", JSON.stringify(profileLinks));

  await page.goto(`${IG}/${postPath}/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  console.log("post page text:", (await text()).slice(0, 700));
  const view = page.getByText(/^View insights$/i).first();
  if (await view.isVisible().catch(() => false)) {
    await view.click();
    await page.waitForTimeout(4000);
    console.log("after View insights, url:", page.url());
    console.log("insights text:", (await text()).slice(0, 1500));
    console.log("screenshot:", await screenshot(page, `${username}-post-insights`));
  } else {
    console.log("no View insights control on the post page");
  }

  for (const guess of ["/accounts/insights/", "/insights/", "/accounts/dashboard/", "/professional_dashboard/"]) {
    const response = await page.goto(`${IG}${guess}?hl=en`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const t = await text();
    console.log(guess, response?.status(), "| not found:", /Sorry, this page isn.t available/i.test(t), "|", t.slice(0, 200));
  }
} finally {
  await context.close();
}
