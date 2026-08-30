// The bridge the loaded web app sees as `window.dmndDesktop`. Mirrors what the
// old Tauri build exposed via `invoke(...)` / the deep-link plugin. Context
// isolation is on, so this whitelist is the entire native surface the remote
// page can reach.

import { contextBridge, ipcRenderer } from "electron";

import type { NowPlaying } from "./discord";

const api = {
  setNowPlaying: (np: NowPlaying): Promise<void> => ipcRenderer.invoke("presence:set", np),
  clearPresence: (): Promise<void> => ipcRenderer.invoke("presence:clear"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:open-external", url),
  serverUrl: (): Promise<string> => ipcRenderer.invoke("settings:server-url"),
  // The system browser bounced a doughmination://auth/callback?code=… back to
  // the app; the main process forwards it here.
  onDeepLink: (cb: (url: string) => void): void => {
    ipcRenderer.on("deep-link", (_e, url: string) => cb(url));
  },
};

contextBridge.exposeInMainWorld("dmndDesktop", api);

export type DmndDesktop = typeof api;
