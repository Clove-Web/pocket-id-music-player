// Shared music library: list, upload, stream (Range), cover, delete.

import { Hono } from "hono";
import { stat, unlink } from "node:fs/promises";

import { config } from "../config.ts";
import {
  sql,
  type Song,
  type SongEditRequest,
  type User,
} from "../db/index.ts";
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
  isLosslessMaster,
  transcodeToOpus,
  serveAudioFile,
} from "../lib/media.ts";

export const songRoutes = new Hono<AppEnv>();

// Open to everyone: the shared library streams without an account. Signed-in
// users additionally see their own not-yet-approved uploads; anonymous callers
// (and other users) only see approved songs.
songRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const me = c.get("user")?.id ?? null;
  const visible = me
    ? sql`(s.status = 'approved' OR s.uploaded_by = ${me})`
    : sql`s.status = 'approved'`;
  const rows = await sql<Array<Song & { resolved_artist_id: string | null }>>`
    SELECT s.*,
      (SELECT sa.artist_id FROM song_artists sa WHERE sa.song_id = s.id
       ORDER BY (sa.role = 'primary') DESC, sa.role LIMIT 1) AS resolved_artist_id
    FROM songs s
    WHERE ${visible}
    ORDER BY s.created_at DESC
  `;
  if (!q) return c.json(rows.map((s) => toPublicSong(s, s.resolved_artist_id)));

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

  return c.json(scored.map((r) => toPublicSong(r.song, r.song.resolved_artist_id)));
});

// --- liked songs (per-user favourites) ---------------------------------
// Declared before "/:id" so "liked" isn't captured as a song id.

songRoutes.get("/liked", requireAuth, async (c) => {
  const user = c.get("user")!;
  const rows = await sql<Array<Song & { resolved_artist_id: string | null }>>`
    SELECT s.*,
      (SELECT sa.artist_id FROM song_artists sa WHERE sa.song_id = s.id
       ORDER BY (sa.role = 'primary') DESC, sa.role LIMIT 1) AS resolved_artist_id
    FROM liked_songs l
    JOIN songs s ON s.id = l.song_id
    WHERE l.user_id = ${user.id}
      AND (s.status = 'approved' OR s.uploaded_by = ${user.id})
    ORDER BY l.created_at DESC
  `;
  return c.json(rows.map((s) => toPublicSong(s, s.resolved_artist_id)));
});

// --- admin: pending uploads ------------------------------------------------

songRoutes.get("/pending", requireAuth, async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const rows = await sql<
    Array<Song & { resolved_artist_id: string | null; uploader_name: string | null }>
  >`
    SELECT s.*,
      (SELECT sa.artist_id FROM song_artists sa WHERE sa.song_id = s.id
       ORDER BY (sa.role = 'primary') DESC, sa.role LIMIT 1) AS resolved_artist_id,
      u.name AS uploader_name
    FROM songs s
    LEFT JOIN users u ON u.id = s.uploaded_by
    WHERE s.status = 'pending'
    ORDER BY s.created_at ASC
  `;
  return c.json(
    rows.map((s) => ({
      ...toPublicSong(s, s.resolved_artist_id),
      uploaderName: s.uploader_name,
    })),
  );
});

// --- admin: song metadata edit requests ---------------------------------

songRoutes.get("/edit-requests", requireAuth, async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const status = c.req.query("status") ?? "pending";
  const rows = await sql<
    Array<
      SongEditRequest & {
        cur_title: string;
        cur_artist: string;
        cur_album: string | null;
        cur_explicit: boolean;
        requested_by_name: string | null;
      }
    >
  >`
    SELECT r.*,
      s.title    AS cur_title,
      s.artist   AS cur_artist,
      s.album    AS cur_album,
      s.explicit AS cur_explicit,
      u.name     AS requested_by_name
    FROM song_edit_requests r
    JOIN songs s      ON s.id = r.song_id
    LEFT JOIN users u ON u.id = r.requested_by
    WHERE r.status = ${status}
    ORDER BY r.created_at ASC
  `;
  return c.json(rows.map(toPublicEditRequest));
});

