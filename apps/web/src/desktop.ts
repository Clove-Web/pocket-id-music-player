// Everything that's different about running inside the Tauri desktop shell
// vs a plain browser tab, in one place. The web app itself never checks
// `window.__TAURI__` anywhere else — it calls these two functions and
// they no-op in the browser.

import { configureApiBase, type Song } from "@musicapp/shared";

declare global {
  interface Window {
    __TAURI__?: unknown;
  }
}

const SERVER_URL_KEY = "music:desktop:serverUrl";

export const isDesktop = typeof window !== "undefined" && !!window.__TAURI__;

// Call once, before the first api.* call. Web is same-origin and this is a
// no-op there. Desktop has no origin to inherit, so it asks the user for
// their self-hosted server URL once and remembers it.
export function initDesktopBridge(): void {
  if (!isDesktop) return;

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
    await invoke("set_now_playing", {
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationS: song.durationS,
    });
  } catch {
    /* best-effort — never blocks playback */
  }
}
