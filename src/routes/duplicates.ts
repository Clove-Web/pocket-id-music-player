// Admin-only review queue for the candidates lib/duplicates.ts files during
// upload. Marking a pair "duplicate" removes the flagged upload and keeps
// the existing canonical song; marking it "different" keeps both and
// remembers the decision so the pair isn't flagged again.

import { Hono } from "hono";
import { unlink } from "node:fs/promises";

import {
  sql,
  type Song,
  type SongDuplicateReview,
  type SongSnapshot,
} from "../db/index.ts";
import {
  requireAuth,
  isAdmin,
  type AppEnv,
} from "../auth/middleware.ts";
import { resolveMedia } from "../lib/media.ts";

export const duplicateRoutes = new Hono<AppEnv>();

duplicateRoutes.use("*", requireAuth);

type ReviewRow = SongDuplicateReview & {
  ns_title: string | null;
  ns_artist: string | null;
  ns_album: string | null;
  ns_duration_s: number | null;
  ns_cover_path: string | null;
  es_title: string | null;
  es_artist: string | null;
  es_album: string | null;
  es_duration_s: number | null;
  es_cover_path: string | null;
};

duplicateRoutes.get("/", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const status = c.req.query("status") ?? "pending";

  // Prefer live song data (so the admin can listen to both before deciding);
  // fall back to the snapshot taken at detection time once a side is gone.
  const rows = await sql<ReviewRow[]>`
    SELECT
      r.*,
      ns.title AS ns_title, ns.artist AS ns_artist, ns.album AS ns_album,
      ns.duration_s AS ns_duration_s, ns.cover_path AS ns_cover_path,
      es.title AS es_title, es.artist AS es_artist, es.album AS es_album,
      es.duration_s AS es_duration_s, es.cover_path AS es_cover_path
    FROM song_duplicate_reviews r
    LEFT JOIN songs ns ON ns.id = r.new_song_id
    LEFT JOIN songs es ON es.id = r.existing_song_id
    WHERE r.status = ${status}
    ORDER BY r.created_at DESC
  `;

  return c.json(rows.map(toPublicReview));
});

// Confirmed duplicate: remove the flagged upload (files + row), keep the
// existing canonical song, and remember the decision.
duplicateRoutes.post("/:id/duplicate", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const user = c.get("user")!;
  const id = c.req.param("id")!;

  const review = (
    await sql<SongDuplicateReview[]>`
      SELECT * FROM song_duplicate_reviews WHERE id = ${id} AND status = 'pending'
    `
  )[0];
  if (!review) return c.json({ error: "not_found" }, 404);

  if (review.new_song_id) {
    const song = (
      await sql<Song[]>`SELECT * FROM songs WHERE id = ${review.new_song_id}`
    )[0];
    if (song) {
      await sql`DELETE FROM songs WHERE id = ${song.id}`;
      await unlink(resolveMedia(song.file_path)).catch(() => {});
      if (song.cover_path) {
        await unlink(resolveMedia(song.cover_path)).catch(() => {});
      }
    }
  }

  await sql`
    UPDATE song_duplicate_reviews
    SET status = 'duplicate', decided_at = now(), decided_by = ${user.id}
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
});

// Not actually a duplicate: keep both songs, remember the decision so this
// pair isn't flagged again.
duplicateRoutes.post("/:id/different", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "forbidden" }, 403);
  const user = c.get("user")!;
  const id = c.req.param("id")!;

  const rows = await sql<SongDuplicateReview[]>`
    UPDATE song_duplicate_reviews
    SET status = 'different', decided_at = now(), decided_by = ${user.id}
    WHERE id = ${id} AND status = 'pending'
    RETURNING *
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// --- helpers -------------------------------------------------------------

function side(
  songId: string | null,
  snapshot: SongSnapshot,
  title: string | null,
  artist: string | null,
  album: string | null,
  durationS: number | null,
  coverPath: string | null,
) {
  if (!songId) {
    return {
      id: null,
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationS: snapshot.durationS,
      coverUrl: null,
      streamUrl: null,
    };
  }
  return {
    id: songId,
    title: title ?? snapshot.title,
    artist: artist ?? snapshot.artist,
    album: album ?? snapshot.album,
    durationS: durationS ?? snapshot.durationS,
    coverUrl: coverPath ? `/api/songs/${songId}/cover` : null,
    streamUrl: `/api/songs/${songId}/stream`,
  };
}

function toPublicReview(r: ReviewRow) {
  return {
    id: r.id,
    score: r.score,
    reasons: r.reasons,
    status: r.status,
    createdAt: r.created_at,
    newSong: side(
      r.new_song_id,
      r.new_snapshot,
      r.ns_title,
      r.ns_artist,
      r.ns_album,
      r.ns_duration_s,
      r.ns_cover_path,
    ),
    existingSong: side(
      r.existing_song_id,
      r.existing_snapshot,
      r.es_title,
      r.es_artist,
      r.es_album,
      r.es_duration_s,
      r.es_cover_path,
    ),
  };
}