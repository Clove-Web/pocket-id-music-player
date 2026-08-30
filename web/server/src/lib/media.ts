// Filesystem helpers for stored audio + covers, and tag extraction.

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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

// --- YouTube import ------------------------------------------------------

// Only these hosts are handed to yt-dlp. yt-dlp will happily fetch from any
// site it has an extractor for (including plain http(s) URLs), so without
// this allowlist the endpoint is an SSRF primitive.
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function isSupportedYouTubeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return YT_HOSTS.has(u.hostname.toLowerCase());
}

// Thrown by downloadFromYouTube so the route can map a stable `code` to an
// HTTP status and a user-facing message.
export class YouTubeImportError extends Error {
  code: string;
  detail: string | undefined;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "YouTubeImportError";
    this.code = code;
    this.detail = detail;
  }
}

export type YouTubeImport = {
  bytes: Uint8Array;
  ext: string; // includes the leading dot, e.g. ".m4a"
  durationS: number | null;
  suggested: { title: string | null; artist: string | null; album: string | null };
  cover: { data: Uint8Array; ext: string } | null;
};

// Fetch the audio track of a single YouTube video via yt-dlp and return the
// bytes + metadata hints, for the caller to run through the normal upload
// pipeline. Everything happens in a throwaway temp dir that's always removed.
//
// Safety: host is allowlisted by the caller AND here; --no-playlist collapses
// a playlist URL to one video; --max-filesize caps the download; a wall-clock
// timer kills yt-dlp if it hangs. yt-dlp is spawned argv-style (no shell) with
// `--` before the URL.
export async function downloadFromYouTube(rawUrl: string): Promise<YouTubeImport> {
  if (!config.youtube.enabled) throw new YouTubeImportError("youtube_import_disabled");
  if (!isSupportedYouTubeUrl(rawUrl)) throw new YouTubeImportError("unsupported_url");

  const workDir = await mkdtemp(join(tmpdir(), "dmnd-yt-"));
  try {
    const proc = Bun.spawn(
      [
        config.youtube.binary,
        "--no-playlist",
        "--no-progress",
        "--no-cache-dir",
        "--no-part",
        "--socket-timeout", "30",
        "--retries", "3",
        // Prefer an already-AAC stream so --audio-format m4a only remuxes
        // (no re-encode); fall back to re-encoding whatever bestaudio is.
        "-f", "bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best",
        "--extract-audio",
        "--audio-format", "m4a",
        "--audio-quality", "0",
        "--embed-metadata",
        "--write-info-json",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
        "--max-filesize", String(config.maxUploadBytes),
        "-o", join(workDir, "audio.%(ext)s"),
        "--",
        rawUrl,
      ],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, config.youtube.timeoutMs);
    let exit: number;
    try {
      exit = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) throw new YouTubeImportError("timed_out");

    if (exit !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      if (exit === 127 || /not found|no such file|ENOENT/i.test(err)) {
        throw new YouTubeImportError("ytdlp_unavailable");
      }
      if (/max-filesize|larger than max/i.test(err)) {
        throw new YouTubeImportError("file_too_large");
      }
      console.error(`yt-dlp failed (exit ${exit}): ${err}`);
      throw new YouTubeImportError("download_failed", err.split("\n").pop() || undefined);
    }

    const entries = await readdir(workDir);
    const isImg = (n: string) => /\.(jpe?g|png|webp)$/i.test(n);
    const audioName = entries.find(
      (n) => n.startsWith("audio.") && !n.endsWith(".info.json") && !isImg(n),
    );
    if (!audioName) throw new YouTubeImportError("download_failed", "no audio produced");

    const bytes = new Uint8Array(await readFile(join(workDir, audioName)));
    if (bytes.byteLength > config.maxUploadBytes) {
      throw new YouTubeImportError("file_too_large");
    }
    const ext = extname(audioName) || ".m4a";

    const suggested: YouTubeImport["suggested"] = {
      title: null,
      artist: null,
      album: null,
    };
    let durationS: number | null = null;
    try {
      const info = JSON.parse(
        await readFile(join(workDir, "audio.info.json"), "utf8"),
      ) as Record<string, unknown>;
      const s = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : null;
      suggested.title = s(info.track) ?? s(info.title);
      suggested.artist =
        s(info.artist) ?? s(info.creator) ?? s(info.uploader) ?? s(info.channel);
      suggested.album = s(info.album);
      if (typeof info.duration === "number" && info.duration > 0) {
        durationS = Math.round(info.duration);
      }
    } catch {
      // no / unreadable info json — leave the hints null
    }

    let cover: YouTubeImport["cover"] = null;
    const thumbName = entries.find((n) => n.startsWith("audio.") && isImg(n));
    if (thumbName) {
      try {
        const tb = new Uint8Array(await readFile(join(workDir, thumbName)));
        if (tb.byteLength > 0) {
          cover = { data: tb, ext: extname(thumbName).slice(1).toLowerCase() || "jpg" };
        }
      } catch {
        // thumbnail is best-effort
      }
    }

    return { bytes, ext, durationS, suggested, cover };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
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
