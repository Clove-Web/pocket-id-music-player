// Duplicate song detection. Runs after a song is inserted; never merges or
// deletes anything itself — it only files candidates into
// song_duplicate_reviews for an admin to decide on (see routes/duplicates.ts).
//
// Scoring is a simple weighted sum of independent signals. Not implemented
// yet, but the shape leaves room for stronger signals later (ISRC match,
// audio fingerprinting / Chromaprint) by adding another weight + reason.

import { sql, type Song } from "../db/index.ts";
import { config } from "../config.ts";
import {
  titleSimilarity,
  artistsOverlap,
  normalizeTitle,
} from "./text.ts";

const WEIGHTS = {
  titleExact: 50,
  titleClose: 30,
  artistOverlap: 25,
  durationMatch: 15,
  albumMatch: 10,
};

const CLOSE_TITLE_SIMILARITY = 0.85;

export async function findAndFlagDuplicates(newSong: Song): Promise<void> {
  // Small/medium personal libraries: scoring every existing song in-process
  // is simpler and more accurate than a fuzzy DB-side prefilter, and avoids
  // requiring a Postgres extension (see the note on gen_random_uuid() in
  // schema.sql for why this codebase avoids those). Revisit with a real
  // prefilter if the library grows into the tens of thousands of songs.
  const rows = await sql<Song[]>`
    SELECT * FROM songs WHERE id != ${newSong.id}
  `;

  for (const existing of rows) {
    const { score, reasons } = scorePair(newSong, existing);
    if (score < config.duplicateReviewThreshold) continue;

    await sql`
      INSERT INTO song_duplicate_reviews
        (new_song_id, existing_song_id, new_snapshot, existing_snapshot, score, reasons)
      VALUES (
        ${newSong.id}, ${existing.id},
        ${sql.json(snapshot(newSong))}, ${sql.json(snapshot(existing))},
        ${score}, ${sql.json(reasons)}
      )
      ON CONFLICT (new_song_id, existing_song_id) DO NOTHING
    `;
  }
}

function scorePair(
  a: Song,
  b: Song,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const sim = titleSimilarity(a.title, b.title);
  if (sim === 1) {
    score += WEIGHTS.titleExact;
    reasons.push("Same normalised title");
  } else if (sim >= CLOSE_TITLE_SIMILARITY) {
    score += WEIGHTS.titleClose;
    reasons.push("Very similar title");
  }

  if (artistsOverlap(a.artist, b.artist)) {
    score += WEIGHTS.artistOverlap;
    reasons.push("Shared artist");
  }

  if (a.duration_s != null && b.duration_s != null) {
    const diff = Math.abs(a.duration_s - b.duration_s);
    if (diff <= config.duplicateDurationToleranceS) {
      score += WEIGHTS.durationMatch;
      reasons.push(`Duration within ${config.duplicateDurationToleranceS}s`);
    }
  }

  if (
    a.album &&
    b.album &&
    normalizeTitle(a.album) === normalizeTitle(b.album)
  ) {
    score += WEIGHTS.albumMatch;
    reasons.push("Same album");
  }

  return { score, reasons };
}

function snapshot(s: Song) {
  return {
    title: s.title,
    artist: s.artist,
    album: s.album,
    durationS: s.duration_s,
  };
}