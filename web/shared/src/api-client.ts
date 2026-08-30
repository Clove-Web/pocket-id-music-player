// Typed wrapper around the JSON API. Requests are same-origin (empty base)
// by default, which is what the web app wants. The desktop app calls
// configureApiBase() once at startup with the user-configured server URL.

import type {
  Song,
  PendingSong,
  SongEditRequest,
  Playlist,
  PlaylistDetail,
  PublicPlaylist,
  Me,
  LastfmStatus,
  Artist,
  ArtistDetail,
  LinkRequest,
  DuplicateReview,
  Lyrics,
} from "./types.ts";

let baseUrl = "";
let authToken: string | null = null;

// Call once at startup. Web leaves this as "" (same-origin). Desktop calls
// it with the self-hosted server URL the user enters on first run.
export function configureApiBase(newBaseUrl: string): void {
  baseUrl = newBaseUrl.replace(/\/$/, "");
}

// Native clients (desktop / mobile) have no shared cookie with the server,
// so they authenticate with a bearer token obtained via the deeplink flow
// (see startNativeLogin / completeNativeLogin below). Web leaves this null
// and relies on the httpOnly session cookie instead. Pass null to clear it
// on logout.
export function configureAuthToken(token: string | null): void {
  authToken = token;
}

function url(path: string): string {
  return `${baseUrl}${path}`;
}

// Resolve an API path to an ABSOLUTE url (scheme + host). Most calls use
// same-origin relative urls, but some consumers need a full url that resolves
// off-device — e.g. an album cover handed to Discord Rich Presence, which
// Discord fetches from its own servers, not the user's machine. Uses the
// configured base (desktop) or the current origin (web / remote-loaded shell).
export function absoluteApiUrl(path: string): string {
  const base =
    baseUrl || (typeof location !== "undefined" ? location.origin : "");
  return `${base}${path}`;
}

