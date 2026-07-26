// Single-page app: library, dedicated upload, browse shared playlists,
// per-user + shared playlists, and a full player bar.

import {
  api,
  type Song,
  type Playlist,
  type Me,
  type Lyrics,
  type Artist,
  type ArtistDetail,
  type LinkRequest,
  type DuplicateReview,
} from "./api.ts";
import {
  Player,
  formatTime,
} from "./player.ts";
import { readTags } from "./metadata.ts";

const root = document.getElementById("app")!;
const player = new Player();

type View =
  | { kind: "library" }
  | { kind: "browse" }
  | { kind: "playlist"; id: string }
  | { kind: "artists" }
  | { kind: "artist"; id: string }
  | { kind: "duplicates" }
  | { kind: "linkRequests" }
  | { kind: "settings" };

const state = {
  me: null as Me | null,
  songs: [] as Song[],
  playlists: [] as Playlist[],
  view: { kind: "library" } as View,
  visibleSongs: [] as Song[],
  adminCounts: { duplicates: 0, linkRequests: 0 },
};

let lastSave = 0;
player.onChange = () => {
  renderPlayerBar();
  syncLyrics();
  checkScrobbleThreshold();
  const now = Date.now();
  if (now - lastSave > 2000) {
    lastSave = now;
    saveNowPlaying();
  }
};
player.onError = (msg) => flash(msg);

// --- Last.fm scrobbling -----------------------------------------------------
// Last.fm's own rules: send "now playing" as soon as a track starts, then
// scrobble once the lesser of (half the track's duration, 4 minutes) has
// elapsed — and never for tracks under 30s. See lib/lastfm.ts server-side.

let scrobbleTrack: { song: Song; startedAt: number; scrobbled: boolean } | null = null;

function onTrackStarted(song: Song): void {
  scrobbleTrack = { song, startedAt: Math.floor(Date.now() / 1000), scrobbled: false };
  if (!state.me?.lastfmConnected) return;
  api
    .lastfmNowPlaying({
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationS: song.durationS,
    })
    .catch(() => {
      /* best-effort — never blocks playback */
    });
}
player.onTrackChange = onTrackStarted;

function checkScrobbleThreshold(): void {
  if (!scrobbleTrack || scrobbleTrack.scrobbled || !state.me?.lastfmConnected) return;
  const { current, duration } = player.progress;
  if (!duration || duration < 30) return; // Last.fm: no scrobbling under 30s

  const threshold = Math.min(duration / 2, 4 * 60);
  if (current < threshold) return;

  scrobbleTrack.scrobbled = true; // mark before the request settles, not after
  const { song, startedAt } = scrobbleTrack;
  api
    .lastfmScrobble({
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationS: song.durationS,
      startedAt,
    })
    .catch(() => {
      /* best-effort */
    });
}

// Persist / restore the current session so a forced reload can resume.
const NOW_PLAYING_KEY = "music:nowplaying";

function saveNowPlaying(): void {
  try {
    const snap = player.snapshot();
    if (snap) localStorage.setItem(NOW_PLAYING_KEY, JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

function restoreNowPlaying(): void {
  try {
    const raw = localStorage.getItem(NOW_PLAYING_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw) as {
      ids: string[];
      index: number;
      position: number;
    };
    const byId = new Map(state.songs.map((s) => [s.id, s]));
    const songs = snap.ids
      .map((id) => byId.get(id))
      .filter((s): s is Song => Boolean(s));
    if (!songs.length) return;
    const targetId = snap.ids[snap.index];
    const idx = targetId ? songs.findIndex((s) => s.id === targetId) : 0;
    player.restore(songs, idx >= 0 ? idx : 0, snap.position || 0);
  } catch {
    /* ignore */
  }
}

window.addEventListener("pagehide", saveNowPlaying);
window.addEventListener("beforeunload", saveNowPlaying);

// "Hide explicit" preference (public-friendly), persisted locally.
let hideExplicit = false;
try {
  hideExplicit = localStorage.getItem("music:hideExplicit") === "1";
} catch {
  /* ignore */
}
function filterExplicit<T extends { explicit: boolean }>(songs: T[]): T[] {
  return hideExplicit ? songs.filter((s) => !s.explicit) : songs;
}

// Space toggles play/pause anywhere except when typing in a field.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
  e.preventDefault(); // stop page scroll + focused-button double toggle
  player.toggle();
});

// --- boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  state.me = await api.me();
  if (!state.me) {
    renderLogin();
    return;
  }
  await Promise.all([loadSongs(), loadPlaylists()]);
  if (state.me.isAdmin) await refreshAdminCounts();
  restoreNowPlaying();
  handleLastfmRedirect();
  render();
  startVisualizer();
}

