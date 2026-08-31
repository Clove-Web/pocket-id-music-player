// Electron shell for Doughmination Music. Replaces the old Tauri/Rust shell:
// a single window pointed at the live web player, plus the few things a plain
// browser tab can't do —
//   * catch the doughmination://auth/callback deep link from the SSO round trip
//   * catch the doughmination://lastfm/callback deep link (Last.fm connect runs
//     in the system browser too — see routes/lastfm.ts)
//   * push Discord Rich Presence (see discord.ts)
//   * pull app updates from GitHub Releases (electron-updater)
// Everything else (library, queue, playback, UI) is the web app, unchanged.

import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "node:path";
// CJS module with no default export; `autoUpdater` is a lazy getter that
// builds the platform updater on first access, so it's only read inside
// setupAutoUpdate() (after app is ready), never at module load.
import * as electronUpdater from "electron-updater";

import { registerIpc } from "./ipc";
import { getServerUrl, setServerUrl } from "./settings";

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";

// Bundled into app.asar/build/ via electron-builder `files` (see
// electron-builder.yml). __dirname is app.asar/dist at runtime, and
// apps/desktop/dist in dev — both resolve one level up into build/.
const WINDOW_ICON = join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png");

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
    setupMenu();
    createWindow();
    setupAutoUpdate();

    // Windows/Linux: the deep link may be in this very process's argv (app
    // launched by the browser handing off the callback URL).
    const link = deepLinkFromArgv(process.argv);
    if (link) deliverDeepLink(link);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "Doughmination Music",
    icon: WINDOW_ICON,
    backgroundColor: "#0a0b10",
    // No native menu bar on Windows/Linux (see setupMenu) — hide the empty
    // strip and stop Alt from summoning it.
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The window only ever shows the player's own origin. Anything else — an
  // outbound link, the SSO "open in your browser" hop, Last.fm's auth page —
  // goes to the system browser instead of navigating the app away. Origin is
  // read fresh each call so it stays right after "Set Server URL…".
  const routeExternal = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url)) return false;
    if (originOf(url) === originOf(getServerUrl())) return false;
    void shell.openExternal(url);
    return true;
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (routeExternal(url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (routeExternal(url)) event.preventDefault();
  });

  // With no menu on Windows/Linux there are no accelerators, so wire the
  // handful of shortcuts people expect straight to the webContents.
  if (!isMac) win.webContents.on("before-input-event", handleShortcut);

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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// --- keyboard shortcuts (Windows/Linux, menu-less) ------------------------

function handleShortcut(
  event: Electron.Event,
  input: Electron.Input,
): void {
  if (input.type !== "keyDown" || !win) return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  const reload = () => {
    event.preventDefault();
    win!.webContents.reload();
  };

  if (key === "f5") return reload();
  if (ctrl && key === "r") {
    event.preventDefault();
    if (input.shift) win.webContents.reloadIgnoringCache();
    else win.webContents.reload();
    return;
  }
  if (isDev && (key === "f12" || (ctrl && input.shift && key === "i"))) {
    event.preventDefault();
    win.webContents.toggleDevTools();
    return;
  }
  if (ctrl && input.alt && key === "s") {
    event.preventDefault();
    void promptServerUrl();
  }
}

// --- menu ----------------------------------------------------------------

function setupMenu(): void {
  // Windows/Linux: no application menu at all (the "File / View / Window"
  // strip). macOS keeps one because the platform genuinely needs it (Cmd+Q,
  // Cmd+C/V, Hide, the Services menu, …).
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Set Server URL…", click: () => void promptServerUrl() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- auto-update -------------------------------------------------------------
// Pulls from the GitHub Releases feed configured in electron-builder.yml
// (`publish`). Silent download, then a prompt to restart. Unsigned macOS
// builds can't self-update (Squirrel.Mac requires a signature) — the check
// just no-ops there.

function setupAutoUpdate(): void {
  if (isDev) return;

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    if (!win) return;
    void dialog
      .showMessageBox(win, {
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `Doughmination Music ${info.version} is ready to install.`,
        detail: "Restart the app to finish updating.",
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("auto-update failed:", err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  void check();
  setInterval(check, 6 * 60 * 60 * 1000); // re-check every 6h
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
