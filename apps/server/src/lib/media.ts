// Filesystem helpers for stored audio + covers, and tag extraction.

import {
  mkdir,
  writeFile,
  rm,
  stat,
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

// Extension -> MIME lookups.
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  // Our transcodes (and typical .opus files) are Opus-in-Ogg. "audio/ogg" is
  // the container type browsers reliably accept for that; "audio/opus" is not
  // a registered file type and some players refuse it.
  ".opus": "audio/ogg",
  ".weba": "audio/webm",
};

// Uploaded formats worth transcoding to Opus: the big lossless ones. Already-
// compressed uploads (mp3/aac/m4a/ogg/opus) are left as-is — re-encoding them
// would just lose quality for little size win.
const LOSSLESS_EXTS = new Set([".flac", ".wav", ".aif", ".aiff"]);

export function isLosslessMaster(relPath: string): boolean {
  return LOSSLESS_EXTS.has(extname(relPath).toLowerCase());
}

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export function mimeForAudioPath(relPath: string): string {
  return AUDIO_MIME[extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

export function mimeForCoverPath(relPath: string): string {
  return IMAGE_MIME[extname(relPath).toLowerCase()] ?? "image/jpeg";
}

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

// Transcode a stored master to Ogg-Opus and persist it alongside. Returns the
// relative path of the new .opus file, or null if transcoding is disabled or
// ffmpeg failed (caller then just keeps streaming the master).
//
// -vn drops any embedded cover art (we serve covers separately, and art in an
// Opus stream trips up some players). libopus with VBR at the configured
// bitrate is transparent for music at 128k+ while being ~5-10x smaller than a
// FLAC.
export async function transcodeToOpus(
  masterRelPath: string,
): Promise<string | null> {
  if (!config.opus.enabled) return null;

  const inAbs = resolveMedia(masterRelPath);
  const outRel = join("audio", `${randomName()}.opus`);
  const outAbs = resolveMedia(outRel);

  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inAbs,
        "-vn",
        "-c:a",
        "libopus",
        "-b:a",
        config.opus.bitrate,
        "-vbr",
        "on",
        "-application",
        "audio",
        "-f",
        "opus",
        outAbs,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      console.error(`ffmpeg transcode failed (exit ${exit}): ${err.trim()}`);
      await rm(outAbs, { force: true }).catch(() => {});
      return null;
    }
    return outRel;
  } catch (err) {
    // ffmpeg missing from PATH, spawn failure, etc. — never fatal.
    console.error("transcodeToOpus error:", err);
    await rm(outAbs, { force: true }).catch(() => {});
    return null;
  }
}

// Serve a stored audio file as an HTTP response: HTTP Range (seek/scrub),
// nginx X-Accel offload when configured, hard caching, and — when
// `attachmentName` is set — a Content-Disposition that makes the browser save
// it instead of playing it (used by the /song/:id?download=1 share link).
//
// Shared by the auth-gated /api/songs/:id/stream endpoint and the public
// download route so the byte-serving logic lives in exactly one place.
export async function serveAudioFile(
  rangeHeader: string | undefined,
  opts: {
    absPath: string;
    servePath: string; // stored relative path, for X-Accel-Redirect
    mime: string;
    cacheControl?: string;
    attachmentName?: string;
  },
): Promise<Response> {
  const { absPath, servePath, mime, attachmentName } = opts;
  const cacheControl = opts.cacheControl ?? "private, max-age=31536000, immutable";

  const info = await stat(absPath).catch(() => null);
  if (!info) return new Response("Not found", { status: 404 });
  const total = info.size;

  const disposition = attachmentName
    ? `attachment; filename="${attachmentName.replace(/["\\\r\n]/g, "")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(attachmentName)}`
    : undefined;

  // Offload to nginx if configured: we've already done any auth check, so hand
  // the file off by internal redirect and let nginx do sendfile + range.
  if (config.xaccelPrefix) {
    const headers: Record<string, string> = {
      "content-type": mime,
      "cache-control": cacheControl,
      "accept-ranges": "bytes",
      "x-accel-redirect": `${config.xaccelPrefix}/${encodeURI(servePath)}`,
    };
    if (disposition) headers["content-disposition"] = disposition;
    return new Response(null, { headers });
  }

  if (!rangeHeader) {
    const headers: Record<string, string> = {
      "content-type": mime,
      "content-length": String(total),
      "accept-ranges": "bytes",
      "cache-control": cacheControl,
    };
    if (disposition) headers["content-disposition"] = disposition;
    return new Response(Bun.file(absPath), { headers });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : total - 1;

  if (start >= total || end >= total || start > end) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }

  const chunk = Bun.file(absPath).slice(start, end + 1);
  const headers: Record<string, string> = {
    "content-type": mime,
    "content-length": String(end - start + 1),
    "content-range": `bytes ${start}-${end}/${total}`,
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
  };
  if (disposition) headers["content-disposition"] = disposition;
  return new Response(chunk, { status: 206, headers });
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