// After the Last.fm "Connect" handshake, the backend redirects back here
// with ?lastfm=connected|error. Surface that, land on Settings, and drop
// the param so a refresh doesn't re-show the toast.
function handleLastfmRedirect(): void {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("lastfm");
  if (!result) return;

  state.view = { kind: "settings" };
  if (result === "connected") flash("Last.fm connected.");
  else if (result === "error") flash("Couldn't connect Last.fm. Try again?");

  params.delete("lastfm");
  const qs = params.toString();
  history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

async function loadSongs(): Promise<void> {
  state.songs = await api.listSongs();
}

async function loadPlaylists(): Promise<void> {
  state.playlists = await api.listPlaylists();
}

async function refreshAdminCounts(): Promise<void> {
  if (!state.me?.isAdmin) return;
  const [dupes, reqs] = await Promise.all([
    api.listDuplicates("pending"),
    api.listLinkRequests("pending"),
  ]);
  state.adminCounts = { duplicates: dupes.length, linkRequests: reqs.length };
}

// --- top-level render ------------------------------------------------------

function render(): void {
  root.innerHTML = `
    <button class="hamburger" id="hamburger" aria-label="Menu"><i class="bi bi-list"></i></button>
    <div class="layout">
      <aside class="sidebar" id="sidebar"></aside>
      <div class="scrim" id="scrim"></div>
      <main class="main" id="main"></main>
    </div>
    <div class="playerbar" id="playerbar"></div>
  `;
  renderSidebar();
  renderMain();
  renderPlayerBar();

  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  const closeDrawer = () => {
    sidebar?.classList.remove("open");
    scrim?.classList.remove("show");
  };
  document.getElementById("hamburger")?.addEventListener("click", () => {
    sidebar?.classList.toggle("open");
    scrim?.classList.toggle("show");
  });
  scrim?.addEventListener("click", closeDrawer);
  sidebar
    ?.querySelectorAll("[data-view],[data-playlist],#upload-btn")
    .forEach((b) => b.addEventListener("click", closeDrawer));
}

function renderLogin(): void {
  root.innerHTML = `
    <div class="login">
      <h1>Music</h1>
      <p>Sign in with your passkey to continue.</p>
      <a class="btn btn-primary" href="/api/auth/login">Sign in with PocketID</a>
    </div>
  `;
}

// --- sidebar --------------------------------------------------------------

function avatarHtml(url: string | null, name: string | null, cls = ""): string {
  if (url) return `<img class="avatar ${cls}" src="${url}" alt="" />`;
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return `<div class="avatar avatar-empty ${cls}">${escapeHtml(initial)}</div>`;
}

function renderSidebar(): void {
  const el = document.getElementById("sidebar");
  if (!el) return;

  const nav = (kind: View["kind"], label: string) => `
    <button class="nav-link ${state.view.kind === kind ? "active" : ""}"
            data-view="${kind}">${label}</button>`;

  const items = state.playlists
    .map(
      (p) => `
      <li class="${activePlaylist(p.id) ? "active" : ""}">
        <button data-playlist="${p.id}">
          <span class="pl-name">${escapeHtml(p.name)}</span>
          ${p.isPublic ? `<span class="pl-badge" title="Shared">shared</span>` : ""}
        </button>
      </li>`,
    )
    .join("");

  el.innerHTML = `
    <div class="brand">Music</div>
    ${nav("library", "Library")}
    <button class="nav-link" id="upload-btn">
      <i class="bi bi-cloud-arrow-up"></i> Upload
    </button>
    ${nav("browse", "Browse shared")}
    ${nav("artists", "Artists")}
    ${
      state.me?.isAdmin
        ? `
      <div class="section-head"><span>Admin</span></div>
      <button class="nav-link ${state.view.kind === "duplicates" ? "active" : ""}" data-view="duplicates">
        Duplicates${
          state.adminCounts.duplicates
            ? ` <span class="pl-badge">${state.adminCounts.duplicates}</span>`
            : ""
        }
      </button>
      <button class="nav-link ${state.view.kind === "linkRequests" ? "active" : ""}" data-view="linkRequests">
        Artist requests${
          state.adminCounts.linkRequests
            ? ` <span class="pl-badge">${state.adminCounts.linkRequests}</span>`
            : ""
        }
      </button>`
        : ""
    }

    <div class="section-head">
      <span>Playlists</span>
      <button class="icon-btn" id="new-playlist" title="New playlist"><i class="bi bi-plus-lg"></i></button>
    </div>
    <ul class="playlists">${items}</ul>

    <div class="sidebar-foot">
      ${avatarHtml(state.me?.avatarUrl ?? null, state.me?.name ?? null, "sm")}
      <span class="me-name">${escapeHtml(
        state.me?.name ?? state.me?.email ?? "You",
      )}</span>
      <button class="icon-btn" data-view="settings" title="Settings"><i class="bi bi-gear"></i></button>
      <button class="link" id="logout">Log out</button>
    </div>
  `;

  el.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = (btn as HTMLElement).dataset.view as
        | "library"
        | "browse"
        | "artists"
        | "duplicates"
        | "linkRequests"
        | "settings";
      state.view = { kind };
      render();
    });
  });

  document.getElementById("upload-btn")?.addEventListener("click", openUploadModal);

  el.querySelectorAll("[data-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = { kind: "playlist", id: (btn as HTMLElement).dataset.playlist! };
      render();
    });
  });

  document.getElementById("new-playlist")?.addEventListener("click", openCreatePlaylistModal);

  document.getElementById("logout")?.addEventListener("click", async () => {
    const res = await api.logout();
    const data = (await res.json()) as { endSession: string | null };
    window.location.href = data.endSession ?? "/";
  });
}

// --- main area -------------------------------------------------------------

async function renderMain(): Promise<void> {
  const el = document.getElementById("main");
  if (!el) return;

  const view = state.view;
  if (view.kind === "library") renderLibrary(el);
  else if (view.kind === "browse") await renderBrowse(el);
  else if (view.kind === "artists") await renderArtists(el);
  else if (view.kind === "artist") await renderArtistView(el, view.id);
  else if (view.kind === "duplicates") await renderDuplicates(el);
  else if (view.kind === "linkRequests") await renderLinkRequests(el);
  else if (view.kind === "settings") await renderSettings(el);
  else await renderPlaylistView(el, view.id);
}

function renderLibrary(el: HTMLElement): void {
  const shown = filterExplicit(state.songs);
  state.visibleSongs = shown;
  el.innerHTML = `
    <header class="main-head">
      <h2>Library</h2>
      <div class="head-actions">
        <label class="check-inline">
          <input type="checkbox" id="hide-explicit" ${hideExplicit ? "checked" : ""} />
          Hide explicit
        </label>
        <input id="search" class="search" placeholder="Search title or artist" />
      </div>
    </header>
    <div id="songlist">${songTableHtml(shown)}</div>
  `;

  wireSongList();

  document.getElementById("hide-explicit")?.addEventListener("change", (e) => {
    hideExplicit = (e.target as HTMLInputElement).checked;
    try {
      localStorage.setItem("music:hideExplicit", hideExplicit ? "1" : "0");
    } catch {
      /* ignore */
    }
    renderMain();
  });

  const search = document.getElementById("search") as HTMLInputElement | null;
  search?.addEventListener("input", async () => {
    const rows = filterExplicit(
      await api.listSongs(search.value.trim() || undefined),
    );
    state.visibleSongs = rows;
    const list = document.getElementById("songlist");
    if (list) {
      list.innerHTML = songTableHtml(rows);
      wireSongList();
    }
  });
}

// --- playlist modals ---------------------------------------------------------

function openCreatePlaylistModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>New playlist</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <form id="playlist-form" class="upload-card">
        <label class="field"><span>Name <em>(required)</em></span>
          <input name="name" required autofocus /></label>
        <button class="btn btn-primary" type="submit">Create</button>
        <span id="playlist-status" class="upload-status"></span>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const form = overlay.querySelector("#playlist-form") as HTMLFormElement;
  const status = overlay.querySelector("#playlist-status") as HTMLElement;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (form.querySelector('[name="name"]') as HTMLInputElement).value.trim();
    if (!name) return;
    const btn = form.querySelector("button")!;
    btn.textContent = "Creating...";
    btn.setAttribute("disabled", "true");
    try {
      await api.createPlaylist(name);
      close();
      await loadPlaylists();
      renderSidebar();
    } catch (err) {
      status.textContent = `Something went wrong: ${(err as Error).message}`;
      btn.textContent = "Create";
      btn.removeAttribute("disabled");
    }
  });
}