songRoutes.post("/edit-requests/:reqId/approve", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!isAdmin(user)) return c.json({ error: "forbidden" }, 403);

  const req = (
    await sql<SongEditRequest[]>`
      SELECT * FROM song_edit_requests WHERE id = ${c.req.param("reqId")!} AND status = 'pending'
    `
  )[0];
  if (!req) return c.json({ error: "not_found" }, 404);

  const song = await getSong(req.song_id);
  if (!song) {
    await sql`
      UPDATE song_edit_requests
      SET status = 'rejected', decided_at = now(), decided_by = ${user.id}
      WHERE id = ${req.id}
    `;
    return c.json({ error: "song_not_found" }, 404);
  }

  const title = (req.title ?? song.title).trim();
  const artist = (req.artist ?? song.artist).trim();
  const album = req.album !== null ? req.album : song.album;
  const explicit = req.explicit !== null ? req.explicit : song.explicit;

  await sql.begin(async (tx) => {
    await tx`
      UPDATE songs
      SET title = ${title}, artist = ${artist}, album = ${album},
          explicit = ${explicit}, normalized_title = ${normalizeTitle(title)}
      WHERE id = ${song.id}
    `;
    await tx`DELETE FROM song_lyrics WHERE song_id = ${song.id}`;
    await tx`
      UPDATE song_edit_requests
      SET status = 'approved', decided_at = now(), decided_by = ${user.id}
      WHERE id = ${req.id}
    `;
  });
  return c.json({ ok: true });
});

songRoutes.post("/edit-requests/:reqId/reject", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!isAdmin(user)) return c.json({ error: "forbidden" }, 403);
  const rows = await sql<SongEditRequest[]>`
    UPDATE song_edit_requests
    SET status = 'rejected', decided_at = now(), decided_by = ${user.id}
    WHERE id = ${c.req.param("reqId")!} AND status = 'pending'
    RETURNING *
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

songRoutes.get("/:id", async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);
  if (!canSee(song, c.get("user"))) return c.json({ error: "not_found" }, 404);
  return c.json(toPublicSong(song, await getPrimaryArtistId(song.id)));
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

  // Admin uploads go live immediately; everyone else's wait for admin review
  // (hidden from the public library, visible to the uploader) — see GET "/".
  const status = isAdmin(user) ? "approved" : "pending";

  const rows = await sql<Song[]>`
    INSERT INTO songs
      (title, artist, album, cover_path, file_path, mime, duration_s,
       size_bytes, explicit, normalized_title, uploaded_by, status)
    VALUES
      (${title}, ${artist}, ${album ?? null}, ${coverPath}, ${filePath},
       ${file.type || null}, ${tags.durationS}, ${file.size}, ${explicit},
       ${normalizeTitle(title)}, ${user.id}, ${status})
    RETURNING *
  `;
  const song = rows[0]!;

  // Best-effort: a possible duplicate must never block or fail the upload
  // itself. It only ever files a candidate into the admin review queue —
  // see lib/duplicates.ts.
  findAndFlagDuplicates(song).catch((err) =>
    console.error("duplicate detection failed:", err),
  );

  // Kick off the Opus transcode in the background for lossless masters. The
  // upload returns immediately; until stream_path lands, /stream falls back to
  // the master, so nothing waits on ffmpeg. Fire-and-forget, like dupes above.
  if (isLosslessMaster(song.file_path)) {
    transcodeToOpus(song.file_path)
      .then(async (streamPath) => {
        if (!streamPath) return;
        await sql`
          UPDATE songs SET stream_path = ${streamPath} WHERE id = ${song.id}
        `;
      })
      .catch((err) => console.error("opus transcode failed:", err));
  }

  return c.json(toPublicSong(song), 201);
});

// Audio streaming with HTTP Range support (seek/scrub). Open to everyone —
// streaming needs no account.
songRoutes.get("/:id/stream", async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song || !canSee(song, c.get("user"))) {
    return c.json({ error: "not_found" }, 404);
  }
  return serveSongStream(c.req.header("range"), song);
});

// Download the ORIGINAL uploaded master (never the Opus transcode) as a file.
// Backs the /song/:id?download=1 share link. Open to everyone.
songRoutes.get("/:id/download", async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song || !canSee(song, c.get("user"))) {
    return c.json({ error: "not_found" }, 404);
  }
  return serveSongDownload(c.req.header("range"), song);
});

songRoutes.get("/:id/lyrics", async (c) => {
  const song = await getSong(c.req.param("id")!);
  if (!song || !canSee(song, c.get("user"))) {
    return c.json({ error: "not_found" }, 404);
  }

  const lyrics = await getLyrics({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationS: song.duration_s,
  });
  return c.json(lyrics);
});

// Public on purpose (no requireAuth): Discord Rich Presence shows the album
// art as the large image, and Discord fetches that URL from its own servers
// with no session. Covers are unlisted — reachable only via the song's random
// UUID — and it's only album art; the audio stream stays auth-gated.
songRoutes.get("/:id/cover", async (c) => {
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

// --- like / unlike -------------------------------------------------------

songRoutes.put("/:id/like", requireAuth, async (c) => {
  const user = c.get("user")!;
  const song = await getSong(c.req.param("id")!);
  if (!song || !canSee(song, user)) return c.json({ error: "not_found" }, 404);
  await sql`
    INSERT INTO liked_songs (user_id, song_id)
    VALUES (${user.id}, ${song.id})
    ON CONFLICT (user_id, song_id) DO NOTHING
  `;
  return c.json({ liked: true });
});

songRoutes.delete("/:id/like", requireAuth, async (c) => {
  const user = c.get("user")!;
  await sql`
    DELETE FROM liked_songs
    WHERE user_id = ${user.id} AND song_id = ${c.req.param("id")!}
  `;
  return c.json({ liked: false });
});

// --- admin: approve / reject a pending upload ---------------------------

songRoutes.post("/:id/approve", requireAuth, async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const rows = await sql<Song[]>`
    UPDATE songs SET status = 'approved'
    WHERE id = ${c.req.param("id")!} AND status = 'pending'
    RETURNING *
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

