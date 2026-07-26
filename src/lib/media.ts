// Filesystem helpers for stored audio + covers, and tag extraction.

import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import {
  join,
  resolve,
  extname,
} from "node:path";

import { parseBuffer } from "music-metadata";

import { config } from "../config.ts";

const MEDIA_ROOT = resolve(config.mediaDir);
const AUDIO_DIR = join(MEDIA_ROOT, "audio");
const COVER_DIR = join(MEDIA_ROOT, "covers");

export async function ensureMediaDirs(): Promise<void> {
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(COVER_DIR, { recursive: true });
}

// Resolve a stored relative path to an absolute one, blocking traversal.
export function resolveMedia(relPath: string): string {
  const abs = resolve(MEDIA_ROOT, relPath);
  if (!abs.startsWith(MEDIA_ROOT)) {
    throw new Error("Path traversal blocked");
  }
  return abs;
}

function randomName(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export type ExtractedTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationS: number | null;
  cover: { data: Uint8Array; ext: string } | null;
};

// Read tags embedded in the file. Everything is best-effort / nullable.
export async function extractTags(
  bytes: Uint8Array,
  mime: string | undefined,
): Promise<ExtractedTags> {
  try {
    const meta = await parseBuffer(
      bytes,
      mime ? { mimeType: mime } : undefined,
    );
    const common = meta.common;

    const pic = common.picture?.[0];
    const cover = pic
      ? {
          data: new Uint8Array(pic.data),
          ext: pic.format?.split("/")[1] ?? "jpg",
        }
      : null;

    return {
      title: common.title ?? null,
      artist: common.artist ?? null,
      album: common.album ?? null,
      durationS: meta.format.duration
        ? Math.round(meta.format.duration)
        : null,
      cover,
    };
  } catch {
    return {
      title: null,
      artist: null,
      album: null,
      durationS: null,
      cover: null,
    };
  }
}

// Persist an audio file. Returns the relative path stored in the DB.
export async function saveAudio(
  bytes: Uint8Array,
  originalName: string,
): Promise<string> {
  const ext = extname(originalName) || ".mp3";
  const rel = join("audio", `${randomName()}${ext}`);
  await writeFile(resolveMedia(rel), bytes);
  return rel;
}

// Persist a cover image. Returns the relative path stored in the DB.
export async function saveCover(
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  const clean = ext.replace(/[^a-z0-9]/gi, "") || "jpg";
  const rel = join("covers", `${randomName()}.${clean}`);
  await writeFile(resolveMedia(rel), bytes);
  return rel;
}
