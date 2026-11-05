# Feedpilot

Run your Instagram accounts from Claude Desktop. Connect any account (personal, Creator or Business), then, by chatting with Claude: post and schedule photos, carousels and reels on several accounts at once, follow each account's stats, answer DMs and comments, and plan what to post next.

Feedpilot is free and open source. It runs on your computer and works through instagram.com in a browser window, with one saved sign-in per account. It does not use an official Instagram API, and automating instagram.com is against Instagram's terms. Approvals and pace limits keep it close to normal use, but you use it at your own risk.

## What version 0.1 does

- **Connect accounts.** A browser window opens on Instagram's sign-in page and you sign in yourself. Feedpilot never sees your password. Connect as many accounts as you like; each keeps its own sign-in, so they never mix.
- **Several accounts at once.** One preview can hold a post for each of several accounts, each with its own caption, files and time, and you approve them together. Feedpilot works on up to 3 accounts at the same time (change it in the settings), one browser window each. An overview shows every account's day at a glance.
- **Post and schedule.** Single photos, carousels and reels, with a caption. Post right away or pick a time. Scheduled posts are handed to Instagram's own scheduler, so they go out even when your computer is off.
- **Test runs.** Fill in every posting step and stop just before Share or Schedule, with a screenshot of the result. Nothing is published.
- **Background helper (optional, Mac and Windows).** For the posts Instagram's scheduler can't take, it sends them on time while Claude Desktop is closed. It is only ever installed after you read what it does and say yes.

- **Stats.** Followers, following and each recent post's likes, comments and reel views, refreshed every 6 hours for every account (or on request) and kept as snapshots, so history grows beyond Instagram's 90 days and you can see how fast each post took off in its first day. Compare all accounts side by side.

- **Messages.** Reads every account's DM inbox at once, including message requests, with each chat's last few messages and whether it's waiting for your reply. Reading never opens a chat, so nobody sees "Seen". Claude drafts replies; each one is sent only after you approve its exact text, only in existing chats (there's no way to message someone new), with a limit of 20 replies per account per hour. Replying to a request accepts it, so that needs your OK too.

- **Comments.** Reads the comments on every account's recent posts at once, and shows which ones nobody has answered. Claude can reply, like, or delete spam, each only after you approve that exact action; deleting has no undo.
- **Analysis shortcuts.** Four ready-made prompts in Claude Desktop's prompt menu: **Weekly review** (what worked on each account and what to do more of), **Inbox triage** (sort DMs and comments into leads, questions and spam, with draft replies to approve), **Content plan** (next week's posts per account, from what performed best and what people ask for) and **Compare accounts** (growth and engagement side by side).

## Install

1. Download `feedpilot.mcpb` from the releases page.
2. Double-click it, or drag it into Claude Desktop. Claude Desktop installs it.
3. Optional: in Claude Desktop's extension settings, choose a different data folder or daily post limit.

You need Claude Desktop on a Mac or a Windows PC, and Google Chrome or Microsoft Edge (Edge comes with Windows). With neither, Feedpilot can download Chromium once (about 150 MB) when you ask it to.

## Using it

Talk to Claude in plain words:

- "Connect my Instagram." A window opens; sign in there, then tell Claude you're done.
- "What accounts are connected?"
- "Post sunset.jpg to @myshop with the caption 'Golden hour'."
- "Schedule these three photos as a carousel on @mybrand for Friday at 6pm."
- "Post this reel on @shop_a, @shop_b and @shop_c tonight at 8, with a different caption for each."
- "How are all my accounts doing today?" / "Check that all my accounts are still signed in."
- "Which of my posts did best this month?" / "Compare follower growth across my accounts."
- "What came in overnight across all my accounts?" / "Draft replies to the chats waiting on @myshop."
- "Which comments haven't been answered yet?" / "Delete the spam comments on yesterday's reel."
- "Do a test run of that post first."
- "What's scheduled this week?" / "Move the Friday post to Saturday." / "Cancel it."
- "Set up the background helper."

Before anything is published, Claude shows you a preview with the account, files, caption and time, and waits for your yes.

## Where your data lives

Everything is in one folder: by default `~/Feedpilot` on a Mac, `C:\Users\<you>\Feedpilot` on Windows.

- `profiles/` holds one browser profile per account. It contains that account's sign-in, so keep it private.
- `media/<account>/` is where you can drop photos and videos to post by file name.
- `state/` holds the account list, the queue and the activity log.
- `screenshots/` holds screenshots from test runs and failures.

Nothing is sent anywhere except to Instagram, through the browser, and what Claude reads when you ask it something.

## Safety rules built in

- Every post needs your approval, and each approval works once.
- Before every post, Feedpilot checks that the window is signed in to the right account.
- Posts go to Instagram only: Feedpilot switches off Instagram's "Share to Facebook" and "Share to Threads" for each post.
- At most 5 posts per account per day by default; change it in the extension settings.
- A post that couldn't go out is retried up to 3 times, but only when it definitely wasn't shared yet. If Share was clicked and Instagram's confirmation never appeared, it stops and asks you to check, so nothing is posted twice.
- A scheduled post that's more than 2 hours late, because the computer was off, is held for you instead of going out at an unexpected time.
- When the same file is already posted on another of your accounts, Feedpilot warns you: Instagram reduces reach for identical reposts.
- Every action is written to an activity log you can ask about.

## How scheduling works

- **25 minutes or more ahead:** right after you approve, Feedpilot fills in the post on instagram.com and turns on Instagram's "Schedule content" with your date and time. Instagram holds it and publishes it then, even if your computer is off. After its time, Feedpilot finds it on the profile and records the link.
- **Changing or cancelling one of those:** Instagram holds it now, so do it in the Instagram app: Profile, then the menu, then Scheduled content.
- **Less than 25 minutes ahead, or an account without "Schedule content":** Feedpilot posts it itself at the time. That needs Claude Desktop open then, or the background helper.

## The background helper

It only matters for posts Feedpilot sends itself (see above). Without it, those go out only while Claude Desktop is open. With it, they go out whenever your computer is on and you're signed in.

It runs once a minute, checks the queue and exits, and it can only publish posts you already approved:

- **Mac:** a standard launch agent, `~/Library/LaunchAgents/com.feedpilot.worker.plist`.
- **Windows:** a scheduled task named "Feedpilot worker" for your user only, with no admin rights, plus three small files in the data folder's `helper` folder. It starts hidden, so no window flashes.

Claude must first show you exactly what it installs; installing needs a one-time code from that explanation. Ask Claude to remove it any time, or delete the file or task yourself.

## Development

```bash
npm install
npm test          # builds, then runs the tests with a stand-in for Instagram
npm run pack:mcpb # builds build/feedpilot.mcpb
```

This works the same on macOS and Windows. Tests never touch Instagram or your system's scheduler: `FEEDPILOT_FAKE_POSTER` swaps in a stand-in poster, `FEEDPILOT_SKIP_SYSTEM_SCHEDULER=1` writes the helper's files without registering them, and `FEEDPILOT_HELPER_PLATFORM` picks which system's helper to build.

## License

MIT
