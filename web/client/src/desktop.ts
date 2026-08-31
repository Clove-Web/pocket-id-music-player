// Everything that's different about running inside the Electron desktop shell
// vs a plain browser tab, in one place. The web app itself never checks for
// the shell anywhere else — it calls these functions and they no-op in the
// browser.
//
// The shell (apps/desktop) exposes a single `window.dmndDesktop` bridge (see
// its preload.ts). The window loads the live site as its own origin, so the
// web app is same-origin with the API — no base-URL juggling like the old
// Tauri local-bundle build needed.

import {
  api,
  configureAuthToken,
  startNativeLogin,
  completeNativeLogin,
  establishSessionCookie,
  absoluteApiUrl,
  type Song,
} from "@musicapp/shared";

type NowPlayingPayload = {
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  coverUrl: string | null;
  positionS: number;
  playing: boolean;
};

type DmndDesktop = {
  setNowPlaying: (np: NowPlayingPayload) => Promise<void>;
  clearPresence: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  serverUrl: () => Promise<string>;
  onDeepLink: (cb: (url: string) => void) => void;
};

declare global {
  interface Window {
    dmndDesktop?: DmndDesktop;
  }
}

const TOKEN_KEY = "music:desktop:token";
const VERIFIER_KEY = "music:desktop:pkceVerifier";
const REDIRECT_URI = "doughmination://auth/callback";

const bridge = typeof window !== "undefined" ? window.dmndDesktop : undefined;
export const isDesktop = Boolean(bridge);

// Call once, before the first api.* call. Web is same-origin and this is a
// no-op there. The desktop window is also same-origin with the API, so all
// this does is restore a previously-issued bearer token.
export function initDesktopBridge(): void {
  if (!isDesktop) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) configureAuthToken(token);
  } catch {
    /* ignore */
  }
}

// Open a URL outside the app. On desktop this hands off to the system
// browser (a plain <a href> would navigate the Electron webview away from
// the app); on web it's a no-op and the caller lets the link behave.
// Returns true if it handled the open.
export function openExternal(url: string): boolean {
  if (!bridge) return false;
  void bridge.openExternal(url);
  return true;
}

<<<<<<< Updated upstream
=======
// Last.fm connect on desktop runs entirely in the system browser (same reason
// as SSO — no passkeys / wrong cookie jar in the webview). It returns via
// doughmination://lastfm/callback?token=… which initDesktopAuth catches and
// routes to this handler.
type LastfmResult = { ok: true; username?: string } | { ok: false };
let lastfmHandler: ((r: LastfmResult) => void) | null = null;

export function onLastfmConnect(cb: (r: LastfmResult) => void): void {
  lastfmHandler = cb;
}

// Kick off Last.fm's auth page in the system browser.
export function startDesktopLastfmConnect(connectUrl: string): boolean {
  if (!bridge) return false;
  void bridge.openExternal(connectUrl);
  return true;
}

>>>>>>> Stashed changes
// True once a token is stored — lets the UI skip a re-auth on boot.
export function hasDesktopToken(): boolean {
  try {
    return isDesktop && Boolean(localStorage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

// Kick off sign-in: mint PKCE, stash the verifier, and open the login page in
// the user's *default browser* (not this window — that's the whole point).
export async function startDesktopLogin(): Promise<void> {
  if (!bridge) return;
  const { url, verifier } = await startNativeLogin({ redirect: REDIRECT_URI });
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    /* ignore */
  }
  await bridge.openExternal(url);
}

// Register the deep-link handler once at startup. When the browser bounces
// back to doughmination://auth/callback?code=…, trade the code for a token,
// persist it, and fire `onLoggedIn` so the app re-renders as signed in.
export async function initDesktopAuth(onLoggedIn: () => void): Promise<void> {
  if (!bridge) return;

  // Restored a token this launch? Make sure the window also holds the
  // same-origin session cookie so media (<audio>/<img>) authenticates.
  if (hasDesktopToken()) {
    try {
      await establishSessionCookie();
    } catch {
      /* ignore — API calls still work via the bearer token */
    }
  }

  bridge.onDeepLink(async (raw) => {
    let link: URL | null = null;
    try {
      link = new URL(raw);
    } catch {
      /* not a URL we care about */
    }
    if (!link) return;

    // doughmination://lastfm/callback?token=… — finish a Last.fm connect that
    // ran in the system browser.
    if (link.host === "lastfm") {
      const token = link.searchParams.get("token");
      if (!token || link.searchParams.get("error")) {
        lastfmHandler?.({ ok: false });
        return;
      }
      try {
        const res = await api.lastfmNativeComplete(token);
        lastfmHandler?.({ ok: true, username: res.username });
      } catch (err) {
        console.error("lastfm native connect failed", err);
        lastfmHandler?.({ ok: false });
      }
      return;
    }

    const code = link.searchParams.get("code");
    if (!code) return;

    let verifier = "";
    try {
      verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
    } catch {
      /* ignore */
    }
    if (!verifier) return; // no login in flight on this device

    try {
      const token = await completeNativeLogin(code, verifier);
      try {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(VERIFIER_KEY);
      } catch {
        /* ignore */
      }
      try {
        await establishSessionCookie();
      } catch {
        /* ignore */
      }
      onLoggedIn();
    } catch (err) {
      console.error("native login exchange failed", err);
    }
  });
}

// Clear the stored token on logout.
export function clearDesktopToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Forwards the currently playing track to the shell's main process, which
// owns the Discord Rich Presence connection (see apps/desktop/src/discord.ts).
// Fire-and-forget: presence is cosmetic and must never block playback.
export async function syncDiscordPresence(
  song: Song | null,
  playback?: { playing: boolean; positionS: number },
): Promise<void> {
  if (!bridge) return;
  try {
    if (!song) {
      await bridge.clearPresence();
      return;
    }
    // Absolute URL so Discord (which fetches it server-side) can load the art.
    const coverUrl = song.coverUrl ? absoluteApiUrl(song.coverUrl) : null;
    await bridge.setNowPlaying({
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationS: song.durationS,
      coverUrl,
      positionS: playback?.positionS ?? 0,
      playing: playback?.playing ?? true,
    });
  } catch {
    /* best-effort — never blocks playback */
  }
}