// Every request in this module goes through this wrapper (it shadows the
// global `fetch`). It attaches the bearer token when one is set (native
// clients). Web sets no token and keeps fetch's default same-origin
// credentials, so its session cookie rides along as before. Credentials are
// deliberately NOT forced to "include": native auth is header-based, and
// forcing it would drag the whole request into CORS-with-credentials.
// Bodies (incl. FormData) are untouched.
function fetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!authToken) return globalThis.fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${authToken}`);
  return globalThis.fetch(input, { ...init, headers });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// --- native (deeplink) login ----------------------------------------------
// RFC 8252 flow for desktop / mobile: auth runs in the *system* browser, then
// returns to the app via a doughmination:// deeplink carrying a one-time
// code. The verifier below never leaves the device — it's what stops another
// app that hijacks the scheme from redeeming an intercepted code.

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

// Step 1: build the system-browser login URL and hold onto the verifier.
// The caller opens `url` in the OS browser (NOT the app webview) and keeps
// `verifier` for step 2.
export async function startNativeLogin(opts?: {
  redirect?: string;
}): Promise<{ url: string; verifier: string }> {
  const verifier = randomVerifier();
  const challenge = await pkceChallenge(verifier);
  // Absolute when a base URL is configured (desktop); otherwise resolve against
  // the current origin (mobile SPA served from the server).
  const fallbackBase =
    typeof location !== "undefined" ? location.origin : undefined;
  const u = new URL(url("/api/auth/login"), baseUrl || fallbackBase);
  u.searchParams.set("mode", "native");
  u.searchParams.set("app_challenge", challenge);
  if (opts?.redirect) u.searchParams.set("redirect", opts.redirect);
  return { url: u.toString(), verifier };
}

// Ask the server to set the session cookie for the current bearer token. Used
// by same-origin native clients so <audio>/<img> media (which can't send the
// Authorization header) authenticate via the cookie instead. No-op-ish on web.
export async function establishSessionCookie(): Promise<void> {
  await fetch(url("/api/auth/session-cookie"), { method: "POST" });
}

// Step 2: after the deeplink fires, trade its `code` (+ the saved verifier)
// for a session token, then wire it into the client. Returns the token so
// the caller can persist it in secure storage.
export async function completeNativeLogin(
  code: string,
  verifier: string,
): Promise<string> {
  const res = await fetch(url("/api/auth/native/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  const { token } = await json<{ token: string }>(res);
  configureAuthToken(token);
  return token;
}

export const api = {
  async me(): Promise<Me | null> {
    const res = await fetch(url("/api/me"));
    const data = await json<{ user: Me | null }>(res);
    return data.user;
  },

  async logout(): Promise<Response> {
    const res = await fetch(url("/api/auth/logout"), { method: "POST" });
    configureAuthToken(null); // drop the native bearer token, if any
    return res;
  },

  listSongs(query?: string): Promise<Song[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(url(`/api/songs${qs}`)).then(json<Song[]>);
  },

  getSong(id: string): Promise<Song> {
    return fetch(url(`/api/songs/${id}`)).then(json<Song>);
  },

  uploadSong(form: FormData): Promise<Song> {
    return fetch(url("/api/songs"), { method: "POST", body: form }).then(json<Song>);
  },

  // Import a single YouTube video's audio via server-side yt-dlp. Optional
  // title/artist/album/explicit override what yt-dlp reads from the video.
  async importSong(body: {
    url: string;
    title?: string;
    artist?: string;
    album?: string;
    explicit?: boolean;
  }): Promise<Song> {
    const res = await fetch(url("/api/songs/import"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as Song;

    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    const friendly: Record<string, string> = {
      youtube_import_disabled: "YouTube import is turned off on this server.",
      ytdlp_unavailable: "yt-dlp isn't installed on the server.",
      unsupported_url: "Only youtube.com and youtu.be links are supported.",
      url_required: "Paste a YouTube link first.",
      file_too_large: "That video's audio is over the upload size limit.",
      timed_out: "The download took too long and was stopped.",
      title_and_artist_required:
        "Couldn't read a title/artist — fill them in and retry.",
      download_failed: "yt-dlp couldn't download that video.",
    };
    throw new Error(
      (data.error && friendly[data.error]) ||
        data.detail ||
        data.error ||
        `${res.status} ${res.statusText}`,
    );
  },

  updateSong(id: string, form: FormData): Promise<Song> {
    return fetch(url(`/api/songs/${id}`), { method: "PATCH", body: form }).then(
      json<Song>,
    );
  },

  deleteSong(id: string): Promise<Response> {
    return fetch(url(`/api/songs/${id}`), { method: "DELETE" });
  },

  // --- liked songs -----------------------------------------------------

  listLiked(): Promise<Song[]> {
    return fetch(url("/api/songs/liked")).then(json<Song[]>);
  },

  likeSong(id: string): Promise<Response> {
    return fetch(url(`/api/songs/${id}/like`), { method: "PUT" });
  },

  unlikeSong(id: string): Promise<Response> {
    return fetch(url(`/api/songs/${id}/like`), { method: "DELETE" });
  },

  // --- admin: upload approval ----------------------------------------

  listPendingSongs(): Promise<PendingSong[]> {
    return fetch(url("/api/songs/pending")).then(json<PendingSong[]>);
  },

  decidePendingSong(id: string, action: "approve" | "reject"): Promise<Response> {
    return fetch(url(`/api/songs/${id}/${action}`), { method: "POST" });
  },

  // --- metadata edit requests --------------------------------------

  requestSongEdit(
    id: string,
    patch: { title?: string; artist?: string; album?: string; explicit?: boolean },
  ): Promise<Response> {
    return fetch(url(`/api/songs/${id}/edit-requests`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  listSongEditRequests(status = "pending"): Promise<SongEditRequest[]> {
    return fetch(url(`/api/songs/edit-requests?status=${status}`)).then(
      json<SongEditRequest[]>,
    );
  },

  decideSongEditRequest(id: string, action: "approve" | "reject"): Promise<Response> {
    return fetch(url(`/api/songs/edit-requests/${id}/${action}`), { method: "POST" });
  },

  getLyrics(songId: string): Promise<Lyrics> {
    return fetch(url(`/api/songs/${songId}/lyrics`)).then(json<Lyrics>);
  },

  listPlaylists(): Promise<Playlist[]> {
    return fetch(url("/api/playlists")).then(json<Playlist[]>);
  },

  createPlaylist(name: string): Promise<Playlist> {
    return fetch(url("/api/playlists"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json<Playlist>);
  },

  getPlaylist(id: string): Promise<PlaylistDetail> {
    return fetch(url(`/api/playlists/${id}`)).then(json<PlaylistDetail>);
  },

  searchPublicPlaylists(query?: string): Promise<PublicPlaylist[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(url(`/api/playlists/public${qs}`)).then(json<PublicPlaylist[]>);
  },

  updatePlaylist(
    id: string,
    patch: { name?: string; isPublic?: boolean },
  ): Promise<Playlist> {
    return fetch(url(`/api/playlists/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Playlist>);
  },

  deletePlaylist(id: string): Promise<Response> {
    return fetch(url(`/api/playlists/${id}`), { method: "DELETE" });
  },

  uploadPlaylistCover(id: string, file: File): Promise<Playlist> {
    const fd = new FormData();
    fd.set("cover", file);
    return fetch(url(`/api/playlists/${id}/cover`), {
      method: "POST",
      body: fd,
    }).then(json<Playlist>);
  },

  addToPlaylist(playlistId: string, songId: string): Promise<Response> {
    return fetch(url(`/api/playlists/${playlistId}/songs`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songId }),
    });
  },

  removeFromPlaylist(playlistId: string, songId: string): Promise<Response> {
    return fetch(url(`/api/playlists/${playlistId}/songs/${songId}`), {
      method: "DELETE",
    });
  },

  // --- artists -----------------------------------------------------------

  searchArtists(query?: string): Promise<Artist[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(url(`/api/artists${qs}`)).then(json<Artist[]>);
  },

  getArtist(id: string): Promise<ArtistDetail> {
    return fetch(url(`/api/artists/${id}`)).then(json<ArtistDetail>);
  },

  // Not a generic throw-on-error call: an "artist already exists" response
  // is an expected outcome the caller needs to react to (offer to link to
  // the existing page instead), not an exceptional failure.
  async createArtist(
    name: string,
    bio?: string,
  ): Promise<
    { ok: true; artist: Artist } | { ok: false; status: number; existing: Artist | null }
  > {
    const res = await fetch(url("/api/artists"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, bio }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      artist?: Artist;
    };
    if (res.ok) return { ok: true, artist: data as unknown as Artist };
    return { ok: false, status: res.status, existing: data.artist ?? null };
  },

  updateArtist(id: string, patch: { name?: string; bio?: string }): Promise<Artist> {
    return fetch(url(`/api/artists/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Artist>);
  },

  uploadArtistAvatar(id: string, file: File): Promise<Artist> {
    const fd = new FormData();
    fd.set("avatar", file);
    return fetch(url(`/api/artists/${id}/avatar`), {
      method: "POST",
      body: fd,
    }).then(json<Artist>);
  },

  mergeArtists(sourceId: string, targetId: string): Promise<Artist> {
    return fetch(url("/api/artists/merge"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, targetId }),
    }).then(json<Artist>);
  },

  async requestArtistLink(
    artistId: string,
    songId: string,
    role?: string,
  ): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(url(`/api/artists/${artistId}/link-requests`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songId, role }),
    });
    return { ok: res.ok, status: res.status };
  },

  listLinkRequests(status = "pending"): Promise<LinkRequest[]> {
    return fetch(url(`/api/artists/link-requests?status=${status}`)).then(
      json<LinkRequest[]>,
    );
  },

  decideLinkRequest(id: string, action: "approve" | "reject"): Promise<Response> {
    return fetch(url(`/api/artists/link-requests/${id}/${action}`), {
      method: "POST",
    });
  },

  // --- duplicate review (admin) -------------------------------------------

  listDuplicates(status = "pending"): Promise<DuplicateReview[]> {
    return fetch(url(`/api/duplicates?status=${status}`)).then(
      json<DuplicateReview[]>,
    );
  },

  decideDuplicate(id: string, action: "duplicate" | "different"): Promise<Response> {
    return fetch(url(`/api/duplicates/${id}/${action}`), { method: "POST" });
  },

  // --- Last.fm -------------------------------------------------------------

  lastfmStatus(): Promise<LastfmStatus> {
    return fetch(url("/api/lastfm/status")).then(json<LastfmStatus>);
  },

  // Not fetched — Last.fm's own auth page needs a real browser navigation,
  // not an XHR/fetch redirect.
  lastfmConnectUrl(): string {
    return url("/api/lastfm/connect");
  },

  lastfmDisconnect(): Promise<Response> {
    return fetch(url("/api/lastfm/disconnect"), { method: "POST" });
  },

  lastfmNowPlaying(track: {
    title: string;
    artist: string;
    album?: string | null;
    durationS?: number | null;
  }): Promise<Response> {
    return fetch(url("/api/lastfm/now-playing"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(track),
    });
  },

  lastfmScrobble(track: {
    title: string;
    artist: string;
    album?: string | null;
    durationS?: number | null;
    startedAt: number;
  }): Promise<Response> {
    return fetch(url("/api/lastfm/scrobble"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(track),
    });
  },
};
