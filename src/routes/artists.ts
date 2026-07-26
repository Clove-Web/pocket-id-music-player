// Artist pages. Any signed-in user can create a brand new page and request
// that a song be linked to it; both editing an existing page and deciding
// link requests are admin-only. Search doubles as the "avoid creating a
// near-duplicate" check the UI runs before letting someone create a page or
// link a song. See schema.sql for the full rationale.

import { Hono } from "hono";
import { stat, unlink } from "node:fs/promises";

import {
  sql,
  type Artist,
  type ArtistLinkRequest,
  type Song,
  type SongArtist,
} from "../db/index.ts";
import {
  requireAuth,
  isAdmin,
  type AppEnv,
} from "../auth/middleware.ts";
import { normalizeArtistName, diceCoefficient } from "../lib/text.ts";
import { ensureMediaDirs, resolveMedia, saveCover } from "../lib/media.ts";

export const artistRoutes = new Hono<AppEnv>();

artistRoutes.use("*", requireAuth);

// --- search / browse -------------------------------------------------------
// Used both for the "Artists" browse page and for the "link song to artist"
// search-before-create flow, so near-duplicate spellings ("bbno" vs "bbno$")
// still surface even without an exact substring match.
artistRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();

  // Personal-scale library: scoring every artist in-process is simpler and
  // more accurate than a DB-side fuzzy prefilter (same tradeoff as
  // lib/duplicates.ts). Revisit if the artist count grows very large.
  const rows = await sql<Array<Artist & { song_count: string }>>`
    SELECT a.*,
      (SELECT count(*) FROM song_artists sa WHERE sa.artist_id = a.id) AS song_count
    FROM artists a
  `;

  let results: Array<Artist & { song_count: string }>;
  if (q) {
    const normQ = normalizeArtistName(q);
    results = rows
      .map((a) => ({
        artist: a,
        score: a.normalized_name.includes(normQ)
          ? 1
          : diceCoefficient(normQ, a.normalized_name),
      }))
      .filter((r) => r.score >= 0.35)
      .sort((x, y) => y.score - x.score)
      .map((r) => r.artist);
  } else {
    results = [...rows].sort((x, y) => x.name.localeCompare(y.name));
  }

  return c.json(results.slice(0, 50).map(toPublicArtist));
});

// Pending link requests, for the admin queue. Declared before "/:id" so
// "link-requests" isn't captured as an artist id.
artistRoutes.get("/link-requests", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const status = c.req.query("status") ?? "pending";

  const rows = await sql<
    Array<
      ArtistLinkRequest & {
        song_title: string;
        song_artist: string;
        artist_name: string;
        requested_by_name: string | null;
      }
    >
  >`
    SELECT
      r.*,
      s.title  AS song_title,
      s.artist AS song_artist,
      a.name   AS artist_name,
      u.name   AS requested_by_name
    FROM artist_link_requests r
    JOIN songs s       ON s.id = r.song_id
    JOIN artists a     ON a.id = r.artist_id
    LEFT JOIN users u  ON u.id = r.requested_by
    WHERE r.status = ${status}
    ORDER BY r.created_at ASC
  `;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      songId: r.song_id,
      songTitle: r.song_title,
      songArtist: r.song_artist,
      artistId: r.artist_id,
      artistName: r.artist_name,
      role: r.role,
      requestedByName: r.requested_by_name,
      status: r.status,
      createdAt: r.created_at,
    })),
  );
});

// Merge a near-duplicate artist page into the canonical one. Admin-only
// cleanup for pages that slipped past the search-before-create check.
artistRoutes.post("/merge", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req
    .json<{ sourceId?: string; targetId?: string }>()
    .catch(() => ({}) as { sourceId?: string; targetId?: string });
  const { sourceId, targetId } = body;
  if (!sourceId || !targetId || sourceId === targetId) {
    return c.json({ error: "sourceId_and_targetId_required" }, 400);
  }

  const [source, target] = await Promise.all([
    sql<Artist[]>`SELECT * FROM artists WHERE id = ${sourceId}`,
    sql<Artist[]>`SELECT * FROM artists WHERE id = ${targetId}`,
  ]);
  if (!source[0] || !target[0]) return c.json({ error: "not_found" }, 404);

  await sql.begin(async (tx) => {
    // song_artists' PK is (song_id, artist_id): drop source rows that would
    // collide with a link the target already has, then reassign the rest.
    await tx`
      DELETE FROM song_artists
      WHERE artist_id = ${sourceId}
        AND song_id IN (SELECT song_id FROM song_artists WHERE artist_id = ${targetId})
    `;
    await tx`
      UPDATE song_artists SET artist_id = ${targetId} WHERE artist_id = ${sourceId}
    `;

    // Same idea for still-pending link requests.
    await tx`
      DELETE FROM artist_link_requests
      WHERE artist_id = ${sourceId} AND status = 'pending'
        AND song_id IN (
          SELECT song_id FROM artist_link_requests
          WHERE artist_id = ${targetId} AND status = 'pending'
        )
    `;
    await tx`
      UPDATE artist_link_requests SET artist_id = ${targetId} WHERE artist_id = ${sourceId}
    `;

    await tx`DELETE FROM artists WHERE id = ${sourceId}`;
  });

  return c.json(toPublicArtist({ ...target[0]!, song_count: String(await songCount(targetId)) }));
});

