// Client-side tag reading so the upload form can auto-fill from the file the
// moment it's picked (same music-metadata lib the server uses). Best-effort:
// on any failure we just return blanks and the user types the fields in.

import { parseBlob } from "music-metadata";

export type FileTags = {
  title?: string;
  artist?: string;
  album?: string;
};

export async function readTags(file: File): Promise<FileTags> {
  try {
    const mm = await parseBlob(file, { duration: false });
    const c = mm.common;
    return { title: c.title, artist: c.artist, album: c.album };
  } catch {
    return {};
  }
}
