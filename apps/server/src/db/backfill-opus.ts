// One-off backfill: transcode existing lossless masters to Ogg-Opus and set
// songs.stream_path, so tracks uploaded before Opus streaming existed get the
// smaller mobile stream too. Safe to re-run — it only touches rows that don't
// have a stream_path yet, and skips masters that aren't lossless.
//
// Run it once after deploying (ffmpeg must be on PATH):
//   bun run --filter @musicapp/server backfill:opus
// or from apps/server:
//   bun run src/db/backfill-opus.ts

import { sql, type Song } from "./index.ts";
import { isLosslessMaster, transcodeToOpus } from "../lib/media.ts";

const songs = await sql<Song[]>`
  SELECT * FROM songs WHERE stream_path IS NULL ORDER BY created_at ASC
`;

const targets = songs.filter((s) => isLosslessMaster(s.file_path));
console.log(
  `${songs.length} songs without a stream copy; ${targets.length} are lossless masters to transcode.`,
);

let done = 0;
let failed = 0;

for (const song of targets) {
  const label = `${song.artist} — ${song.title}`;
  process.stdout.write(`[${done + failed + 1}/${targets.length}] ${label} … `);

  const streamPath = await transcodeToOpus(song.file_path).catch(() => null);
  if (!streamPath) {
    failed++;
    console.log("skipped (transcode failed)");
    continue;
  }

  await sql`UPDATE songs SET stream_path = ${streamPath} WHERE id = ${song.id}`;
  done++;
  console.log("done");
}

console.log(`\nBackfill complete: ${done} transcoded, ${failed} failed.`);
await sql.end();
