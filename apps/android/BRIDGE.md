# Native ⇄ Web bridge contract

The native Android app is a **WebView shell** (UI = the existing web player at
`https://doughmination.me`) plus a **native Media3/ExoPlayer** engine that owns
the actual audio, the foreground service, and the media notification / lock
screen controls.

The web player keeps owning the *library, queue, shuffle/repeat, and UI*. It no
longer produces sound on Android — instead it drives a native audio element
(`NativeAudio`, see `web/player/src/native-audio.ts`) that forwards every
call across this bridge. Native is the single source of truth for playback
position and play/pause state, and reports both back to the web layer.

## Web → Native  (`window.DmndNative`, an injected `@JavascriptInterface`)

All arguments are JS primitives (strings / numbers / booleans) — the only
types that cross an Android JavascriptInterface safely.

| Method | Meaning |
| --- | --- |
| `setTrack(url, metadataJson, autoplay)` | Load a new stream. `metadataJson` = `{"title","artist","album","coverUrl","durationS"}`. If `autoplay` is true, start playing once buffered. |
| `play()` | Resume the current track. |
| `pause()` | Pause. |
| `seek(seconds)` | Seek within the current track (double). |
| `setVolume(v)` | 0.0–1.0. |
| `ready()` | Returns `true` — lets the web layer feature-detect the host synchronously. |

`setTrack` carries the metadata so the notification/lock screen can render the
title, artist and cover **immediately**, without a second round trip. The cover
and stream are fetched by native using the WebView's own session cookie (see
`CookieDataSourceFactory` / `CookieBitmapLoader`), so auth "just works".

## Native → Web  (`window.__dmndNative.*`, called via `evaluateJavascript`)

The web layer installs this object at startup. Native invokes it on the UI
thread. Every method is null-guarded on the native side (`window.__dmndNative && …`).

| Method | Meaning |
| --- | --- |
| `onReady()` | The track is prepared and seekable → web dispatches `loadedmetadata` + `canplay`. |
| `onPosition(positionSec, durationSec)` | Playback clock tick (~2 Hz while playing) → `timeupdate` (+ `durationchange` on change). |
| `onPlay()` | Playback started/resumed → `play`. |
| `onPause()` | Paused → `pause`. |
| `onEnded()` | Track finished → `ended` (web advances the queue). |
| `onError(message)` | Native playback error → surfaced to the web player. |
| `onTransport(cmd)` | A **notification / lock-screen** button was pressed. `cmd` ∈ `"next" \| "prev"`. Web runs `player.next()` / `player.prev()`, which then calls `setTrack` for the new song. |

`play` / `pause` from the notification are handled natively (they act on
ExoPlayer directly) and merely echoed back via `onPlay` / `onPause`, so the web
UI stays in sync. Only `next` / `prev` need routing back to the web queue,
because the native engine only ever holds the *one* current track.

## Why this split

* Background + locked playback is rock-solid: it's a real foreground
  `MediaSessionService`, not a WebView that Android suspends.
* The notification/lock-screen media controls come essentially for free from
  Media3 — the web `navigator.mediaSession` API is **not** surfaced by a bare
  Android WebView, which is why the Tauri build showed no controls.
* The web app stays the single UI/queue implementation across web, desktop and
  Android; only the audio *backend* is swapped.