songRoutes.post("/:id/reject", requireAuth, async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const song = await getSong(c.req.param("id")!);
  if (!song || song.status !== "pending") {
    return c.json({ error: "not_found" }, 404);
  }
  // Reject == unwanted upload: remove it and its files (mirrors DELETE /:id
  // and the duplicate queue's "mark duplicate" behaviour).
  await sql`DELETE FROM songs WHERE id = ${song.id}`;
  await unlink(resolveMedia(song.file_path)).catch(() => {});
  if (song.stream_path) await unlink(resolveMedia(song.stream_path)).catch(() => {});
  if (song.cover_path) await unlink(resolveMedia(song.cover_path)).catch(() => {});
  return c.json({ ok: true });
});

// Non-admins propose a metadata fix; an admin approves it (see the
// /edit-requests routes above). Admins use PATCH below instead.
songRoutes.post("/:id/edit-requests", requireAuth, async (c) => {
  const user = c.get("user")!;
  const song = await getSong(c.req.param("id")!);
  if (!song || !canSee(song, user)) return c.json({ error: "not_found" }, 404);

  const body = await c.req
    .json<{ title?: string; artist?: string; album?: string; explicit?: boolean }>()
    .catch(() => ({}) as Record<string, never>);

  const title = body.title?.trim() || null;
  const artist = body.artist?.trim() || null;
  const album = typeof body.album === "string" ? body.album.trim() : null;
  const explicit = typeof body.explicit === "boolean" ? body.explicit : null;
  if (!title && !artist && album === null && explicit === null) {
    return c.json({ error: "nothing_to_change" }, 400);
  }

  await sql`
    INSERT INTO song_edit_requests
      (song_id, requested_by, title, artist, album, explicit)
    VALUES (${song.id}, ${user.id}, ${title}, ${artist}, ${album}, ${explicit})
    ON CONFLICT (song_id) WHERE status = 'pending' DO UPDATE
      SET title = EXCLUDED.title, artist = EXCLUDED.artist,
          album = EXCLUDED.album, explicit = EXCLUDED.explicit,
          requested_by = EXCLUDED.requested_by, created_at = now()
  `;
  return c.json({ ok: true }, 201);
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
  return c.json(toPublicSong(rows[0]!, await getPrimaryArtistId(song.id)));
});

// The uploader may delete their own upload; an admin may delete any song.
songRoutes.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const song = await getSong(c.req.param("id")!);
  if (!song) return c.json({ error: "not_found" }, 404);
  if (song.uploaded_by !== user.id && !isAdmin(user)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await sql`DELETE FROM songs WHERE id = ${song.id}`;
  await unlink(resolveMedia(song.file_path)).catch(() => {});
  if (song.stream_path) {
    await unlink(resolveMedia(song.stream_path)).catch(() => {});
  }
  if (song.cover_path) {
    await unlink(resolveMedia(song.cover_path)).catch(() => {});
  }
  return c.json({ ok: true });
});