// Artist page + its linked songs.
artistRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")!;
  const artist = (
    await sql<Artist[]>`SELECT * FROM artists WHERE id = ${id}`
  )[0];
  if (!artist) return c.json({ error: "not_found" }, 404);

  const songs = await sql<Array<Song & { role: string }>>`
    SELECT s.*, sa.role
    FROM song_artists sa
    JOIN songs s ON s.id = sa.song_id
    WHERE sa.artist_id = ${id}
    ORDER BY s.created_at DESC
  `;

  return c.json({
    ...toPublicArtist({ ...artist, song_count: String(songs.length) }),
    songs: songs.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      durationS: s.duration_s,
      explicit: s.explicit,
      coverUrl: s.cover_path ? `/api/songs/${s.id}/cover` : null,
      streamUrl: `/api/songs/${s.id}/stream`,
      role: s.role,
    })),
  });
});

artistRoutes.get("/:id/avatar", async (c) => {
  const artist = (
    await sql<Artist[]>`SELECT * FROM artists WHERE id = ${c.req.param("id")!}`
  )[0];
  if (!artist?.avatar_path) return c.json({ error: "not_found" }, 404);

  const abs = resolveMedia(artist.avatar_path);
  const info = await stat(abs).catch(() => null);
  if (!info) return c.json({ error: "not_found" }, 404);

  return new Response(Bun.file(abs).stream(), {
    headers: {
      "content-type": "image/*",
      "cache-control": "public, max-age=86400",
    },
  });
});

// Admin-only, mirroring the rest of "editing an existing page".
artistRoutes.post("/:id/avatar", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id")!;
  const artist = (await sql<Artist[]>`SELECT * FROM artists WHERE id = ${id}`)[0];
  if (!artist) return c.json({ error: "not_found" }, 404);

  const form = await c.req.formData();
  const file = form.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "avatar_required" }, 400);
  }

  await ensureMediaDirs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.type.split("/")[1] ?? "jpg";
  const avatarPath = await saveCover(bytes, ext);

  const rows = await sql<Artist[]>`
    UPDATE artists SET avatar_path = ${avatarPath} WHERE id = ${id} RETURNING *
  `;
  if (artist.avatar_path) {
    await unlink(resolveMedia(artist.avatar_path)).catch(() => {});
  }
  return c.json(toPublicArtist({ ...rows[0]!, song_count: String(await songCount(id)) }));
});

// Create a brand new artist page. Blocked only on an exact normalised-name
// match (409, with the existing page so the UI can offer "link to this
// instead") — near-duplicate prevention is primarily the caller's job via
// GET / before showing a "create new" option.
artistRoutes.post("/", async (c) => {
  const user = c.get("user")!;
  const body = await c.req
    .json<{ name?: string; bio?: string }>()
    .catch(() => ({}) as { name?: string; bio?: string });

  const name = body.name?.trim();
  if (!name) return c.json({ error: "name_required" }, 400);
  const normalized = normalizeArtistName(name);

  const existing = (
    await sql<Artist[]>`SELECT * FROM artists WHERE normalized_name = ${normalized}`
  )[0];
  if (existing) {
    return c.json(
      {
        error: "artist_exists",
        artist: toPublicArtist({ ...existing, song_count: String(await songCount(existing.id)) }),
      },
      409,
    );
  }

  const bio = body.bio?.trim() || null;
  const rows = await sql<Artist[]>`
    INSERT INTO artists (name, normalized_name, bio, created_by)
    VALUES (${name}, ${normalized}, ${bio}, ${user.id})
    RETURNING *
  `;
  return c.json(toPublicArtist({ ...rows[0]!, song_count: "0" }), 201);
});