// Fuzzy-filterable picker for "add this song to a playlist", replacing the
// old numbered prompt(). Reuses the same dice-coefficient scoring as the
// server-side artist/song search so a fast typo-tolerant filter doesn't need
// its own separate matching logic.
function openPlaylistPickerModal(playlists: Playlist[]): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>Add to playlist</h2>
          <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
        </div>
        <input id="playlist-filter" class="search" placeholder="Filter playlists" autofocus />
        <ul class="playlist-picker" id="playlist-picker-list"></ul>
      </div>
    `;
    document.body.appendChild(overlay);

    let resolved = false;
    const finish = (id: string | null) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      document.removeEventListener("keydown", onEsc);
      resolve(id);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", onEsc);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.querySelector("#modal-close")?.addEventListener("click", () => finish(null));

    const list = overlay.querySelector("#playlist-picker-list") as HTMLElement;
    const filterInput = overlay.querySelector("#playlist-filter") as HTMLInputElement;

    const draw = (query: string) => {
      const matches = fuzzyFilter(playlists, query, (p) => p.name);
      list.innerHTML = matches
        .map(
          (p) =>
            `<li><button type="button" class="playlist-pick" data-id="${p.id}">${escapeHtml(p.name)}</button></li>`,
        )
        .join("") || `<li class="empty">No playlists match.</li>`;
      list.querySelectorAll("[data-id]").forEach((btn) => {
        btn.addEventListener("click", () => finish((btn as HTMLElement).dataset.id!));
      });
    };
    draw("");
    filterInput.addEventListener("input", () => draw(filterInput.value));
  });
}

// --- upload modal ----------------------------------------------------------

function openUploadModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>Upload</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Add audio files">
        <i class="bi bi-cloud-arrow-up dz-icon"></i>
        <span class="dz-text">Drag audio files here, or <span class="dz-link">browse</span></span>
        <span class="dz-hint">One song lets you edit details; multiple upload in bulk.</span>
        <input type="file" accept="audio/*" multiple hidden />
      </div>
      <div id="upload-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const dropzone = overlay.querySelector("#dropzone") as HTMLElement;
  const fileInput = overlay.querySelector('input[type="file"]') as HTMLInputElement;
  const body = overlay.querySelector("#upload-body") as HTMLElement;

  const onFiles = (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    if (list.length === 1) renderSingle(list[0]!);
    else renderBatch(list);
  };

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => onFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    }),
  );
  ["dragleave", "dragend"].forEach((ev) =>
    dropzone.addEventListener(ev, () => dropzone.classList.remove("drag")),
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    onFiles((e as DragEvent).dataTransfer?.files);
  });

  // --- single file: prefilled, editable form ---
  function renderSingle(file: File): void {
    body.innerHTML = `
      <form id="upload" class="upload-card">
        <p class="dz-file">${escapeHtml(file.name)}</p>
        <label class="field"><span>Song name <em>(required)</em></span>
          <input name="title" required /></label>
        <label class="field"><span>Artist <em>(required)</em></span>
          <input name="artist" required /></label>
        <label class="field"><span>Album <em>(optional)</em></span>
          <input name="album" /></label>
        <label class="check-row"><input type="checkbox" name="explicit" value="true" /> <span>Explicit content</span></label>
        <div class="field"><span>Cover image <em>(optional)</em></span>
          <label class="file-chip"><i class="bi bi-image"></i>
            <span id="cover-name">Choose image</span>
            <input type="file" name="cover" accept="image/*" hidden /></label>
        </div>
        <button class="btn btn-primary" type="submit">Upload</button>
        <span id="upload-status" class="upload-status"></span>
      </form>
    `;
    const form = body.querySelector("#upload") as HTMLFormElement;
    const status = body.querySelector("#upload-status");
    const titleInput = form.querySelector('[name="title"]') as HTMLInputElement;
    const artistInput = form.querySelector('[name="artist"]') as HTMLInputElement;
    const albumInput = form.querySelector('[name="album"]') as HTMLInputElement;
    const coverInput = form.querySelector('[name="cover"]') as HTMLInputElement;
    const coverName = form.querySelector("#cover-name") as HTMLElement;

    void readTags(file).then((tags) => {
      if (tags.title) titleInput.value = tags.title;
      if (tags.artist) artistInput.value = tags.artist;
      if (tags.album) albumInput.value = tags.album;
    });
    coverInput.addEventListener("change", () => {
      coverName.textContent = coverInput.files?.[0]?.name ?? "Choose image";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      fd.set("file", file);
      const btn = form.querySelector("button")!;
      btn.textContent = "Uploading...";
      btn.setAttribute("disabled", "true");
      try {
        const song = await api.uploadSong(fd);
        await loadSongs();
        if (state.view.kind === "library") renderMain();
        close();
        flash(`Added "${song.title}" by ${song.artist}.`);
      } catch (err) {
        if (status) status.textContent = `Upload failed: ${(err as Error).message}`;
        btn.textContent = "Upload";
        btn.removeAttribute("disabled");
      }
    });
  }

  // --- many files: resilient sequential bulk upload ---
  function renderBatch(files: File[]): void {
    body.innerHTML = `
      <label class="check-row"><input type="checkbox" id="b-explicit" /> <span>Mark all explicit</span></label>
      <ul class="batch" id="batch">
        ${files
          .map(
            (f, i) => `<li class="b-row"><span class="b-name">${escapeHtml(f.name)}</span>
              <span class="b-stat" id="b-${i}">queued</span></li>`,
          )
          .join("")}
      </ul>
      <button class="btn btn-primary" id="b-start">Upload ${files.length} songs</button>
      <span id="b-summary" class="upload-status"></span>
    `;
    const startBtn = body.querySelector("#b-start") as HTMLButtonElement;
    const summary = body.querySelector("#b-summary") as HTMLElement;

    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      const explicitAll = (body.querySelector("#b-explicit") as HTMLInputElement).checked;
      const CONCURRENCY = 10;
      let ok = 0;
      let fail = 0;
      let done = 0;
      let next = 0;
      const failed: string[] = [];

      const uploadOne = async (i: number) => {
        const file = files[i]!;
        const stat = body.querySelector(`#b-${i}`) as HTMLElement;
        stat.textContent = "uploading…";
        stat.className = "b-stat";

        const tags = await readTags(file).catch(() => ({}) as Awaited<ReturnType<typeof readTags>>);
        const fd = new FormData();
        fd.set("file", file);
        fd.set("title", tags.title ?? file.name.replace(/\.[^.]+$/, ""));
        fd.set("artist", tags.artist ?? "Unknown Artist");
        fd.set("album", ""); // bulk: leave album blank (tags are unreliable)
        if (explicitAll) fd.set("explicit", "true");

        const success = await uploadWithRetry(fd, 2);
        done++;
        if (success) {
          ok++;
          stat.textContent = "✓";
          stat.classList.add("ok");
        } else {
          fail++;
          failed.push(file.name);
          stat.textContent = "failed";
          stat.classList.add("err");
        }
        summary.textContent = `${ok} uploaded, ${fail} failed, ${files.length - done} left`;
      };

      // Worker pool: each worker pulls the next file as it finishes one, so up
      // to CONCURRENCY uploads run at a time (small files don't wait on big ones).
      const worker = async () => {
        while (next < files.length) {
          await uploadOne(next++);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker),
      );

      await loadSongs();
      if (state.view.kind === "library") renderMain();
      summary.textContent = `Done — ${ok} uploaded${fail ? `, ${fail} failed` : ""}.`;
      if (failed.length) console.warn("Failed uploads:", failed);
    });
  }
}

