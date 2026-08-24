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

The Linux build (AppImage) does **not** bundle WebKitGTK or the GTK stack
around it — you need `webkit2gtk-4.1` (Arch/Fedora package name;
Debian/Ubuntu: `libwebkit2gtk-4.1-0`) installed system-wide for the app to
launch. Everything else it now takes from your system (GTK 3, GLib, libsoup3,
GStreamer) is a hard dependency of that one package, so installing it is the
whole requirement.

This is deliberate, not an oversight: an AppImage-bundled WebKitGTK build has
been observed to hard-crash at startup (`Could not create default EGL display:
EGL_BAD_PARAMETER`) on at least one real Wayland compositor + modern Mesa
combination that the same machine's system-installed WebKitGTK handles fine —
GPU/Wayland-coupled libraries like this are fragile to bundle across distros,
which is exactly why every other WebKitGTK-based Linux package (`.deb`/`.rpm`)
declares it as a runtime dependency instead of shipping its own copy. This app
does the same.

The unbundling has to be all-or-nothing. WebKitGTK, JavaScriptCore, GStreamer
and GLib are one version-coupled graph: an earlier build shipped the rest of
the graph while dropping only `libwebkit2gtk`, which made your system's
WebKitGTK load against the AppImage's older JavaScriptCore and die instantly
with `undefined symbol: _ZN3WTF20base64EncodeToString...`. The release
workflow therefore strips *every* bundled library except the app's own Discord
SDK — see the "unbundle the GTK/WebKitGTK stack" step in
`.github/workflows/release.yml`.

```bash
# Arch / Manjaro
sudo pacman -S webkit2gtk-4.1

# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-0

# Fedora
sudo dnf install webkit2gtk4.1
```

### Arch: install from the AUR

Arch users can skip the AppImage entirely — `doughmination-music`
repackages it as a normal system package (`/usr/bin/doughmination-music`, a
desktop entry, and hicolor icons), so `webkit2gtk-4.1` and the rest arrive as
pacman dependencies:

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
