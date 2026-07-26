-- Idempotent schema. Safe to run repeatedly (used by migrate.ts).
-- gen_random_uuid() is built into Postgres 13+ core, so no extension is
-- needed and the app's DB role requires no superuser rights.

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_sub    text UNIQUE NOT NULL,
  email       text,
  name        text,
  username    text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Added after initial release; safe on existing databases.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
-- Last.fm "Connect account" handshake result (see routes/lastfm.ts). The
-- session key is a long-lived credential from auth.getSession, not a
-- password — revocable from either side (user disconnects here, or revokes
-- the app from their Last.fm account settings).
ALTER TABLE users ADD COLUMN IF NOT EXISTS lastfm_session_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lastfm_username text;

CREATE TABLE IF NOT EXISTS songs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  artist      text NOT NULL,
  album       text,
  cover_path  text,
  file_path   text NOT NULL,
  mime        text,
  duration_s  int,
  size_bytes  bigint,
  explicit    boolean NOT NULL DEFAULT false,
  uploaded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Added after initial release; safe on existing databases.
ALTER TABLE songs ADD COLUMN IF NOT EXISTS explicit boolean NOT NULL DEFAULT false;

-- Used by duplicate detection (src/lib/duplicates.ts). New rows get a
-- properly normalised value from the app; this backfill is a coarser
-- approximation for rows that predate the column, just so nothing is NULL.
ALTER TABLE songs ADD COLUMN IF NOT EXISTS normalized_title text;
UPDATE songs
  SET normalized_title = trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))
  WHERE normalized_title IS NULL;

CREATE INDEX IF NOT EXISTS songs_title_idx  ON songs (lower(title));
CREATE INDEX IF NOT EXISTS songs_artist_idx ON songs (lower(artist));
CREATE INDEX IF NOT EXISTS songs_normalized_title_idx ON songs (normalized_title);

CREATE TABLE IF NOT EXISTS playlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Added after initial release; safe on existing databases.
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS cover_path text;

CREATE INDEX IF NOT EXISTS playlists_user_idx   ON playlists (user_id);
CREATE INDEX IF NOT EXISTS playlists_public_idx ON playlists (is_public) WHERE is_public;

CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id uuid NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  song_id     uuid NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
  position    int  NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, song_id)
);

-- --- Artists -----------------------------------------------------------
--
-- Any signed-in user may create a brand new artist page (there's nothing to
-- conflict with yet). Editing an existing page, and merging duplicates that
-- slip through, is admin-only (see routes/artists.ts). Linking a song to an
-- artist is a *request* that an admin approves, mirroring the duplicate
-- review flow below.

CREATE TABLE IF NOT EXISTS artists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  normalized_name text NOT NULL,
  bio             text,
  avatar_path     text,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Added after initial release; safe on existing databases (same gap that
-- bit playlists.cover_path above — CREATE TABLE IF NOT EXISTS is a no-op
-- once the table already exists, so this needs its own ALTER).
ALTER TABLE artists ADD COLUMN IF NOT EXISTS avatar_path text;

-- Hard safety net against exact-duplicate artist pages. Near-duplicates
-- (different spellings that normalise differently) aren't caught here —
-- that's what search-before-create in the UI and admin merge are for.
CREATE UNIQUE INDEX IF NOT EXISTS artists_normalized_name_uniq
  ON artists (normalized_name);

CREATE TABLE IF NOT EXISTS song_artists (
  song_id   uuid NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artists (id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'primary',
  PRIMARY KEY (song_id, artist_id)
);

CREATE INDEX IF NOT EXISTS song_artists_artist_idx ON song_artists (artist_id);

CREATE TABLE IF NOT EXISTS artist_link_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id      uuid NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
  artist_id    uuid NOT NULL REFERENCES artists (id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'primary',
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS artist_link_requests_status_idx
  ON artist_link_requests (status);

-- Only one open request per (song, artist) pair at a time; once decided the
-- requester (or someone else) can request again if needed.
CREATE UNIQUE INDEX IF NOT EXISTS artist_link_requests_pending_uniq
  ON artist_link_requests (song_id, artist_id) WHERE status = 'pending';

-- --- Duplicate song review ----------------------------------------------
--
-- Populated by src/lib/duplicates.ts after every upload. Never merges or
-- deletes automatically — an admin marks each candidate pair as either a
-- real duplicate (the new upload is removed, the existing song stays) or
-- different (both stay, and the pair is remembered so it isn't re-flagged).
--
-- Snapshots preserve enough of each song's metadata to review the pair even
-- after one side is deleted, since the FK is ON DELETE SET NULL rather than
-- CASCADE (deleting a song shouldn't erase the decision history).

CREATE TABLE IF NOT EXISTS song_duplicate_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  new_song_id       uuid REFERENCES songs (id) ON DELETE SET NULL,
  existing_song_id  uuid REFERENCES songs (id) ON DELETE SET NULL,
  new_snapshot      jsonb NOT NULL,
  existing_snapshot jsonb NOT NULL,
  score             int NOT NULL,
  reasons           jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'pending', -- pending | duplicate | different
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  decided_by        uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS song_duplicate_reviews_status_idx
  ON song_duplicate_reviews (status);

CREATE UNIQUE INDEX IF NOT EXISTS song_duplicate_reviews_pair_uniq
  ON song_duplicate_reviews (new_song_id, existing_song_id)
  WHERE new_song_id IS NOT NULL AND existing_song_id IS NOT NULL;