// Upload one file, retrying transient NetworkErrors (not HTTP errors).
async function uploadWithRetry(fd: FormData, retries: number): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("/api/songs", { method: "POST", body: fd });
      if (res.ok) return true;
      if (res.status === 429 && attempt < retries) {
        await sleep(2000); // rate limited: back off and retry
        continue;
      }
      return false; // other HTTP error (e.g. 400 missing tags) — skip
    } catch {
      if (attempt === retries) return false; // network error — give up
      await sleep(600 * (attempt + 1));
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Admin-only: fix metadata / apply the explicit tag on any song.
function openEditModal(song: Song): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>Edit details</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <form id="edit" class="upload-card">
        <label class="field">
          <span>Song name <em>(required)</em></span>
          <input name="title" value="${escapeHtml(song.title)}" required />
        </label>
        <label class="field">
          <span>Artist <em>(required)</em></span>
          <input name="artist" value="${escapeHtml(song.artist)}" required />
        </label>
        <label class="field">
          <span>Album <em>(optional)</em></span>
          <input name="album" value="${escapeHtml(song.album ?? "")}" />
        </label>
        <label class="check-row">
          <input type="checkbox" name="explicit" value="true" ${song.explicit ? "checked" : ""} />
          <span>Explicit content</span>
        </label>
        <div class="field">
          <span>Replace cover <em>(optional)</em></span>
          <label class="file-chip">
            <i class="bi bi-image"></i>
            <span id="cover-name">Choose image</span>
            <input type="file" name="cover" accept="image/*" hidden />
          </label>
        </div>
        <button class="btn btn-primary" type="submit">Save</button>
        <span id="edit-status" class="upload-status"></span>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const coverInput = overlay.querySelector('input[name="cover"]') as HTMLInputElement;
  const coverName = overlay.querySelector("#cover-name") as HTMLElement;
  coverInput.addEventListener("change", () => {
    coverName.textContent = coverInput.files?.[0]?.name ?? "Choose image";
  });

  // Ensure explicit is always sent (unchecked box would otherwise be omitted).
  const form = overlay.querySelector("#edit") as HTMLFormElement;
  const status = overlay.querySelector("#edit-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button")!;
    btn.textContent = "Saving...";
    btn.setAttribute("disabled", "true");
    if (status) status.textContent = "";
    const fd = new FormData(form);
    fd.set("explicit", form.querySelector<HTMLInputElement>('[name="explicit"]')?.checked ? "true" : "false");
    try {
      const updated = await api.updateSong(song.id, fd);
      await loadSongs();
      renderMain();
      close();
      flash(`Updated "${updated.title}".`);
    } catch (err) {
      if (status) status.textContent = `Save failed: ${(err as Error).message}`;
      btn.textContent = "Save";
      btn.removeAttribute("disabled");
    }
  });
}

// Small transient toast.
function flash(msg: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// --- browse shared playlists ----------------------------------------------

async function renderBrowse(el: HTMLElement): Promise<void> {
  el.innerHTML = `
    <header class="main-head">
      <h2>Browse shared</h2>
      <input id="pl-search" class="search" placeholder="Search playlists or owners" />
    </header>
    <div id="pl-results"></div>
  `;

  const results = document.getElementById("pl-results")!;
  const draw = async (q?: string) => {
    const rows = await api.searchPublicPlaylists(q);
    results.innerHTML = rows.length
      ? `<div class="pl-grid">${rows
          .map(
            (p) => `
        <button class="pl-card" data-open="${p.id}">
          ${avatarHtml(p.ownerAvatar, p.ownerName)}
          <div class="pl-card-meta">
            <span class="pl-card-name">${escapeHtml(p.name)}</span>
            <span class="pl-card-sub">${escapeHtml(
              p.ownerName ?? "unknown",
            )} · ${p.songCount} song${p.songCount === 1 ? "" : "s"}</span>
          </div>
        </button>`,
          )
          .join("")}</div>`
      : `<p class="empty">No shared playlists found.</p>`;

    results.querySelectorAll("[data-open]").forEach((b) => {
      b.addEventListener("click", () => {
        state.view = { kind: "playlist", id: (b as HTMLElement).dataset.open! };
        render();
      });
    });
  };

  await draw();
  const search = document.getElementById("pl-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => draw(search.value.trim() || undefined));
}

// --- artists -----------------------------------------------------------

async function renderArtists(el: HTMLElement): Promise<void> {
  el.innerHTML = `
    <header class="main-head">
      <h2>Artists</h2>
      <div class="head-actions">
        <input id="artist-search" class="search" placeholder="Search artists" />
        <button class="btn btn-primary" id="new-artist-btn">+ New artist</button>
      </div>
    </header>
    <div id="artist-results"></div>
  `;

  const results = document.getElementById("artist-results")!;
  const draw = async (q?: string) => {
    const rows = await api.searchArtists(q);
    results.innerHTML = rows.length
      ? `<div class="pl-grid">${rows
          .map(
            (a) => `
        <button class="pl-card" data-open="${a.id}">
          ${avatarHtml(a.avatarUrl, a.name)}
          <div class="pl-card-meta">
            <span class="pl-card-name">${escapeHtml(a.name)}</span>
            <span class="pl-card-sub">${a.songCount} song${a.songCount === 1 ? "" : "s"}</span>
          </div>
        </button>`,
          )
          .join("")}</div>`
      : `<p class="empty">${q ? "No artists match that search." : "No artist pages yet."}</p>`;

    results.querySelectorAll("[data-open]").forEach((b) => {
      b.addEventListener("click", () => {
        state.view = { kind: "artist", id: (b as HTMLElement).dataset.open! };
        render();
      });
    });
  };

  await draw();
  const search = document.getElementById("artist-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => draw(search.value.trim() || undefined));

  document.getElementById("new-artist-btn")?.addEventListener("click", () => {
    openArtistCreateModal();
  });
}

async function renderArtistView(el: HTMLElement, id: string): Promise<void> {
  const artist = await api.getArtist(id);
  const shownSongs = filterExplicit(artist.songs);
  state.visibleSongs = shownSongs;

  const editBtn = state.me?.isAdmin
    ? `<button class="icon-btn" id="edit-artist" title="Edit artist"><i class="bi bi-pencil-fill"></i></button>`
    : "";

  el.innerHTML = `
    <header class="main-head">
      <div class="main-head-title">
        ${avatarHtml(artist.avatarUrl, artist.name, "lg")}
        <h2>${escapeHtml(artist.name)}</h2>
      </div>
      <div class="head-actions">${editBtn}</div>
    </header>
    ${artist.bio ? `<p class="artist-bio">${escapeHtml(artist.bio)}</p>` : ""}
    <div id="songlist">${songTableHtml(shownSongs)}</div>
  `;

  wireSongList();

  document.getElementById("edit-artist")?.addEventListener("click", () => {
    openArtistEditModal(artist);
  });
}

// Create a brand-new artist page. Shared by the "Artists" browse page and
// the "link song to artist" flow's "can't find it? create new" fallback —
// `onCreated` fires either with the newly-created artist, or with the
// existing one if the name turned out to already have a page.
function openArtistCreateModal(
  prefill = "",
  onCreated?: (artist: Artist) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>New artist page</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <form id="artist-form" class="upload-card">
        <label class="field"><span>Artist name <em>(required)</em></span>
          <input name="name" value="${escapeHtml(prefill)}" required /></label>
        <label class="field"><span>Bio <em>(optional)</em></span>
          <input name="bio" /></label>
        <button class="btn btn-primary" type="submit">Create page</button>
        <span id="artist-status" class="upload-status"></span>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const form = overlay.querySelector("#artist-form") as HTMLFormElement;
  const status = overlay.querySelector("#artist-status") as HTMLElement;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (form.querySelector('[name="name"]') as HTMLInputElement).value.trim();
    const bio = (form.querySelector('[name="bio"]') as HTMLInputElement).value.trim();
    const btn = form.querySelector("button")!;
    btn.textContent = "Creating...";
    btn.setAttribute("disabled", "true");

    const result = await api.createArtist(name, bio || undefined);
    if (result.ok) {
      close();
      flash(`Created artist page for "${result.artist.name}".`);
      onCreated?.(result.artist);
      if (state.view.kind === "artists") renderMain();
      return;
    }

    if (result.status === 409 && result.existing) {
      const existing = result.existing;
      status.innerHTML = `Already exists — <button type="button" class="link" id="use-existing">use "${escapeHtml(existing.name)}" instead</button>`;
      status.querySelector("#use-existing")?.addEventListener("click", () => {
        close();
        onCreated?.(existing);
      });
    } else {
      status.textContent = "Something went wrong. Try again.";
    }
    btn.textContent = "Create page";
    btn.removeAttribute("disabled");
  });
}

function openArtistEditModal(artist: ArtistDetail): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>Edit artist</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="avatar-upload">
        ${avatarHtml(artist.avatarUrl, artist.name, "lg")}
        <label class="btn" for="artist-avatar-input">Change photo</label>
        <input type="file" id="artist-avatar-input" accept="image/*" hidden />
        <span id="artist-avatar-status" class="upload-status"></span>
      </div>
      <form id="artist-edit" class="upload-card">
        <label class="field"><span>Name <em>(required)</em></span>
          <input name="name" value="${escapeHtml(artist.name)}" required /></label>
        <label class="field"><span>Bio <em>(optional)</em></span>
          <input name="bio" value="${escapeHtml(artist.bio ?? "")}" /></label>
        <button class="btn btn-primary" type="submit">Save</button>
        <span id="artist-edit-status" class="upload-status"></span>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const avatarInput = overlay.querySelector("#artist-avatar-input") as HTMLInputElement;
  const avatarStatus = overlay.querySelector("#artist-avatar-status") as HTMLElement;
  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    avatarStatus.textContent = "Uploading...";
    try {
      const updated = await api.uploadArtistAvatar(artist.id, file);
      artist.avatarUrl = updated.avatarUrl;
      const preview = overlay.querySelector(".avatar-upload .avatar") as HTMLElement | null;
      if (preview) preview.outerHTML = avatarHtml(updated.avatarUrl, artist.name, "lg");
      avatarStatus.textContent = "";
      if (state.view.kind === "artist") renderMain();
    } catch (err) {
      avatarStatus.textContent = `Upload failed: ${(err as Error).message}`;
    }
  });

  const form = overlay.querySelector("#artist-edit") as HTMLFormElement;
  const status = overlay.querySelector("#artist-edit-status") as HTMLElement;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (form.querySelector('[name="name"]') as HTMLInputElement).value.trim();
    const bio = (form.querySelector('[name="bio"]') as HTMLInputElement).value.trim();
    const btn = form.querySelector("button")!;
    btn.textContent = "Saving...";
    btn.setAttribute("disabled", "true");
    try {
      await api.updateArtist(artist.id, { name, bio });
      close();
      flash(`Updated "${name}".`);
      if (state.view.kind === "artist") renderMain();
    } catch (err) {
      status.textContent = `Save failed: ${(err as Error).message}`;
      btn.textContent = "Save";
      btn.removeAttribute("disabled");
    }
  });
}

