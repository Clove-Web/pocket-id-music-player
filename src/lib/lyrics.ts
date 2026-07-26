// Lyrics via LRCLIB (same provider /personal uses), fetched server-side and
// cached in Redis. The library is shared, so one lookup per song serves all
// users. Falls back across mirror hosts; get-by-duration first, then search.

import { redis } from "../redis.ts";

const HOSTS = [
  "https://lrclib.net",
  "https://lrclib.schuh.wtf",
  "https://lyrics.lanyard.cafe",
  "https://lyrics.kie.ac",
  "https://lyrics.aureal.dev",
];

const UA = "doughmination-music (https://doughmination.me)";
const CACHE_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

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
  const cacheKey = `music:lyrics:${song.id}`;

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as LyricsResult;
    } catch {
      /* fall through to refetch */
    }
  }

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
  await redis
    .set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SEC)
    .catch(() => {});
  return result;
}
