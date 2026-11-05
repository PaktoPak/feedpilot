// Entry point for the background helper: run whatever is due, then exit.
import { markHelperRun } from "./helper.js";
import { runDueJobs } from "./jobs.js";
import { errorMessage, log } from "./util.js";

try {
  const ran = await runDueJobs("helper");
  await markHelperRun();
  if (ran) log(`helper ran ${ran} job(s)`);
  process.exit(0);
} catch (e) {
  log("helper run failed:", errorMessage(e));
  process.exit(1);
}
