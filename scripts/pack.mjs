// Builds build/feedpilot.mcpb with only production dependencies inside. Runs on macOS, Windows and Linux.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "build", "stage");
const run = (command, cwd = root) => execSync(command, { cwd, stdio: "inherit" });

run("npm run build");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of ["dist", "manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
  fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
}
run("npm ci --omit=dev --no-audit --no-fund --silent", stage);
run(`npx mcpb validate "${path.join(stage, "manifest.json")}"`);
run(`npx mcpb pack "${stage}" "${path.join(root, "build", "feedpilot.mcpb")}"`);
