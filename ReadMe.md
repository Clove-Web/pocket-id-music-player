<p align="center">
  <img src="web/server/public/favicon.png" alt="Doughmination Music" width="140" />
</p>

<h1 align="center">Doughmination Music</h1>

A self-hosted music streaming server and player. Upload your library once, then
play it anywhere — in the browser, on the desktop app, or on Android. Sign-in is
handled by [Pocket ID](https://pocket-id.org/) (OIDC), so everyone shares one
account system.

## Features

- Stream your own music library with seek/scrub (HTTP range) and gapless-ish playback
- Playlists, artists, and shared (public) playlists
- Upload tracks straight from the web UI, with automatic Opus transcoding for smaller mobile streams
- Import a track from a YouTube link (server-side `yt-dlp`) — same review flow as an upload
- Duplicate detection to keep the library tidy
- Lyrics lookup
- Last.fm scrobbling
- Discord Rich Presence (desktop) showing what you're playing
- OS media controls / lock-screen widget (media keys, Now Playing)
- One codebase, three targets: **web**, **desktop** (Windows/macOS/Linux), and **Android**
- In-app **Get the app** page (`/downloads`) with the latest per-platform builds, plus back/forward history arrows in the header

## Tech stack

| Area        | Tooling                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| Runtime     | [Bun](https://bun.sh)                                                    |
| Backend     | [Hono](https://hono.dev) · PostgreSQL · Redis · `jose` (OIDC/JWT)        |
| Web app     | Vanilla TypeScript (no framework), bundled by Bun · Bootstrap Icons      |
| Desktop     | [Electron](https://www.electronjs.org/) (TypeScript) · Discord Rich Presence over IPC |
| Android     | Native Kotlin · WebView UI + Media3/ExoPlayer for background playback    |
| Auth        | Pocket ID (OIDC) — session cookie for web, bearer token for native apps  |
| Media       | FFmpeg (Opus transcode) · `yt-dlp` (YouTube import) · optional nginx `X-Accel-Redirect` offload |
| Tooling     | Bun workspaces monorepo · Docker / Compose                              |

## Project structure

```
web/
  server/    Hono API — auth, streaming, uploads; also serves the web client
  client/    Vanilla-TS single-page frontend
  shared/    Typed API client + shared types
  player/    Framework-agnostic <audio> controller (queue, shuffle, visualiser)
apps/
  desktop/   Electron shell (TS main + preload) — deep-link SSO + Discord presence
  android/   Native Kotlin app — WebView UI + Media3 background playback
```

## Getting started

**Prerequisites:** [Bun](https://bun.sh), PostgreSQL, and Redis. `ffmpeg` (Opus
transcode) and `yt-dlp` (YouTube import) are optional — both features degrade
gracefully when the binary is missing, and the Docker image bundles both. The
desktop app needs only Bun (Electron installs as a dev dependency); the Android
app needs JDK 17 and the Android SDK.

```bash
# 1. Install dependencies
bun install

# 2. Configure — copy the example and fill in the blanks
cp .env.example .env

# 3. Run the database migrations
bun run migrate

# 4. Start the API + web app together (hot reload)
bun run dev
```

The app is then served at the URL in `MUSIC_APP_URL` (default `http://localhost:4060`).

### Configuration

All config comes from environment variables — see `.env.example` for the full
list. The essentials:

| Variable                | What it's for                                  |
| ----------------------- | ---------------------------------------------- |
| `MUSIC_APP_URL`         | Public URL the app is served from              |
| `MUSIC_DATABASE_URL`    | PostgreSQL connection string                   |
| `MUSIC_REDIS_URL`       | Redis connection string                        |
| `MUSIC_OIDC_ISSUER`     | Your Pocket ID instance                        |
| `MUSIC_OIDC_CLIENT_ID` / `MUSIC_OIDC_CLIENT_SECRET` | The music app's OIDC client |
| `MUSIC_ADMINS`          | Comma-separated user IDs granted admin         |
| `MUSIC_MEDIA_DIR`       | Where uploaded audio is stored                 |
| `MUSIC_LASTFM_API_KEY` / `MUSIC_LASTFM_SHARED_SECRET` | Optional Last.fm scrobbling |
| `MUSIC_YTDLP_ENABLED` / `MUSIC_YTDLP_BIN` / `MUSIC_YTDLP_TIMEOUT_MS` | YouTube import: on/off, binary name, per-download wall-clock cap |

## Building the apps

```bash
# Web (production bundle)
bun run build

# Desktop (Electron) — dev run / packaged build
bun run desktop:dev
bun run desktop:build     # writes apps/desktop/release/

# Android — native Kotlin app, built with Gradle
cd apps/android && gradle assembleRelease
```

The desktop app is a thin shell: it loads the live site (default
`https://doughmination.me`, overridable via `DMND_SERVER_URL` or **File → Set
Server URL…**) and adds `doughmination://` deep-link sign-in plus Discord Rich
Presence over the local Discord IPC socket.

### Arch: install from the AUR

Arch users can skip the AppImage — `doughmination-music` repackages it as a
normal system package (`/usr/bin/doughmination-music`, a desktop entry, and
hicolor icons). Electron bundles its own Chromium, so the only dependencies are
the system libraries Chromium loads at runtime (`gtk3`, `nss`, `alsa-lib`, …),
pulled in automatically by pacman:

```bash
paru -S doughmination-music   # or: yay -S doughmination-music
```

The PKGBUILD lives at [`packaging/aur/PKGBUILD`](packaging/aur/PKGBUILD) and is
the source of truth — the release workflow's `aur` job rewrites its `pkgver`,
fills the checksums, test-builds it and pushes it to the AUR after each
release, so edits made directly in the AUR repo get overwritten. Publishing
requires an `AUR_SSH_PRIVATE_KEY` repository secret (the private half of an SSH
key registered on the maintainer's AUR account); without it the job logs a
notice and skips, and the rest of the release proceeds normally.

## Deployment

A production image is published as `doughmination/doughmination-music` and can be
run with the included `compose.yml`:

```bash
docker compose up -d
```

It expects `.env` (and `.env.keys` for encrypted secrets) mounted alongside a
`./data` volume for the media library.

## Contributing

See [contributing.md](contributing.md) and the [code of conduct](code_of_conduct.md).
Security issues: please follow [security.md](security.md).

## Licence

Released under the **Doughmination Authorised Source Licence (DASL-1.0)** — see
[LICENCE.md](LICENCE.md).
