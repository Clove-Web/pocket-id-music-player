// Electron shell for Doughmination Music. Replaces the old Tauri/Rust shell:
// a single window pointed at the live web player, plus the two things a plain
// browser tab can't do —
//   * catch the doughmination://auth/callback deep link from the SSO round trip
//   * push Discord Rich Presence (see discord.ts)
// Everything else (library, queue, playback, UI) is the web app, unchanged.

import { app, BrowserWindow, Menu, shell, ipcMain, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";

import { registerIpc } from "./ipc";
import { getServerUrl, setServerUrl } from "./settings";

const isDev = !app.isPackaged;
let win: BrowserWindow | null = null;

// Deep links that arrive before the window/page is ready are queued and
// replayed once it has loaded.
let pageReady = false;
const pendingDeepLinks: string[] = [];

function deliverDeepLink(url: string): void {
  if (!url.startsWith("doughmination://")) return;
  if (pageReady && win) win.webContents.send("deep-link", url);
  else pendingDeepLinks.push(url);
}

// Pull a doughmination:// URL out of a process argv list (Windows/Linux deliver
// the deep link as a launch argument of a second process).
function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith("doughmination://"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const link = deepLinkFromArgv(argv);
    if (link) deliverDeepLink(link);
  });

  // macOS delivers the deep link through this event, not argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient("doughmination");
    registerIpc();
    buildMenu();
    createWindow();

    // Windows/Linux: the deep link may be in this very process's argv (app
    // launched by the browser handing off the callback URL).
    const link = deepLinkFromArgv(process.argv);
    if (link) deliverDeepLink(link);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "Doughmination Music",
    backgroundColor: "#0a0b10",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Outbound links (and the SSO "open in your browser" click) leave the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    pageReady = true;
    for (const url of pendingDeepLinks.splice(0)) win!.webContents.send("deep-link", url);
  });

  win.on("closed", () => {
    win = null;
    pageReady = false;
  });

  void win.loadURL(getServerUrl());
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Set Server URL…",
          click: () => void promptServerUrl(),
        },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Tiny modal input window — Electron's dialog has no text field, so this is
// our own ~1-screen HTML form. It's local content, so nodeIntegration here is
// safe (unlike the remote page the main window loads).
function promptServerUrl(): Promise<void> {
  return new Promise((resolve) => {
    const current = getServerUrl();
    const prompt = new BrowserWindow({
      width: 460,
      height: 180,
      parent: win ?? undefined,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Server URL",
      backgroundColor: "#12141c",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    prompt.setMenuBarVisibility(false);

    const html = `<!doctype html><meta charset="utf-8">
<style>
  body{font:13px system-ui,sans-serif;background:#12141c;color:#f4f6fb;margin:0;padding:16px}
  input{width:100%;box-sizing:border-box;padding:8px;margin:8px 0 12px;border:1px solid #232838;
    border-radius:8px;background:#1b1e2a;color:#f4f6fb}
  .row{display:flex;gap:8px;justify-content:flex-end}
  button{padding:7px 14px;border-radius:8px;border:1px solid #232838;background:#1b1e2a;color:#f4f6fb;cursor:pointer}
  button.primary{background:#f5a9b8;border-color:#f5a9b8;color:#0a0b10;font-weight:700}
</style>
<label for="u">Load the player from:</label>
<input id="u" value="${current.replace(/"/g, "&quot;")}" spellcheck="false" autofocus>
<div class="row">
  <button id="cancel">Cancel</button>
  <button id="ok" class="primary">Save &amp; reload</button>
</div>
<script>
  const { ipcRenderer } = require("electron");
  const u = document.getElementById("u");
  u.select();
  document.getElementById("cancel").onclick = () => ipcRenderer.send("prompt:cancel");
  document.getElementById("ok").onclick = () => ipcRenderer.send("prompt:submit", u.value);
  addEventListener("keydown", (e) => {
    if (e.key === "Enter") ipcRenderer.send("prompt:submit", u.value);
    if (e.key === "Escape") ipcRenderer.send("prompt:cancel");
  });
</script>`;
    void prompt.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

    const done = () => {
      ipcMain.removeAllListeners("prompt:submit");
      ipcMain.removeAllListeners("prompt:cancel");
      if (!prompt.isDestroyed()) prompt.close();
      resolve();
    };
    ipcMain.once("prompt:cancel", done);
    ipcMain.once("prompt:submit", (_e, value: string) => {
      const v = String(value ?? "").trim();
      if (v) {
        setServerUrl(v);
        win?.loadURL(getServerUrl());
      }
      done();
    });
    prompt.on("closed", () => resolve());
  });
}
