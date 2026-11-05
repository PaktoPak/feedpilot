import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paths } from "./config.js";
import type { PostKind } from "./store.js";
import { normalizeUsername } from "./util.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif"]);
const VIDEO_EXT = new Set([".mp4", ".mov"]);

export const LIMITS = { carouselMax: 20, captionMax: 2200, hashtagMax: 30, mentionMax: 20 };

export const accountMediaDir = (username: string) => path.join(paths.media, normalizeUsername(username));

function mediaType(file: string): "image" | "video" | null {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

/** Full paths are used as given; bare names are looked up in the account's media folder, then the shared one. */
async function resolveFile(username: string, file: string): Promise<string | null> {
  const expanded = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [path.join(accountMediaDir(username), expanded), path.join(paths.media, expanded)];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

// Size plus the first and last 4 MB recognises the same file without reading whole videos.
async function fingerprint(file: string): Promise<string> {
  const { size } = await fs.stat(file);
  const hash = createHash("sha256").update(String(size));
  const chunk = 4 * 1024 * 1024;
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(Math.min(chunk, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > chunk) {
      const tail = Buffer.alloc(Math.min(chunk, size - chunk));
      await handle.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex").slice(0, 32);
}

export interface CheckedPost {
  files: string[];
  hashes: string[];
  kind: PostKind;
  problems: string[];
  warnings: string[];
}

export async function checkPost(username: string, files: string[], caption: string): Promise<CheckedPost> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const resolved: string[] = [];

  if (files.length === 0) problems.push("Add at least one photo or video.");
  if (files.length > LIMITS.carouselMax) {
    problems.push(`A carousel can have at most ${LIMITS.carouselMax} items; this one has ${files.length}.`);
  } else if (files.length > 10) {
    warnings.push("instagram.com may only accept 10 items per carousel. A test run will show whether more work.");
  }

  for (const file of files) {
    const found = await resolveFile(username, file);
    if (!found) {
      problems.push(`File not found: ${file}. Names without a full path are looked up in ${accountMediaDir(username)} and ${paths.media}.`);
      continue;
    }
    const type = mediaType(found);
    if (!type) {
      problems.push(`${path.basename(found)}: use JPG, PNG or HEIC for photos and MP4 or MOV for videos.`);
      continue;
    }
    const { size } = await fs.stat(found);
    if (type === "video" && size > 1024 ** 3) warnings.push(`${path.basename(found)} is over 1 GB, so the upload may take a while.`);
    resolved.push(found);
  }

  if (caption.length > LIMITS.captionMax) {
    problems.push(`The caption is ${caption.length} characters; Instagram allows ${LIMITS.captionMax}.`);
  }
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > LIMITS.hashtagMax) {
    problems.push(`The caption has ${hashtags.length} hashtags; Instagram allows ${LIMITS.hashtagMax}.`);
  }
  const mentions = caption.match(/@[\w.]+/g) ?? [];
  if (mentions.length > LIMITS.mentionMax) {
    problems.push(`The caption mentions ${mentions.length} accounts; Instagram allows ${LIMITS.mentionMax}.`);
  }

  const hashes = await Promise.all(resolved.map(fingerprint));
  const kind: PostKind = resolved.length > 1 ? "carousel" : resolved[0] && mediaType(resolved[0]) === "video" ? "reel" : "photo";
  return { files: resolved, hashes, kind, problems, warnings };
}

export interface MediaFile {
  name: string;
  path: string;
  type: "image" | "video";
  size_mb: number;
  modified: string;
}

async function filesIn(folder: string): Promise<MediaFile[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const out: MediaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(folder, entry.name);
    const type = mediaType(full);
    if (!type) continue;
    const stat = await fs.stat(full);
    out.push({ name: entry.name, path: full, type, size_mb: Math.round((stat.size / 1024 ** 2) * 10) / 10, modified: stat.mtime.toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function listMedia(username?: string): Promise<Array<{ folder: string; files: MediaFile[] }>> {
  let folders: string[];
  if (username) {
    folders = [accountMediaDir(username), paths.media];
  } else {
    const subdirs = await fs.readdir(paths.media, { withFileTypes: true }).catch(() => []);
    folders = [paths.media, ...subdirs.filter((d) => d.isDirectory()).map((d) => path.join(paths.media, d.name))];
  }
  return Promise.all(folders.map(async (folder) => ({ folder, files: await filesIn(folder) })));
}