// Search-first "link this song to an artist" flow: search existing pages
// (fuzzy-ranked server-side) before offering to create a new one, so near-
// duplicate artist pages don't pile up.
function openLinkArtistModal(songId: string, songTitle: string): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>Link artist</h2>
        <button class="icon-btn" id="modal-close" title="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <p class="dz-file">${escapeHtml(songTitle)}</p>
      <input id="artist-link-search" class="search" placeholder="Search artists…" autofocus />
      <ul class="batch" id="artist-link-results"></ul>
      <button class="btn" id="create-new-artist" type="button">+ Create new artist</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#modal-close")?.addEventListener("click", close);

  const search = overlay.querySelector("#artist-link-search") as HTMLInputElement;
  const results = overlay.querySelector("#artist-link-results") as HTMLElement;

  const requestLink = async (artist: Artist) => {
    const res = await api.requestArtistLink(artist.id, songId);
    close();
    flash(
      res.ok
        ? `Requested linking "${songTitle}" to ${artist.name} — an admin will review it.`
        : `"${songTitle}" is already linked (or already has a pending request) for ${artist.name}.`,
    );
  };

  const draw = async (q?: string) => {
    const rows = q ? await api.searchArtists(q) : [];
    results.innerHTML = rows.length
      ? rows
          .map(
            (a) => `
        <li class="b-row">
          <span class="b-name">${escapeHtml(a.name)} <span class="b-stat">${a.songCount} song${a.songCount === 1 ? "" : "s"}</span></span>
          <button class="btn" data-pick="${a.id}">Link</button>
        </li>`,
          )
          .join("")
      : q
        ? `<li class="b-row"><span class="b-name">No matches — create a new page instead?</span></li>`
        : "";

    results.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const artist = rows.find((a) => a.id === (btn as HTMLElement).dataset.pick);
        if (artist) void requestLink(artist);
      });
    });
  };

  search.addEventListener("input", () => draw(search.value.trim() || undefined));

  overlay.querySelector("#create-new-artist")?.addEventListener("click", () => {
    close();
    openArtistCreateModal(search.value.trim(), (artist) => {
      void requestLink(artist);
    });
  });
}

// --- admin: duplicate review ------------------------------------------

async function renderDuplicates(el: HTMLElement): Promise<void> {
  const rows = await api.listDuplicates("pending");
  state.adminCounts.duplicates = rows.length;

  el.innerHTML = `
    <header class="main-head"><h2>Duplicate review</h2></header>
    <div id="dupe-list">${
      rows.length
        ? rows.map(dupeRowHtml).join("")
        : `<p class="empty">No possible duplicates right now.</p>`
    }</div>
  `;
  wireDuplicateActions();
}

function dupeSideHtml(s: DuplicateReview["newSong"]): string {
  return `
    <div class="dupe-side">
      <span class="song-title">${escapeHtml(s.title)}</span>
      <span class="song-artist">${escapeHtml(s.artist)}</span>
      ${s.album ? `<span class="song-dur">${escapeHtml(s.album)}</span>` : ""}
      ${s.durationS ? `<span class="song-dur">${formatTime(s.durationS)}</span>` : ""}
    </div>`;
}

function dupeRowHtml(r: DuplicateReview): string {
  return `
    <div class="dupe-row" data-review="${r.id}">
      <div class="dupe-score">${r.score}% match</div>
      <div class="dupe-compare">
        ${dupeSideHtml(r.newSong)}
        <i class="bi bi-arrow-left-right"></i>
        ${dupeSideHtml(r.existingSong)}
      </div>
      <ul class="dupe-reasons">${r.reasons.map((rn) => `<li>${escapeHtml(rn)}</li>`).join("")}</ul>
      <div class="dupe-actions">
        <button class="btn" data-different="${r.id}">Not a duplicate</button>
        <button class="btn btn-primary" data-duplicate="${r.id}">Mark duplicate</button>
      </div>
    </div>`;
}

function wireDuplicateActions(): void {
  document.querySelectorAll("[data-duplicate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.decideDuplicate((btn as HTMLElement).dataset.duplicate!, "duplicate");
      await refreshAdminCounts();
      renderSidebar();
      renderMain();
    });
  });
  document.querySelectorAll("[data-different]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.decideDuplicate((btn as HTMLElement).dataset.different!, "different");
      await refreshAdminCounts();
      renderSidebar();
      renderMain();
    });
  });
}

// --- admin: artist link requests ----------------------------------------

