// Shared music library: list, upload, stream (Range), cover, delete.

import { Hono } from "hono";
import { stat, unlink } from "node:fs/promises";

import { config } from "../config.ts";
import { sql, type Song } from "../db/index.ts";
import {
  requireAuth,
  isAdmin,
  type AppEnv,
} from "../auth/middleware.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { getLyrics } from "../lib/lyrics.ts";
import {
  normalizeTitle,
  normalizeArtistName,
  tightTitleKey,
  diceCoefficient,
} from "../lib/text.ts";
import { findAndFlagDuplicates } from "../lib/duplicates.ts";
import {
  ensureMediaDirs,
  extractTags,
  resolveMedia,
  saveAudio,
  saveCover,
  mimeForAudioPath,
  mimeForCoverPath,
} from "../lib/media.ts";

export const songRoutes = new Hono<AppEnv>();

// Everyone authenticated sees the whole shared library.
songRoutes.get("/", requireAuth, async (c) => {
  const q = c.req.query("q")?.trim();
  const rows = await sql<Song[]>`SELECT * FROM songs ORDER BY created_at DESC`;
  if (!q) return c.json(rows.map(toPublicSong));

  // Personal-scale library: score every song in-process rather than a DB-side
  // fuzzy prefilter (same tradeoff as artists.ts / lib/duplicates.ts). Tight
  // keys mean "1800" and "1-800" match each other; dice-coefficient covers
  // typos and partial matches on top of that.
  const normQ = normalizeTitle(q);
  const tightQ = tightTitleKey(q);
  const artistQ = normalizeArtistName(q);

  const scored = rows
    .map((song) => {
      const normTitle = normalizeTitle(song.title);
      const normArtist = normalizeArtistName(song.artist);
      const titleScore =
        tightTitleKey(song.title) === tightQ || (normQ && normTitle.includes(normQ))
          ? 1
          : diceCoefficient(normQ, normTitle);
      const artistScore =
        artistQ && normArtist.includes(artistQ) ? 1 : diceCoefficient(artistQ, normArtist);
      return { song, score: Math.max(titleScore, artistScore) };
    })
    .filter((r) => r.score >= 0.35)
    .sort((a, b) => b.score - a.score);

  return c.json(scored.map((r) => toPublicSong(r.song)));
});

songRoutes.get("/:id", requireAuth, async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);
  return c.json(toPublicSong(song));
});

// Upload. title + artist required; cover + rest optional; tags auto-read.
// Admins skip the rate limit so they can bulk-import a library.
const uploadLimit = rateLimit({ name: "upload", limit: 60, windowSec: 60 });
songRoutes.post(
  "/",
  (c, next) => (isAdmin(c.get("user")) ? next() : uploadLimit(c, next)),
  requireAuth,
  async (c) => {
  await ensureMediaDirs();
  const user = c.get("user")!;

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file_required" }, 400);
  }
  if (file.size > config.maxUploadBytes) {
    return c.json({ error: "file_too_large" }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const tags = await extractTags(bytes, file.type);

  // Form fields win; fall back to embedded tags. title/artist are required.
  const title = (str(form.get("title")) ?? tags.title)?.trim();
  const artist = (str(form.get("artist")) ?? tags.artist)?.trim();
  if (!title || !artist) {
    return c.json({ error: "title_and_artist_required" }, 400);
  }

  // If the album field is present (even empty) honour it; empty => no album.
  // Only fall back to the file's embedded album tag when the field is absent.
  const albumField = form.get("album");
  const album = albumField !== null ? str(albumField) : tags.album;
  const explicit = str(form.get("explicit")) === "true";
  const filePath = await saveAudio(bytes, file.name);

  // Cover priority: uploaded cover field, else embedded art.
  let coverPath: string | null = null;
  const coverFile = form.get("cover");
  if (coverFile instanceof File && coverFile.size > 0) {
    const cbytes = new Uint8Array(await coverFile.arrayBuffer());
    const ext = coverFile.type.split("/")[1] ?? "jpg";
    coverPath = await saveCover(cbytes, ext);
  } else if (tags.cover) {
    coverPath = await saveCover(tags.cover.data, tags.cover.ext);
  }

  const rows = await sql<Song[]>`
    INSERT INTO songs
      (title, artist, album, cover_path, file_path, mime, duration_s,
       size_bytes, explicit, normalized_title, uploaded_by)
    VALUES
      (${title}, ${artist}, ${album ?? null}, ${coverPath}, ${filePath},
       ${file.type || null}, ${tags.durationS}, ${file.size}, ${explicit},
       ${normalizeTitle(title)}, ${user.id})
    RETURNING *
  `;
  const song = rows[0]!;

  // Best-effort: a possible duplicate must never block or fail the upload
  // itself. It only ever files a candidate into the admin review queue —
  // see lib/duplicates.ts.
  findAndFlagDuplicates(song).catch((err) =>
    console.error("duplicate detection failed:", err),
  );

  return c.json(toPublicSong(song), 201);
});

// Audio streaming with HTTP Range support (seek/scrub).
songRoutes.get("/:id/stream", requireAuth, async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);

  const abs = resolveMedia(song.file_path);
  const info = await stat(abs).catch(() => null);
  if (!info) return c.json({ error: "file_missing" }, 404);

  const total = info.size;
  const mime =
      song.mime && song.mime.startsWith("audio/")
        ? song.mime
        : mimeForAudioPath(song.file_path);
  const range = c.req.header("range");

  // The audio bytes for a given song id never change (an edit only touches
  // metadata; re-uploading makes a new id), so let the browser cache them
  // hard. Without this the stream had no cache headers at all, so every
  // scrub, replay, or revisit re-downloaded the whole file — the main cause
  // of "taking forever to load", especially on mobile where media buffers
  // get dropped aggressively. `private` because the endpoint is auth-gated.
  const cacheControl = "private, max-age=31536000, immutable";

  // Offload to nginx if configured: we've authenticated, so hand the file off
  // by internal redirect and let nginx do sendfile + range + caching. The app
  // never touches the bytes — the big win for a large, multi-user library.
  if (config.xaccelPrefix) {
    return new Response(null, {
      headers: {
        "content-type": mime,
        "cache-control": cacheControl,
        "accept-ranges": "bytes",
        "x-accel-redirect": `${config.xaccelPrefix}/${encodeURI(song.file_path)}`,
      },
    });
  }

  if (!range) {
    // Pass the BunFile directly (not .stream()): Bun then sends a real
    // Content-Length via efficient file streaming. With .stream() the response
    // went out chunked with no length, so the browser couldn't size the file,
    // couldn't range-seek, reported duration as Infinity (broken timer), and
    // progressively downloaded the whole track before playing.
    return new Response(Bun.file(abs), {
      headers: {
        "content-type": mime,
        "content-length": String(total),
        "accept-ranges": "bytes",
        "cache-control": cacheControl,
      },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : total - 1;

  if (start >= total || end >= total || start > end) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }

  // The sliced BunFile is a Blob backed by the file; passing it directly lets
  // Bun stream exactly those bytes with a correct Content-Length (see note
  // above on why .stream() was wrong).
  const chunk = Bun.file(abs).slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      "content-type": mime,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
      "cache-control": cacheControl,
    },
  });
});

