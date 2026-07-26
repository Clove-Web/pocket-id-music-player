import postgres from "postgres";

import { config } from "../config.ts";

// Single shared connection pool for the whole app.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {}, // silence NOTICE spam
});

// Row types mirror the schema in schema.sql.

export type User = {
  id: string;
  oidc_sub: string;
  email: string | null;
  name: string | null;
  username: string | null;
  avatar_url: string | null;
  lastfm_session_key: string | null;
  lastfm_username: string | null;
  created_at: Date;
};

export type Song = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  cover_path: string | null;
  file_path: string;
  mime: string | null;
  duration_s: number | null;
  size_bytes: string; // bigint comes back as string
  explicit: boolean;
  normalized_title: string | null;
  uploaded_by: string | null;
  created_at: Date;
};

export type Playlist = {
  id: string;
  user_id: string;
  name: string;
  is_public: boolean;
  cover_path: string | null;
  created_at: Date;
};

export type Artist = {
  id: string;
  name: string;
  normalized_name: string;
  bio: string | null;
  avatar_path: string | null;
  created_by: string | null;
  created_at: Date;
};

export type SongArtist = {
  song_id: string;
  artist_id: string;
  role: string;
};

export type ArtistLinkRequest = {
  id: string;
  song_id: string;
  artist_id: string;
  role: string;
  requested_by: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

export type SongSnapshot = {
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
};

export type SongDuplicateReview = {
  id: string;
  new_song_id: string | null;
  existing_song_id: string | null;
  new_snapshot: SongSnapshot;
  existing_snapshot: SongSnapshot;
  score: number;
  reasons: string[];
  status: "pending" | "duplicate" | "different";
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};