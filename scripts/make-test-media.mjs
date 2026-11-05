// Renders two 1080x1350 test photos into Feedpilot's shared media folder.
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowser } from "../dist/browser.js";
import { paths } from "../dist/config.js";
import { ensureDir } from "../dist/util.js";

const photos = [
  ["feedpilot-test-1.jpg", "#ff6b6b", "#feca57", "Feedpilot test 1"],
  ["feedpilot-test-2.jpg", "#48dbfb", "#5f27cd", "Feedpilot test 2"],
];

await ensureDir(paths.media);
const browser = await chromium.launch({ executablePath: resolveBrowser().executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
for (const [name, from, to, label] of photos) {
  await page.setContent(
    `<body style="margin:0;height:1350px;display:grid;place-items:center;background:linear-gradient(135deg,${from},${to});font:bold 96px -apple-system,Helvetica,sans-serif;color:white">${label}</body>`,
  );
  const file = path.join(paths.media, name);
  await page.screenshot({ path: file, type: "jpeg", quality: 90 });
  console.log(file);
}
await browser.close();
