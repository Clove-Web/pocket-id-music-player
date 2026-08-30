// The renderer (the loaded web app, via preload.ts) can reach exactly these
// four things and nothing else.

import { ipcMain, shell } from "electron";

import { clear, setNowPlaying, type NowPlaying } from "./discord";
import { getServerUrl } from "./settings";

export function registerIpc(): void {
  ipcMain.handle("presence:set", (_e, np: NowPlaying) => setNowPlaying(np));
  ipcMain.handle("presence:clear", () => clear());
  ipcMain.handle("settings:server-url", () => getServerUrl());
  ipcMain.handle("shell:open-external", (_e, url: string) => {
    // Only http(s) — never let the page hand us a file:// or custom scheme.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    return undefined;
  });
}
