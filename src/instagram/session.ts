import type { BrowserContext, Page } from "playwright-core";
import type { AccountType } from "../store.js";

export const IG = "https://www.instagram.com";
// The public app id instagram.com's own pages send with their data requests.
const IG_WEB_APP_ID = "936619743392459";

/** The signed-in user's id, or null when this browser profile is signed out. */
export async function sessionUserId(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies(IG);
  const signedIn = cookies.some((c) => c.name === "sessionid" && c.value);
  const userId = cookies.find((c) => c.name === "ds_user_id" && c.value)?.value;
  return signedIn && userId ? userId : null;
}

export async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${IG}/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
}

/** Fetches JSON the way instagram.com's own pages do, using the account's session. Page must be on instagram.com. */
export async function igFetchJson(page: Page, url: string): Promise<any | null> {
  return page.evaluate(
    async ({ url, appId }) => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrftoken="))?.slice("csrftoken=".length) ?? "";
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: { "X-IG-App-ID": appId, "X-CSRFToken": csrf, "X-Requested-With": "XMLHttpRequest" },
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    },
    { url, appId: IG_WEB_APP_ID },
  );
}

export interface ProfileInfo {
  username?: string;
  full_name?: string;
  is_private?: boolean;
  account_type: AccountType;
}

/** Reads the signed-in account's details from its own Edit profile data and Privacy page. Leaves the page on the Privacy page. */
export async function currentProfile(page: Page): Promise<ProfileInfo> {
  // The Edit profile form's data is the one account request instagram.com still answers on the web;
  // the user-info and feed endpoints return 404 or 429 there.
  const form = (await igFetchJson(page, "/api/v1/accounts/edit/web_form_data/"))?.form_data;
  const privacy = await readPrivacySwitch(page);
  let account_type: AccountType = "unknown";
  if (form?.business_account === true) account_type = "business";
  // Professional accounts can't be made private, so a working Private account switch means a personal account.
  else if (privacy && !privacy.disabled) account_type = "personal";
  return {
    username: form?.username ? String(form.username).toLowerCase() : undefined,
    full_name: form?.first_name || undefined,
    is_private: privacy?.checked,
    account_type,
  };
}

async function readPrivacySwitch(page: Page): Promise<{ checked: boolean; disabled: boolean } | null> {
  await page.goto(`${IG}/accounts/privacy_setting/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[role="switch"], input[type="checkbox"]'))) {
      let node: HTMLElement | null = el;
      let text = "";
      for (let i = 0; i < 8 && node && !text; i++) {
        node = node.parentElement;
        const t = node?.innerText?.trim() ?? "";
        if (t.length > 2) text = t;
      }
      if (/Private account|Account privato/i.test(text)) return { checked: el.checked, disabled: el.disabled };
    }
    return null;
  });
}
