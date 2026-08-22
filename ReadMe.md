<p align="center">
  <img src="apps/server/public/favicon.png" alt="Doughmination Music" width="140" />
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
- Duplicate detection to keep the library tidy
- Lyrics lookup
- Last.fm scrobbling
- Discord Rich Presence (desktop) showing what you're playing
- OS media controls / lock-screen widget (media keys, Now Playing)
- One codebase, three targets: **web**, **desktop** (Windows/macOS/Linux), and **Android**

## Tech stack

| Area        | Tooling                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| Runtime     | [Bun](https://bun.sh)                                                    |
| Backend     | [Hono](https://hono.dev) · PostgreSQL · Redis · `jose` (OIDC/JWT)        |
| Web app     | Vanilla TypeScript (no framework), bundled by Bun · Bootstrap Icons      |
| Desktop/Android | [Tauri 2](https://tauri.app) (Rust) · deep-link + opener plugins · Discord Social SDK |
| Auth        | Pocket ID (OIDC) — session cookie for web, bearer token for native apps  |
| Media       | FFmpeg (Opus transcode) · optional nginx `X-Accel-Redirect` offload      |
| Tooling     | Bun workspaces monorepo · Docker / Compose                              |

## Project structure

```
apps/
  server/    Hono API — auth, streaming, uploads; also serves the web app
  web/       Vanilla-TS single-page frontend
  desktop/   Tauri shell (desktop + Android), Rust side owns Discord presence
packages/
  shared/    Typed API client + shared types
  player/    Framework-agnostic <audio> controller (queue, shuffle, visualiser)
```

## Getting started

**Prerequisites:** [Bun](https://bun.sh), PostgreSQL, and Redis. (For the desktop/
Android apps you'll also need the Rust toolchain and the Android SDK/NDK.)

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

## Building the apps

```bash
# Web (production bundle)
bun run build

# Desktop dev / release
bun run desktop:dev
bun run desktop:build

# Android
bun run android:init      # first time only
bun run android:dev
bun run android:build     # produces an APK
```

### Linux runtime requirement

The Linux build (AppImage) does **not** bundle WebKitGTK — you need
`webkit2gtk-4.1` (Arch/Fedora package name; Debian/Ubuntu: `libwebkit2gtk-4.1-0`)
installed system-wide for the app to launch. This is deliberate, not an
oversight: an AppImage-bundled WebKitGTK build has been observed to hard-crash
at startup (`Could not create default EGL display: EGL_BAD_PARAMETER`) on at
least one real Wayland compositor + modern Mesa combination that the same
machine's system-installed WebKitGTK handles fine — GPU/Wayland-coupled
libraries like this are fragile to bundle across distros, which is exactly why
every other WebKitGTK-based Linux package (`.deb`/`.rpm`) declares it as a
runtime dependency instead of shipping its own copy. This app does the same.

```bash
# Arch / Manjaro
sudo pacman -S webkit2gtk-4.1

# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-0

# Fedora
sudo dnf install webkit2gtk4.1
```

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
