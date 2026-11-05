import type { Account, Job } from "../store.js";

// Moves and cancels posts on instagram.com/scheduled_content. Filled in once the page has been
// explored with a real scheduled post; until then requests are refused up front.
export const webChangesReady = false;

export async function cancelOnInstagram(_account: Account, _job: Job): Promise<void> {
  throw new Error("Cancelling on instagram.com isn't built yet.");
}

export async function moveOnInstagram(_account: Account, _job: Job, _to: Date): Promise<void> {
  throw new Error("Moving on instagram.com isn't built yet.");
}
