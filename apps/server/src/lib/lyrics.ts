// Lyrics via LRCLIB (same provider /personal uses), fetched server-side once
// and then persisted to the database (song_lyrics). The library is shared, so
// one lookup per song serves all users, forever, without re-hitting LRCLIB.
// Falls back across mirror hosts; get-by-duration first, then search.

import { sql } from "../db/index.ts";

const HOSTS = [
  "https://lrclib.net",
  "https://lrclib.schuh.wtf",
  "https://lyrics.lanyard.cafe",
  "https://lyrics.kie.ac",
  "https://lyrics.aureal.dev",
];

const UA = "doughmination-music (https://doughmination.me)";

// A stored *negative* result (provider had nothing) is retried after this long,
// in case the track got added to LRCLIB since. Positive results never expire.
const RETRY_NOT_FOUND_MS = 7 * 24 * 60 * 60 * 1000;

type LyricsRow = {
  song_id: string;
  instrumental: boolean;
  synced: SyncedLine[]; // jsonb -> already parsed by postgres.js
  plain: string | null;
  found: boolean;
  fetched_at: string | Date;
};

export type SyncedLine = { t: number; text: string };

export type LyricsResult = {
  instrumental: boolean;
  synced: SyncedLine[];
  plain: string | null;
};

type LrclibRecord = {
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
};

// [mm:ss.xx] tag parser -> sorted {t(ms), text}[].
function parseLRC(text: string): SyncedLine[] {
  if (!text) return [];
  const out: SyncedLine[] = [];
  const tag = /\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

  for (const line of text.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = tag.exec(line))) {
      const mins = parseInt(m[1]!, 10);
      const secs = parseFloat(m[2]!.replace(":", "."));
      stamps.push((mins * 60 + secs) * 1000);
      last = tag.lastIndex;
    }
    if (!stamps.length) continue;
    const words = line.slice(last).trim();
    for (const t of stamps) out.push({ t, text: words });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

function normalize(rec: LrclibRecord | null): LyricsResult {
  if (!rec) return { instrumental: false, synced: [], plain: null };
  return {
    instrumental: Boolean(rec.instrumental),
    synced: parseLRC(rec.syncedLyrics ?? ""),
    plain: rec.plainLyrics ?? null,
  };
}

async function lrclibGet(
  params: Record<string, string>,
): Promise<LrclibRecord | null> {
  const qs = new URLSearchParams(params).toString();
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/get?${qs}`, {
        headers: { "X-User-Agent": UA },
      });
      if (res.ok) return (await res.json()) as LrclibRecord;
    } catch {
      /* try next mirror */
    }
  }
  return null;
}

async function lrclibSearch(
  trackName: string,
  artistName: string,
): Promise<LrclibRecord | null> {
  const qs = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
  }).toString();

  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/search?${qs}`, {
        headers: { "X-User-Agent": UA },
      });
      if (!res.ok) continue;
      const arr = (await res.json()) as LrclibRecord[];
      if (!Array.isArray(arr) || !arr.length) continue;
      return (
        arr.find((r) => r.syncedLyrics) ??
        arr.find((r) => r.plainLyrics) ??
        arr[0]!
      );
    } catch {
      /* next */
    }
  }
  return null;
}

export async function getLyrics(song: {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
}): Promise<LyricsResult> {
  // Serve from the DB if we've already looked this song up — unless it was a
  // negative result that's now old enough to be worth retrying.
  const rows = await sql<LyricsRow[]>`
    SELECT * FROM song_lyrics WHERE song_id = ${song.id}
  `.catch(() => [] as LyricsRow[]);
  const existing = rows[0];
  if (existing) {
    const age = Date.now() - new Date(existing.fetched_at).getTime();
    const staleMiss = !existing.found && age > RETRY_NOT_FOUND_MS;
    if (!staleMiss) {
      return {
        instrumental: existing.instrumental,
        synced: existing.synced ?? [],
        plain: existing.plain,
      };
    }
  }

  // Miss (or stale negative): fetch from the provider.
  let rec: LrclibRecord | null = null;
  if (song.durationS) {
    rec = await lrclibGet({
      track_name: song.title,
      artist_name: song.artist,
      album_name: song.album ?? "",
      duration: String(song.durationS),
    });
  }
  if (!rec) rec = await lrclibSearch(song.title, song.artist);

  const result = normalize(rec);
  const found = rec !== null;

  // Persist (upsert) so we never look this up again. Best-effort: a DB write
  // failure must not stop us returning the lyrics we just fetched.
  await sql`
    INSERT INTO song_lyrics (song_id, instrumental, synced, plain, found, fetched_at)
    VALUES (
      ${song.id}, ${result.instrumental}, ${sql.json(result.synced)},
      ${result.plain}, ${found}, now()
    )
    ON CONFLICT (song_id) DO UPDATE SET
      instrumental = EXCLUDED.instrumental,
      synced       = EXCLUDED.synced,
      plain        = EXCLUDED.plain,
      found        = EXCLUDED.found,
      fetched_at   = now()
  `.catch((err) => {
    console.error("lyrics persist failed:", err);
  });

  return result;
}