songRoutes.get("/:id/lyrics", requireAuth, async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);

  const lyrics = await getLyrics({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationS: song.duration_s,
  });
  return c.json(lyrics);
});

songRoutes.get("/:id/cover", requireAuth, async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song?.cover_path) return c.json({ error: "not_found" }, 404);

  const abs = resolveMedia(song.cover_path);
  const info = await stat(abs).catch(() => null);
  if (!info) return c.json({ error: "not_found" }, 404);

  const coverCache = "public, max-age=86400";

  // Offload to nginx if configured (see /stream note above).
  if (config.xaccelPrefix) {
    return new Response(null, {
      headers: {
        "content-type": mimeForCoverPath(song.cover_path),
        "cache-control": coverCache,
        "x-accel-redirect": `${config.xaccelPrefix}/${encodeURI(song.cover_path)}`,
      },
    });
  }

  return new Response(Bun.file(abs), {
    headers: {
      "content-type": mimeForCoverPath(song.cover_path),
      "content-length": String(info.size),
      "cache-control": coverCache,
    },
  });
});

// Admin-only edit: fix metadata / apply the explicit tag on ANY song after
// upload. Multipart so the cover can optionally be replaced.
songRoutes.patch("/:id", requireAuth, async (c) => {
  if (!isAdmin(c.get("user"))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);

  const form = await c.req.formData();
  const title = (str(form.get("title")) ?? song.title).trim();
  const artist = (str(form.get("artist")) ?? song.artist).trim();
  if (!title || !artist) {
    return c.json({ error: "title_and_artist_required" }, 400);
  }

  // album: present-but-empty clears it; absent keeps existing.
  const albumField = form.get("album");
  const album = albumField !== null ? str(albumField) : song.album;

  // explicit: only change if the field was sent.
  const explicitField = form.get("explicit");
  const explicit =
    explicitField !== null ? str(explicitField) === "true" : song.explicit;

  let coverPath = song.cover_path;
  const coverFile = form.get("cover");
  if (coverFile instanceof File && coverFile.size > 0) {
    await ensureMediaDirs();
    const cbytes = new Uint8Array(await coverFile.arrayBuffer());
    const ext = coverFile.type.split("/")[1] ?? "jpg";
    coverPath = await saveCover(cbytes, ext);
    if (song.cover_path) {
      await unlink(resolveMedia(song.cover_path)).catch(() => {});
    }
  }

  const rows = await sql<Song[]>`
    UPDATE songs
    SET title = ${title}, artist = ${artist}, album = ${album},
        explicit = ${explicit}, cover_path = ${coverPath}
    WHERE id = ${song.id}
    RETURNING *
  `;
  // Metadata may have changed -> drop stored lyrics so they refetch for the
  // corrected title/artist on next request.
  await sql`DELETE FROM song_lyrics WHERE song_id = ${song.id}`.catch(() => {});
  return c.json(toPublicSong(rows[0]!));
});

// Only the uploader may delete.
songRoutes.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);
  if (song.uploaded_by !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  await sql`DELETE FROM songs WHERE id = ${song.id}`;
  await unlink(resolveMedia(song.file_path)).catch(() => {});
  if (song.cover_path) {
    await unlink(resolveMedia(song.cover_path)).catch(() => {});
  }
  return c.json({ ok: true });
});

// --- helpers --------------------------------------------------------------

async function getSong(id: string): Promise<Song | undefined> {
  const rows = await sql<Song[]>`SELECT * FROM songs WHERE id = ${id}`;
  return rows[0];
}

function str(v: FormDataEntryValue | null): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Shape sent to the client (never expose absolute filesystem paths).
function toPublicSong(s: Song) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    durationS: s.duration_s,
    explicit: s.explicit,
    hasCover: Boolean(s.cover_path),
    coverUrl: s.cover_path ? `/api/songs/${s.id}/cover` : null,
    streamUrl: `/api/songs/${s.id}/stream`,
    uploadedBy: s.uploaded_by,
    createdAt: s.created_at,
  };
}