async function renderLinkRequests(el: HTMLElement): Promise<void> {
  const rows = await api.listLinkRequests("pending");
  state.adminCounts.linkRequests = rows.length;

  el.innerHTML = `
    <header class="main-head"><h2>Artist link requests</h2></header>
    <div id="req-list">${
      rows.length
        ? `<ul class="batch">${rows.map(reqRowHtml).join("")}</ul>`
        : `<p class="empty">No pending requests.</p>`
    }</div>
  `;
  wireLinkRequestActions();
}

function reqRowHtml(r: LinkRequest): string {
  return `
    <li class="b-row req-row">
      <span class="b-name">
        “${escapeHtml(r.songTitle)}” by ${escapeHtml(r.songArtist)} → <strong>${escapeHtml(r.artistName)}</strong>
        ${r.requestedByName ? `<span class="req-by">requested by ${escapeHtml(r.requestedByName)}</span>` : ""}
      </span>
      <div class="dupe-actions">
        <button class="btn" data-reject="${r.id}">Reject</button>
        <button class="btn btn-primary" data-approve="${r.id}">Approve</button>
      </div>
    </li>`;
}

function wireLinkRequestActions(): void {
  document.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.decideLinkRequest((btn as HTMLElement).dataset.approve!, "approve");
      await refreshAdminCounts();
      renderSidebar();
      renderMain();
    });
  });
  document.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.decideLinkRequest((btn as HTMLElement).dataset.reject!, "reject");
      await refreshAdminCounts();
      renderSidebar();
      renderMain();
    });
  });
}

// --- playlist view ---------------------------------------------------------

async function renderPlaylistView(el: HTMLElement, id: string): Promise<void> {
  const pl = await api.getPlaylist(id);
  const shownSongs = filterExplicit(pl.songs);
  state.visibleSongs = shownSongs;

  const ownerControls = pl.isOwner
    ? `
      <label class="share-toggle">
        <input type="checkbox" id="share" ${pl.isPublic ? "checked" : ""} />
        Shared
      </label>
      <button class="btn" id="del-playlist">Delete</button>`
    : `<span class="owner-tag">${avatarHtml(
        pl.ownerAvatar,
        pl.ownerName,
        "sm",
      )} ${escapeHtml(pl.ownerName ?? "unknown")}</span>`;

  const coverHtml = pl.coverUrl
    ? `<img class="playlist-cover" src="${pl.coverUrl}" alt="" />`
    : `<div class="playlist-cover playlist-cover-empty"><i class="bi bi-music-note-list"></i></div>`;

  const coverControls = pl.isOwner
    ? `<label class="btn btn-sm" for="playlist-cover-input">Change cover</label>
       <input type="file" id="playlist-cover-input" accept="image/*" hidden />`
    : "";

  el.innerHTML = `
    <header class="main-head">
      <div class="main-head-title">
        <div class="playlist-head-cover">
          ${coverHtml}
          ${coverControls}
          <span id="playlist-cover-status" class="upload-status"></span>
        </div>
        <h2>${escapeHtml(pl.name)} ${
          pl.isPublic ? `<span class="pl-badge">shared</span>` : ""
        }</h2>
      </div>
      <div class="head-actions">${ownerControls}</div>
    </header>
    <div id="songlist">${songTableHtml(shownSongs, pl.isOwner ? id : undefined)}</div>
  `;

  wireSongList(pl.isOwner ? id : undefined);

  document.getElementById("share")?.addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await api.updatePlaylist(id, { isPublic: on });
    await loadPlaylists();
    render();
  });

  document.getElementById("del-playlist")?.addEventListener("click", async () => {
    if (!confirm(`Delete "${pl.name}"?`)) return;
    await api.deletePlaylist(id);
    state.view = { kind: "library" };
    await loadPlaylists();
    render();
  });

  const coverInput = document.getElementById("playlist-cover-input") as HTMLInputElement | null;
  coverInput?.addEventListener("change", async () => {
    const file = coverInput.files?.[0];
    if (!file) return;
    const status = document.getElementById("playlist-cover-status");
    if (status) status.textContent = "Uploading...";
    try {
      await api.uploadPlaylistCover(id, file);
      await loadPlaylists();
      render();
    } catch (err) {
      if (status) status.textContent = `Upload failed: ${(err as Error).message}`;
    }
  });
}

// --- settings ----------------------------------------------------------

