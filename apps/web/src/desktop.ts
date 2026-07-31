// Everything that's different about running inside the Tauri desktop shell
// vs a plain browser tab, in one place. The web app itself never checks
// `window.__TAURI__` anywhere else — it calls these two functions and
// they no-op in the browser.

import {
  configureApiBase,
  configureAuthToken,
  startNativeLogin,
  completeNativeLogin,
  establishSessionCookie,
  absoluteApiUrl,
  type Song,
} from "@musicapp/shared";

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

const SERVER_URL_KEY = "music:desktop:serverUrl";
const TOKEN_KEY = "music:desktop:token";
const VERIFIER_KEY = "music:desktop:pkceVerifier";
const REDIRECT_URI = "doughmination://auth/callback";

// Tauri v2 does NOT inject `window.__TAURI__` unless `withGlobalTauri` is on,
// but `__TAURI_INTERNALS__` is always present in the webview — that's the
// reliable signal. (Without this, isDesktop was false and the app fell back
// to the plain web login link, navigating the webview straight to SSO.)
export const isDesktop =
  typeof window !== "undefined" &&
  (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);

// True when the frontend is served from Tauri's own bundled content
// (tauri://localhost, or http://tauri.localhost on Windows) rather than from
// a real https origin. Only then is the API cross-origin and a base URL
// needed. When the app loads a remote devUrl (e.g. https://doughmination.me)
// the webview origin already IS the server, so calls are same-origin.
function isLocalBundledOrigin(): boolean {
  if (typeof location === "undefined") return true;
  return location.protocol === "tauri:" || location.hostname === "tauri.localhost";
}

// Call once, before the first api.* call. Web is same-origin and this is a
// no-op there. A remote-loaded desktop webview is *also* same-origin with the
// API, so it skips the prompt too. Only a locally-bundled desktop build needs
// to be told where its self-hosted server lives.
export function initDesktopBridge(): void {
  if (!isDesktop) return;

  if (isLocalBundledOrigin()) {
    let serverUrl = "";
    try {
      serverUrl = localStorage.getItem(SERVER_URL_KEY) ?? "";
    } catch {
      /* ignore */
    }

    if (!serverUrl) {
      serverUrl = window.prompt("Server URL (e.g. https://music.example.com)") ?? "";
      try {
        if (serverUrl) localStorage.setItem(SERVER_URL_KEY, serverUrl);
      } catch {
        /* ignore */
      }
    }

    if (serverUrl) configureApiBase(serverUrl);
  }

  // Restore a previously-issued bearer token so the session survives restarts.
  // (localStorage is fine for a self-hosted desktop app; swap for the OS
  // keychain via tauri-plugin-stronghold if you want at-rest encryption.)
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) configureAuthToken(token);
  } catch {
    /* ignore */
  }
}

// True once a token is stored — lets the UI skip the login screen on boot.
export function hasDesktopToken(): boolean {
  try {
    return isDesktop && Boolean(localStorage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

// Kick off sign-in: mint PKCE, stash the verifier, and open the login page in
// the user's *default browser* (not this webview — that's the whole point).
export async function startDesktopLogin(): Promise<void> {
  if (!isDesktop) return;
  const { url, verifier } = await startNativeLogin({ redirect: REDIRECT_URI });
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    /* ignore */
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

// Register the deeplink handler once at startup. When the browser bounces back
// to doughmination://auth/callback?code=..., trade the code for a token,
// persist it, and fire `onLoggedIn` so the app can re-render as signed in.
export async function initDesktopAuth(onLoggedIn: () => void): Promise<void> {
  if (!isDesktop) return;

  // Restored a token this launch? Make sure the webview also holds the
  // same-origin session cookie, so media (<audio>/<img>) authenticates. Awaited
  // here so it's in place before boot() kicks off any media requests.
  if (hasDesktopToken()) {
    try {
      await establishSessionCookie();
    } catch {
      /* ignore — API calls still work via the bearer token */
    }
  }

  const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  await onOpenUrl(async (urls) => {
    for (const raw of urls) {
      let code: string | null = null;
      try {
        code = new URL(raw).searchParams.get("code");
      } catch {
        /* not a URL we care about */
      }
      if (!code) continue;

      let verifier = "";
      try {
        verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
      } catch {
        /* ignore */
      }
      if (!verifier) continue; // no login in flight on this device

      try {
        const token = await completeNativeLogin(code, verifier);
        try {
          localStorage.setItem(TOKEN_KEY, token);
          sessionStorage.removeItem(VERIFIER_KEY);
        } catch {
          /* ignore */
        }
        // Drop the same-origin cookie so media requests authenticate too.
        try {
          await establishSessionCookie();
        } catch {
          /* ignore */
        }
        onLoggedIn();
      } catch (err) {
        console.error("native login exchange failed", err);
      }
      return; // handled
    }
  });
}

// Clear the stored token on logout so the next boot shows the login screen.
export function clearDesktopToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Forwards the currently playing track to the Rust side, which owns the
// actual Discord Social SDK client. Fire-and-forget: presence is cosmetic
// and should never block or break playback.
export async function syncDiscordPresence(song: Song | null): Promise<void> {
  if (!isDesktop) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!song) {
      await invoke("clear_presence");
      return;
    }
    // Absolute URL so Discord (which fetches it server-side) can load the art.
    const coverUrl = song.coverUrl ? absoluteApiUrl(song.coverUrl) : null;
    await invoke("set_now_playing", {
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationS: song.durationS,
      coverUrl,
    });
  } catch {
    /* best-effort — never blocks playback */
  }
}