// --- helpers --------------------------------------------------------------

export async function getSong(id: string): Promise<Song | undefined> {
  // A malformed (non-uuid) id would make Postgres throw; treat as "not found".
  try {
    const rows = await sql<Song[]>`SELECT * FROM songs WHERE id = ${id}`;
    return rows[0];
  } catch {
    return undefined;
  }
}

// Who may see a given song: anyone for approved songs; the uploader or an
// admin for pending/rejected ones.
export function canSee(song: Song, user: User | null): boolean {
  if (song.status === "approved") return true;
  if (!user) return false;
  return song.uploaded_by === user.id || isAdmin(user);
}

// Pick the bytes to stream: the Opus transcode when present (smaller — better
// on mobile), else the master; fall back to the master if the Opus vanished.
async function resolvePlayable(
  song: Song,
  preferMaster: boolean,
): Promise<{ servePath: string; absPath: string; mime: string } | null> {
  let servePath = preferMaster ? song.file_path : song.stream_path ?? song.file_path;
  let absPath = resolveMedia(servePath);
  let info = await stat(absPath).catch(() => null);
  if (!info && servePath !== song.file_path) {
    servePath = song.file_path;
    absPath = resolveMedia(servePath);
    info = await stat(absPath).catch(() => null);
  }
  if (!info) return null;

  const extMime = mimeForAudioPath(servePath);
  const mime =
    extMime !== "application/octet-stream"
      ? extMime
      : song.mime && song.mime.startsWith("audio/")
        ? song.mime
        : extMime;
  return { servePath, absPath, mime };
}

export async function serveSongStream(
  rangeHeader: string | undefined,
  song: Song,
): Promise<Response> {
  const t = await resolvePlayable(song, false);
  if (!t) return new Response("file_missing", { status: 404 });
  return serveAudioFile(rangeHeader, {
    absPath: t.absPath,
    servePath: t.servePath,
    mime: t.mime,
  });
}

export async function serveSongDownload(
  rangeHeader: string | undefined,
  song: Song,
): Promise<Response> {
  const t = await resolvePlayable(song, true); // always the original master
  if (!t) return new Response("file_missing", { status: 404 });
  const ext = t.servePath.slice(t.servePath.lastIndexOf(".")) || "";
  const safe = (s: string) => s.replace(/[\/\\:*?"<>|]+/g, " ").trim();
  return serveAudioFile(rangeHeader, {
    absPath: t.absPath,
    servePath: t.servePath,
    mime: t.mime,
    attachmentName: `${safe(song.artist)} - ${safe(song.title)}${ext}`,
  });
}

function toPublicEditRequest(
  r: SongEditRequest & {
    cur_title: string;
    cur_artist: string;
    cur_album: string | null;
    cur_explicit: boolean;
    requested_by_name: string | null;
  },
) {
  return {
    id: r.id,
    songId: r.song_id,
    current: {
      title: r.cur_title,
      artist: r.cur_artist,
      album: r.cur_album,
      explicit: r.cur_explicit,
    },
    proposed: {
      title: r.title,
      artist: r.artist,
      album: r.album,
      explicit: r.explicit,
    },
    requestedByName: r.requested_by_name,
    status: r.status,
    createdAt: r.created_at,
  };
}

// A song can be linked to several artists (song_artists is many-to-many);
// "primary" role wins when present, otherwise whichever link comes first.
async function getPrimaryArtistId(songId: string): Promise<string | null> {
  const rows = await sql<Array<{ artist_id: string }>>`
    SELECT artist_id FROM song_artists WHERE song_id = ${songId}
    ORDER BY (role = 'primary') DESC, role
    LIMIT 1
  `;
  return rows[0]?.artist_id ?? null;
}

function str(v: FormDataEntryValue | null): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Shape sent to the client (never expose absolute filesystem paths).
function toPublicSong(s: Song, artistId: string | null = null) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    artistId,
    album: s.album,
    durationS: s.duration_s,
    explicit: s.explicit,
    hasCover: Boolean(s.cover_path),
    coverUrl: s.cover_path ? `/api/songs/${s.id}/cover` : null,
    streamUrl: `/api/songs/${s.id}/stream`,
    downloadUrl: `/song/${s.id}?download=1`,
    uploadedBy: s.uploaded_by,
    status: s.status,
    createdAt: s.created_at,
  };
}