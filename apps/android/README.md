# Doughmination Music — native Android app

A standalone native Android app that replaces the Tauri Android APK. It hosts
the existing web player in a WebView but plays audio through a native
**Media3 / ExoPlayer** foreground service, so playback keeps going when the app
is backgrounded or the screen is locked, and shows a real **now-playing
notification** with cover art and play / pause / next / previous controls.

## Why this exists

The Tauri APK ran the whole player inside a bare WebView. A bare Android WebView
does **not** surface the web `navigator.mediaSession` API to the OS, so Android
never saw an active media session — no notification, no lock-screen controls,
and it suspended the WebView's audio the moment the app lost focus. That's why
audio "kept playing" in the UI but produced no sound once backgrounded/locked.

The fix is to let a native media service own the audio. See `BRIDGE.md` for the
web ⇄ native contract.

## Architecture

```
┌─────────────────────────── MainActivity ───────────────────────────┐
│  WebView  (doughmination.me — the existing UI, queue, shuffle…)      │
│     │  window.DmndNative.setTrack/play/pause/seek/setVolume          │
│     ▼                                                                │
│  WebBridge ──► MediaController ──► PlaybackService (foreground)      │
│                                     └─ ExoPlayer (+ cookie data src) │
│     ▲                                     │                          │
│     └── window.__dmndNative.onPlay/onPosition/onEnded/onTransport ───┘
```

* **WebView** keeps owning the library, queue, shuffle/repeat and all UI.
* **`web/player`** detects the native host and swaps its `<audio>` element
  for a native-backed shim (`native-audio.ts`) — the Player logic is unchanged.
* **`PlaybackService`** is a Media3 `MediaSessionService`; Media3 builds the
  media notification/lock-screen controls for us.
* **`CookieDataSourceFactory`** injects the WebView's session cookie into
  ExoPlayer's requests, so auth-gated streams and cover art load.
* **`QueuePlayer`** forwards notification next/prev back to the web queue,
  since native only holds the single current track.

## Requirements to actually work end-to-end

1. **The site must be redeployed with the web-side changes** in this repo
   (`web/player/src/native-audio.ts`, `web/client/src/native.ts`, and the
   Player/app wiring). The APK loads the live site, so until those ship, the
   native bridge is dormant and audio falls back to the (suspended) WebView.
2. Sign-in happens **inside the WebView** (normal web OIDC flow); the resulting
   session cookie is what native reuses for streams/artwork.

## Build

Requires JDK 17 and the Android SDK (platform 35, build-tools 35).

```bash
cd apps/android

# Debug build (unsigned, installs as uk.doughmination.music.debug):
gradle assembleDebug

# Release build. Point it at a different site if needed:
gradle assembleRelease -PsiteUrl=https://doughmination.me
```

Opening `apps/android/` in Android Studio also works and will generate the
Gradle wrapper for you.

### Signing

Release signing reads `apps/android/keystore.properties` (git-ignored):

```properties
keyAlias=your-alias
password=your-key-and-store-password
storeFile=/absolute/path/to/keystore.jks
```

If that file is absent, `assembleRelease` falls back to the debug key so the
build still succeeds locally.

## CI

The `android` job in `.github/workflows/release.yml` builds and signs this APK
and attaches it to the same GitHub Release as the desktop (Electron) builds,
using the `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` / `ANDROID_KEY_BASE64`
secrets.

## Notes / limitations

* App id is `uk.doughmination.music` (the desktop build is
  `uk.doughmination.music.desktop`), so this installs **alongside** the desktop
  app rather than upgrading it.
* The audio visualizer (Web Audio) is disabled on Android — native owns the
  audio pipeline, which Web Audio can't tap.
* Not yet compiled on-device here; expect a round or two of on-device iteration.
