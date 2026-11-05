import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { call, makeDataDir, startClient } from "./helpers.mjs";

// Builds the Windows helper's files on any system, without registering a task.
let client;
let dataDir;

before(async () => {
  dataDir = await makeDataDir();
  client = await startClient({ FEEDPILOT_DATA_DIR: dataDir, FEEDPILOT_FAKE_POSTER: "ok", FEEDPILOT_HELPER_PLATFORM: "win32", FEEDPILOT_SKIP_SYSTEM_SCHEDULER: "1" });
});

after(async () => {
  await client?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("explains, installs and removes the Windows background helper", async () => {
  const explained = await call(client, "background_helper", { action: "explain" });
  assert.match(explained.text, /a Windows scheduled task named "Feedpilot worker", for this user only and with no admin rights/);
  assert.match(explained.text, /signed in to Windows/);
  const code = explained.text.match(/Confirmation code: ([0-9A-F]{6})/)?.[1];
  assert.ok(code, explained.text);

  assert.equal((await call(client, "background_helper", { action: "install" })).isError, true, "no install without the code");
  assert.match((await call(client, "background_helper", { action: "install", confirmation_code: code })).text, /Background helper installed \(Task Scheduler: Feedpilot worker/);

  const dir = path.join(dataDir, "helper");
  const cmd = await fs.readFile(path.join(dir, "run-worker.cmd"), "utf8");
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes(`set "FEEDPILOT_DATA_DIR=${dataDir}"`), cmd);
  assert.match(cmd, /dist[\\/]worker\.js" --once >> ".*helper\.log" 2>&1/);

  const vbs = await fs.readFile(path.join(dir, "run-worker.vbs"), "utf8");
  assert.ok(vbs.includes(`Chr(34) & "${path.join(dir, "run-worker.cmd")}" & Chr(34), 0, True`), vbs);

  const raw = await fs.readFile(path.join(dir, "task.xml"));
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], "UTF-16 byte order mark");
  const xml = raw.subarray(2).toString("utf16le");
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.ok(xml.includes(`<Arguments>"${path.join(dir, "run-worker.vbs")}"</Arguments>`), xml);

  assert.match((await call(client, "background_helper", { action: "status" })).text, /Installed: yes/);
  assert.match((await call(client, "background_helper", { action: "remove" })).text, /removed/);
  await assert.rejects(fs.stat(dir));
  assert.match((await call(client, "background_helper", { action: "status" })).text, /not installed/);
});
