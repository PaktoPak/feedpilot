// Developer harness: drives the real Feedpilot server over MCP from a terminal.
//   node scripts/dev.mjs connect [username]                     sign in (waits until done)
//   node scripts/dev.mjs test <username> <caption> <file...> [--at=ISO]   test run that stops before Share
//   node scripts/dev.mjs post <username> <caption> <file...> [--at=ISO]   publishes or schedules for real
//   node scripts/dev.mjs test-batch '<posts json>'              test run for several accounts at once
//   node scripts/dev.mjs call <tool> [json-args]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "feedpilot-dev", version: "0.0.0" });
await client.connect(transport);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function postsFromArgs(rest) {
  const postAt = rest.find((a) => a.startsWith("--at="))?.slice(5);
  const [username, caption, ...files] = rest.filter((a) => !a.startsWith("--at="));
  return [{ username, files, caption, ...(postAt ? { post_at: postAt } : {}) }];
}

/** Polls until no job in the batch is still waiting or running. */
async function waitForBatch(batchId) {
  for (;;) {
    await sleep(3000);
    const status = await call("get_post_status", { batch_id: batchId });
    if (!/: (scheduled|running)[ ,(]/.test(status)) return status;
  }
}

async function preview(posts) {
  const text = await call("preview_post", { posts });
  console.log(text);
  return text.match(/preview_id: (preview_[0-9a-f]{8})/)?.[1];
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "connect") {
    const started = await call("connect_account", rest[0] ? { username: rest[0] } : {});
    console.log(started);
    const id = started.match(/connect_id: (connect_[0-9a-f]+)/)?.[1];
    while (id) {
      await sleep(3000);
      const status = await call("check_connection", { connect_id: id });
      if (!status.startsWith("Still waiting")) {
        console.log(status);
        await sleep(3000); // let the window close itself
        break;
      }
    }
  } else if (command === "test" || command === "test-batch" || command === "post") {
    const posts = command === "test-batch" ? JSON.parse(rest[0]) : postsFromArgs(rest);
    const previewId = await preview(posts);
    if (!previewId) {
      process.exitCode = 1;
    } else {
      // "post" publishes or schedules for real: only run it with the account owner's explicit approval.
      const started =
        command === "post" ? await call("create_post", { preview_id: previewId, user_confirmed: true }) : await call("test_post", { preview_id: previewId });
      console.log(started);
      const jobIds = [...started.matchAll(/\b((?:post|test)_[0-9a-f]{8})\b/g)].map((m) => m[1]);
      if (!jobIds.length) throw new Error("No job ids in the reply.");
      const batchId = started.match(/\b(batch_[0-9a-f]{8})\b/)?.[1];
      if (batchId) {
        console.log(await waitForBatch(batchId));
      } else {
        for (;;) {
          await sleep(3000);
          const status = await call("get_post_status", { job_id: jobIds[0] });
          if (!/: (scheduled|running)[ ,(]/.test(status)) {
            console.log(status);
            break;
          }
        }
      }
    }
  } else if (command === "call") {
    console.log(await call(rest[0], rest[1] ? JSON.parse(rest[1]) : {}));
  } else {
    console.log("usage: node scripts/dev.mjs connect [username] | test|post <username> <caption> <file...> [--at=ISO] | test-batch '<posts json>' | call <tool> [json]");
  }
} finally {
  await client.close();
}