// Edit an existing page. Admin-only.
artistRoutes.patch("/:id", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id")!;

  const existing = (
    await sql<Artist[]>`SELECT * FROM artists WHERE id = ${id}`
  )[0];
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await c.req
    .json<{ name?: string; bio?: string }>()
    .catch(() => ({}) as { name?: string; bio?: string });

  const name = body.name?.trim() || existing.name;
  const normalized = normalizeArtistName(name);
  if (normalized !== existing.normalized_name) {
    const conflict = (
      await sql<Artist[]>`
        SELECT * FROM artists WHERE normalized_name = ${normalized} AND id != ${id}
      `
    )[0];
    if (conflict) {
      return c.json(
        {
          error: "artist_exists",
          artist: toPublicArtist({ ...conflict, song_count: String(await songCount(conflict.id)) }),
        },
        409,
      );
    }
  }
  const bio = body.bio !== undefined ? body.bio.trim() || null : existing.bio;

  const rows = await sql<Artist[]>`
    UPDATE artists SET name = ${name}, normalized_name = ${normalized}, bio = ${bio}
    WHERE id = ${id}
    RETURNING *
  `;
  return c.json(toPublicArtist({ ...rows[0]!, song_count: String(await songCount(id)) }));
});

// Request that a song be linked to this artist. Anyone signed in may ask;
// an admin decides (see the approve/reject routes below).
artistRoutes.post("/:id/link-requests", async (c) => {
  const user = c.get("user")!;
  const artistId = c.req.param("id")!;

  const artist = (
    await sql<Artist[]>`SELECT * FROM artists WHERE id = ${artistId}`
  )[0];
  if (!artist) return c.json({ error: "not_found" }, 404);

  const body = await c.req
    .json<{ songId?: string; role?: string }>()
    .catch(() => ({}) as { songId?: string; role?: string });
  const songId = body.songId;
  if (!songId) return c.json({ error: "songId_required" }, 400);
  const role = body.role?.trim() || "primary";

  const song = (await sql<Song[]>`SELECT * FROM songs WHERE id = ${songId}`)[0];
  if (!song) return c.json({ error: "song_not_found" }, 404);

  const alreadyLinked = (
    await sql<SongArtist[]>`
      SELECT * FROM song_artists WHERE song_id = ${songId} AND artist_id = ${artistId}
    `
  )[0];
  if (alreadyLinked) return c.json({ error: "already_linked" }, 409);

  const rows = await sql<ArtistLinkRequest[]>`
    INSERT INTO artist_link_requests (song_id, artist_id, role, requested_by)
    VALUES (${songId}, ${artistId}, ${role}, ${user.id})
    ON CONFLICT (song_id, artist_id) WHERE status = 'pending' DO NOTHING
    RETURNING *
  `;
  if (!rows[0]) return c.json({ error: "already_requested" }, 409);

  return c.json({ ok: true, requestId: rows[0].id }, 201);
});

artistRoutes.post("/link-requests/:id/approve", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const user = c.get("user")!;
  const id = c.req.param("id")!;

  const req = (
    await sql<ArtistLinkRequest[]>`
      SELECT * FROM artist_link_requests WHERE id = ${id} AND status = 'pending'
    `
  )[0];
  if (!req) return c.json({ error: "not_found" }, 404);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO song_artists (song_id, artist_id, role)
      VALUES (${req.song_id}, ${req.artist_id}, ${req.role})
      ON CONFLICT (song_id, artist_id) DO NOTHING
    `;
    await tx`
      UPDATE artist_link_requests
      SET status = 'approved', decided_at = now(), decided_by = ${user.id}
      WHERE id = ${id}
    `;
  });

  return c.json({ ok: true });
});

artistRoutes.post("/link-requests/:id/reject", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const user = c.get("user")!;
  const id = c.req.param("id")!;

  const rows = await sql<ArtistLinkRequest[]>`
    UPDATE artist_link_requests
    SET status = 'rejected', decided_at = now(), decided_by = ${user.id}
    WHERE id = ${id} AND status = 'pending'
    RETURNING *
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// --- helpers -----------------------------------------------------------

async function songCount(artistId: string): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT count(*) FROM song_artists WHERE artist_id = ${artistId}
  `;
  return Number(rows[0]?.count ?? 0);
}

function toPublicArtist(a: Artist & { song_count: string }) {
  return {
    id: a.id,
    name: a.name,
    bio: a.bio,
    avatarUrl: a.avatar_path ? `/api/artists/${a.id}/avatar` : null,
    songCount: Number(a.song_count),
    createdAt: a.created_at,
  };
}