async function renderSettings(el: HTMLElement): Promise<void> {
  const status = await api.lastfmStatus();

  el.innerHTML = `
    <header class="main-head">
      <h2>Settings</h2>
    </header>

    <section class="settings-section">
      <h3>Last.fm</h3>
      ${
        !status.configured
          ? `<p class="empty">Last.fm scrobbling isn't set up on this server yet.</p>`
          : status.connected
            ? `
              <p>Connected as <strong>${escapeHtml(status.username ?? "")}</strong>.
                 Plays get scrobbled automatically.</p>
              <button class="btn" id="lastfm-disconnect">Disconnect</button>
            `
            : `
              <p>Connect your Last.fm account to scrobble what you play here.</p>
              <a class="btn btn-primary" href="${api.lastfmConnectUrl()}">Connect Last.fm</a>
            `
      }
      <span id="lastfm-status" class="upload-status"></span>
    </section>
  `;

  document.getElementById("lastfm-disconnect")?.addEventListener("click", async () => {
    const s = document.getElementById("lastfm-status");
    try {
      await api.lastfmDisconnect();
      await renderSettings(el);
    } catch (err) {
      if (s) s.textContent = `Something went wrong: ${(err as Error).message}`;
    }
  });
}

// --- song list -------------------------------------------------------------

function songTableHtml(songs: Song[], editablePlaylistId?: string): string {
  if (songs.length === 0) return `<p class="empty">No songs yet.</p>`;

  const rows = songs
    .map((s, i) => {
      const art = s.coverUrl
        ? `<img class="cover" src="${s.coverUrl}" alt="" />`
        : `<div class="cover cover-empty"><i class="bi bi-music-note-beamed"></i></div>`;

      // Spotify-style: cover doubles as the play button on hover.
      const cover = `
        <div class="song-cover">
          ${art}
          <button class="cover-play" data-play="${i}" title="Play">
            <i class="bi bi-play-fill"></i>
          </button>
        </div>`;

      const action = editablePlaylistId
        ? `<button class="icon-btn" data-remove="${s.id}" title="Remove"><i class="bi bi-x-lg"></i></button>`
        : `<button class="icon-btn" data-add="${s.id}" title="Add to playlist"><i class="bi bi-plus-lg"></i></button>`;

      const linkArtist = `<button class="icon-btn" data-link-artist="${s.id}" title="Link artist"><i class="bi bi-person-plus"></i></button>`;

      const edit = state.me?.isAdmin
        ? `<button class="icon-btn" data-edit="${s.id}" title="Edit details"><i class="bi bi-pencil-fill"></i></button>`
        : "";
      const del =
        s.uploadedBy && s.uploadedBy === state.me?.id
          ? `<button class="icon-btn" data-del="${s.id}" title="Delete song"><i class="bi bi-trash-fill"></i></button>`
          : "";

      const badge = s.explicit
        ? `<span class="tag-e" title="Explicit">E</span>`
        : "";

      return `
        <div class="song" data-index="${i}">
          ${cover}
          <div class="song-meta">
            <span class="song-title">${escapeHtml(s.title)}${badge}</span>
            <span class="song-artist">${escapeHtml(s.artist)}</span>
          </div>
          <span class="song-dur">${s.durationS ? formatTime(s.durationS) : ""}</span>
          <div class="song-actions">${action}${linkArtist}${edit}${del}</div>
        </div>`;
    })
    .join("");

  return `<div class="songs">${rows}</div>`;
}

function wireSongList(editablePlaylistId?: string): void {
  // Play from the cover's hover button (no more whole-row misclicks).
  document.querySelectorAll(".cover-play").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      player.playQueue(state.visibleSongs, Number((btn as HTMLElement).dataset.play));
    });
  });

  // Double-clicking the row also plays, Spotify-style.
  document.querySelectorAll(".song").forEach((row) => {
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".song-actions")) return;
      player.playQueue(state.visibleSongs, Number((row as HTMLElement).dataset.index));
    });
  });

  document.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const songId = (btn as HTMLElement).dataset.add!;
      const target = await pickPlaylist();
      if (target) await api.addToPlaylist(target, songId);
    });
  });

  document.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!editablePlaylistId) return;
      await api.removeFromPlaylist(editablePlaylistId, (btn as HTMLElement).dataset.remove!);
      renderMain();
    });
  });

  document.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.edit!;
      const song = state.visibleSongs.find((s) => s.id === id);
      if (song) openEditModal(song);
    });
  });

  document.querySelectorAll("[data-link-artist]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const songId = (btn as HTMLElement).dataset.linkArtist!;
      const song = state.visibleSongs.find((s) => s.id === songId);
      openLinkArtistModal(songId, song?.title ?? "");
    });
  });

  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this song for everyone?")) return;
      await api.deleteSong((btn as HTMLElement).dataset.del!);
      await loadSongs();
      renderMain();
    });
  });
}

async function pickPlaylist(): Promise<string | null> {
  const mine = state.playlists;
  if (mine.length === 0) {
    flash("Create a playlist first.");
    return null;
  }
  return openPlaylistPickerModal(mine);
}

// Simple fuzzy filter for small in-memory lists (playlists, etc). Exact
// substring matches always win; otherwise falls back to a bigram
// dice-coefficient so "1800" still finds "1-800"-style names, and small
// typos don't come back empty.
function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const normQ = q.replace(/[^a-z0-9]+/g, " ").trim();
  const tightQ = q.replace(/[^a-z0-9]+/g, "");

  return items
    .map((item) => {
      const raw = key(item).toLowerCase();
      const norm = raw.replace(/[^a-z0-9]+/g, " ").trim();
      const tight = raw.replace(/[^a-z0-9]+/g, "");
      const score =
        tight === tightQ || norm.includes(normQ) ? 1 : diceCoefficient(normQ, norm);
      return { item, score };
    })
    .filter((r) => r.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

// Sørensen–Dice coefficient over character bigrams, mirrored from the
// server's lib/text.ts (kept tiny + dependency-free for client-side use).
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  let intersection = 0;
  for (const [gram, count] of aGrams) {
    const other = bGrams.get(gram);
    if (other) intersection += Math.min(count, other);
  }
  const total =
    [...aGrams.values()].reduce((s, n) => s + n, 0) +
    [...bGrams.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * intersection) / total;
}

// --- player bar ------------------------------------------------------------

let pbSongId: string | null = null;
let seeking = false; // true while the user drags the seek slider

// Rebuild the bar only when the track changes; otherwise just update the
// dynamic bits. Re-rendering on every timeupdate would kill slider dragging
// (which is why volume/seek felt broken).
function renderPlayerBar(): void {
  const el = document.getElementById("playerbar");
  if (!el) return;

  const song = player.current;
  if (!song) {
    el.innerHTML = `<div class="pb-empty">Nothing playing</div>`;
    pbSongId = null;
    return;
  }

  if (song.id !== pbSongId || !el.querySelector(".pb-controls")) {
    mountPlayerBar(el, song);
    pbSongId = song.id;
  }
  updatePlayerBar();
}

function mountPlayerBar(el: HTMLElement, song: Song): void {
  el.innerHTML = `
    <div class="pb-song">
      <div class="pb-cover">
        ${
          song.coverUrl
            ? `<img class="cover" src="${song.coverUrl}" alt="" />`
            : `<div class="cover cover-empty"><i class="bi bi-music-note-beamed"></i></div>`
        }
        <canvas class="pb-viz" id="pb-viz"></canvas>
      </div>
      <div class="song-meta">
        <span class="song-title">${escapeHtml(song.title)}</span>
        <span class="song-artist">${escapeHtml(song.artist)}</span>
      </div>
    </div>

    <div class="pb-controls">
      <div class="pb-buttons">
        <button class="icon-btn" id="shuffle" title="Shuffle"><i class="bi bi-shuffle"></i></button>
        <button class="icon-btn" id="prev" title="Previous"><i class="bi bi-skip-start-fill"></i></button>
        <button class="icon-btn play" id="toggle"><i class="bi bi-play-fill"></i></button>
        <button class="icon-btn" id="next" title="Next"><i class="bi bi-skip-end-fill"></i></button>
        <button class="icon-btn" id="repeat" title="Repeat"><i class="bi bi-repeat"></i></button>
      </div>
      <div class="pb-seek">
        <button class="icon-btn pb-lyrics" id="lyrics-btn" title="Lyrics"><i class="bi bi-card-text"></i></button>
        <span class="pb-cur">0:00</span>
        <input type="range" id="seek" min="0" max="0" value="0" step="0.1" style="--pct:0%" />
        <span class="pb-dur">0:00</span>
      </div>
    </div>

    ${
      player.volumeSupported
        ? `<div class="pb-volume">
      <button class="icon-btn" id="mute" title="Mute"><i class="bi bi-volume-up-fill"></i></button>
      <input type="range" id="volume" min="0" max="1" step="0.01"
             value="${player.volume}" style="--pct:${player.volume * 100}%" />
    </div>`
        : ""
    }
  `;

  el.querySelector("#toggle")?.addEventListener("click", () => player.toggle());
  el.querySelector("#next")?.addEventListener("click", () => player.next());
  el.querySelector("#prev")?.addEventListener("click", () => player.prev());
  el.querySelector("#shuffle")?.addEventListener("click", () => player.toggleShuffle());
  el.querySelector("#repeat")?.addEventListener("click", () => player.cycleRepeat());

  const seek = el.querySelector("#seek") as HTMLInputElement | null;
  seek?.addEventListener("input", () => {
    seeking = true;
    const max = Number(seek.max) || 1;
    seek.style.setProperty("--pct", `${(Number(seek.value) / max) * 100}%`);
  });
  seek?.addEventListener("change", () => {
    player.seek(Number(seek.value));
    seeking = false;
  });

  const vol = el.querySelector("#volume") as HTMLInputElement | null;
  vol?.addEventListener("input", () => {
    player.setVolume(Number(vol.value));
    vol.style.setProperty("--pct", `${Number(vol.value) * 100}%`);
    updateVolumeIcon();
  });

  el.querySelector("#mute")?.addEventListener("click", () => {
    const next = player.volume > 0 ? 0 : 1;
    player.setVolume(next);
    if (vol) {
      vol.value = String(next);
      vol.style.setProperty("--pct", `${next * 100}%`);
    }
    updateVolumeIcon();
  });

  el.querySelector("#lyrics-btn")?.addEventListener("click", toggleLyrics);
}

// Update only the changing pieces — never rebuild (keeps sliders draggable).
function updatePlayerBar(): void {
  const el = document.getElementById("playerbar");
  if (!el) return;

  const toggle = el.querySelector("#toggle i");
  if (toggle) toggle.className = player.playing ? "bi bi-pause-fill" : "bi bi-play-fill";

  el.querySelector("#shuffle")?.classList.toggle("on", player.shuffle);

  const repeatBtn = el.querySelector("#repeat");
  const repeatIcon = el.querySelector("#repeat i");
  if (repeatBtn && repeatIcon) {
    repeatBtn.classList.toggle("on", player.repeat !== "off");
    repeatIcon.className = player.repeat === "one" ? "bi bi-repeat-1" : "bi bi-repeat";
    (repeatBtn as HTMLElement).title = `Repeat: ${player.repeat}`;
  }

  const { current, duration } = player.progress;
  const cur = el.querySelector(".pb-cur");
  const dur = el.querySelector(".pb-dur");
  if (cur) cur.textContent = formatTime(current);
  if (dur) dur.textContent = formatTime(duration);

  const seek = el.querySelector("#seek") as HTMLInputElement | null;
  if (seek && !seeking) {
    seek.max = String(duration || 0);
    seek.value = String(current);
    seek.style.setProperty("--pct", `${duration ? (current / duration) * 100 : 0}%`);
  }

  el.querySelector("#lyrics-btn")?.classList.toggle("on", lyricsState.open);

  updateVolumeIcon();
}

// Frequency-bar visualizer painted behind the player bar while a track plays.
function startVisualizer(): void {
  const draw = () => {
    const canvas = document.getElementById("pb-viz") as HTMLCanvasElement | null;
    const analyser = player.getAnalyser();
    if (canvas && analyser) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const w = (canvas.width = canvas.clientWidth);
        const h = (canvas.height = canvas.clientHeight);
        ctx.clearRect(0, 0, w, h);
        if (player.playing) {
          const bins = analyser.frequencyBinCount;
          const data = new Uint8Array(bins);
          analyser.getByteFrequencyData(data);
          // Dim the art a touch so the bars read on top of it.
          ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
          ctx.fillRect(0, 0, w, h);
          const n = 14;
          const bw = w / n;
          ctx.fillStyle = "rgba(120, 200, 140, 0.95)"; // green equalizer
          for (let i = 0; i < n; i++) {
            const idx = Math.floor((i / n) * bins);
            const bh = Math.max(2, (data[idx]! / 255) * h);
            ctx.fillRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh);
          }
        }
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

function updateVolumeIcon(): void {
  const icon = document.querySelector("#mute i");
  if (!icon) return;
  const v = player.volume;
  icon.className =
    v === 0
      ? "bi bi-volume-mute-fill"
      : v < 0.5
        ? "bi bi-volume-down-fill"
        : "bi bi-volume-up-fill";
}

// --- lyrics ----------------------------------------------------------------

const lyricsState = {
  open: false,
  songId: null as string | null,
  data: null as Lyrics | null,
  active: -1,
};

function toggleLyrics(): void {
  lyricsState.open = !lyricsState.open;
  if (lyricsState.open) {
    renderLyricsOverlay();
    void loadLyricsForCurrent();
  } else {
    document.getElementById("lyrics-overlay")?.remove();
  }
  document.getElementById("lyrics-btn")?.classList.toggle("on", lyricsState.open);
}

function renderLyricsOverlay(): void {
  let ov = document.getElementById("lyrics-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "lyrics-overlay";
    ov.className = "lyrics-overlay";
    document.body.appendChild(ov);
  }
  const song = player.current;
  ov.innerHTML = `
    <div class="ly-head">
      <div class="ly-song">
        <span class="ly-title">${song ? escapeHtml(song.title) : "—"}</span>
        <span class="ly-artist">${song ? escapeHtml(song.artist) : ""}</span>
      </div>
      <button class="icon-btn" id="ly-close" title="Close"><i class="bi bi-x-lg"></i></button>
    </div>
    <div class="ly-body" id="ly-body"><p class="ly-note">Finding lyrics…</p></div>
  `;
  ov.querySelector("#ly-close")?.addEventListener("click", toggleLyrics);
}

async function loadLyricsForCurrent(): Promise<void> {
  const song = player.current;
  const body = document.getElementById("ly-body");
  if (!song) {
    if (body) body.innerHTML = `<p class="ly-note">Play a song to see lyrics.</p>`;
    return;
  }
  lyricsState.songId = song.id;
  lyricsState.data = null;
  lyricsState.active = -1;
  try {
    lyricsState.data = await api.getLyrics(song.id);
  } catch {
    lyricsState.data = null;
  }
  // Bail if the user closed the panel or skipped tracks while we fetched.
  if (!lyricsState.open || player.current?.id !== song.id) return;
  renderLyricsBody();
}

function renderLyricsBody(): void {
  const body = document.getElementById("ly-body");
  if (!body) return;
  const d = lyricsState.data;

  if (!d || (!d.synced.length && !d.plain && !d.instrumental)) {
    body.className = "ly-body";
    body.innerHTML = `<p class="ly-note">No lyrics found for this one.</p>`;
    return;
  }
  if (d.instrumental) {
    body.className = "ly-body";
    body.innerHTML = `<p class="ly-note"><i class="bi bi-music-note-beamed"></i> Instrumental</p>`;
    return;
  }
  if (d.synced.length) {
    body.className = "ly-body is-synced";
    body.innerHTML = d.synced
      .map((l, i) => `<p class="ly-line" data-i="${i}">${escapeHtml(l.text || " ")}</p>`)
      .join("");
    return;
  }
  body.className = "ly-body";
  body.innerHTML = (d.plain ?? "")
    .split(/\r?\n/)
    .map((l) => `<p class="ly-line ly-static">${escapeHtml(l || " ")}</p>`)
    .join("");
}

// Called on every player tick: highlight + center the active synced line.
function syncLyrics(): void {
  if (!lyricsState.open) return;
  const song = player.current;
  if (!song) return;

  if (song.id !== lyricsState.songId) {
    renderLyricsOverlay();
    void loadLyricsForCurrent();
    return;
  }

  const d = lyricsState.data;
  if (!d || !d.synced.length) return;

  const posMs = player.progress.current * 1000;
  let i = -1;
  for (let k = 0; k < d.synced.length; k++) {
    if (d.synced[k]!.t <= posMs) i = k;
    else break;
  }
  if (i === lyricsState.active) return;

  const body = document.getElementById("ly-body");
  if (!body) return;
  const kids = body.children;
  if (lyricsState.active >= 0 && kids[lyricsState.active]) {
    kids[lyricsState.active]!.classList.remove("is-active");
  }
  lyricsState.active = i;
  const cur = kids[i] as HTMLElement | undefined;
  if (cur) {
    cur.classList.add("is-active");
    body.scrollTo({
      top: cur.offsetTop - body.clientHeight / 2 + cur.clientHeight / 2,
      behavior: "smooth",
    });
  }
}

// --- utils -----------------------------------------------------------------

function activePlaylist(id: string): boolean {
  return state.view.kind === "playlist" && state.view.id === id;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

void boot();