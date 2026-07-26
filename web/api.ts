// Typed wrappers around the JSON API.

export type Song = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  explicit: boolean;
  coverUrl: string | null;
  streamUrl: string;
  uploadedBy: string | null;
};

export type Playlist = {
  id: string;
  name: string;
  isPublic: boolean;
  coverUrl: string | null;
};

export type PlaylistDetail = Playlist & {
  isOwner: boolean;
  ownerName: string | null;
  ownerAvatar: string | null;
  songs: Song[];
};

export type PublicPlaylist = {
  id: string;
  name: string;
  ownerName: string | null;
  ownerAvatar: string | null;
  coverUrl: string | null;
  songCount: number;
};

export type Me = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  lastfmConnected: boolean;
  lastfmUsername: string | null;
};

export type LastfmStatus = {
  configured: boolean;
  connected: boolean;
  username: string | null;
};

export type Artist = {
  id: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  songCount: number;
  createdAt: string;
};

export type ArtistSong = Song & { role: string };

export type ArtistDetail = Artist & {
  songs: ArtistSong[];
};

export type LinkRequest = {
  id: string;
  songId: string;
  songTitle: string;
  songArtist: string;
  artistId: string;
  artistName: string;
  role: string;
  requestedByName: string | null;
  status: string;
  createdAt: string;
};

export type DuplicateSongSide = {
  id: string | null;
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  coverUrl: string | null;
  streamUrl: string | null;
};

export type DuplicateReview = {
  id: string;
  score: number;
  reasons: string[];
  status: string;
  createdAt: string;
  newSong: DuplicateSongSide;
  existingSong: DuplicateSongSide;
};

export type SyncedLine = { t: number; text: string };

export type Lyrics = {
  instrumental: boolean;
  synced: SyncedLine[];
  plain: string | null;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async me(): Promise<Me | null> {
    const res = await fetch("/api/me");
    const data = await json<{ user: Me | null }>(res);
    return data.user;
  },

  logout(): Promise<Response> {
    return fetch("/api/auth/logout", { method: "POST" });
  },

  listSongs(query?: string): Promise<Song[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(`/api/songs${qs}`).then(json<Song[]>);
  },

  uploadSong(form: FormData): Promise<Song> {
    return fetch("/api/songs", { method: "POST", body: form }).then(json<Song>);
  },

  updateSong(id: string, form: FormData): Promise<Song> {
    return fetch(`/api/songs/${id}`, { method: "PATCH", body: form }).then(
      json<Song>,
    );
  },

  deleteSong(id: string): Promise<Response> {
    return fetch(`/api/songs/${id}`, { method: "DELETE" });
  },

  getLyrics(songId: string): Promise<Lyrics> {
    return fetch(`/api/songs/${songId}/lyrics`).then(json<Lyrics>);
  },

  listPlaylists(): Promise<Playlist[]> {
    return fetch("/api/playlists").then(json<Playlist[]>);
  },

  createPlaylist(name: string): Promise<Playlist> {
    return fetch("/api/playlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json<Playlist>);
  },

  getPlaylist(id: string): Promise<PlaylistDetail> {
    return fetch(`/api/playlists/${id}`).then(json<PlaylistDetail>);
  },

  searchPublicPlaylists(query?: string): Promise<PublicPlaylist[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(`/api/playlists/public${qs}`).then(json<PublicPlaylist[]>);
  },

  updatePlaylist(
    id: string,
    patch: { name?: string; isPublic?: boolean },
  ): Promise<Playlist> {
    return fetch(`/api/playlists/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Playlist>);
  },

  deletePlaylist(id: string): Promise<Response> {
    return fetch(`/api/playlists/${id}`, { method: "DELETE" });
  },

  uploadPlaylistCover(id: string, file: File): Promise<Playlist> {
    const fd = new FormData();
    fd.set("cover", file);
    return fetch(`/api/playlists/${id}/cover`, {
      method: "POST",
      body: fd,
    }).then(json<Playlist>);
  },

  addToPlaylist(playlistId: string, songId: string): Promise<Response> {
    return fetch(`/api/playlists/${playlistId}/songs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songId }),
    });
  },

  removeFromPlaylist(playlistId: string, songId: string): Promise<Response> {
    return fetch(`/api/playlists/${playlistId}/songs/${songId}`, {
      method: "DELETE",
    });
  },

  // --- artists -----------------------------------------------------------

  searchArtists(query?: string): Promise<Artist[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return fetch(`/api/artists${qs}`).then(json<Artist[]>);
  },

  getArtist(id: string): Promise<ArtistDetail> {
    return fetch(`/api/artists/${id}`).then(json<ArtistDetail>);
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
    const res = await fetch("/api/artists", {
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
    return fetch(`/api/artists/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Artist>);
  },

  uploadArtistAvatar(id: string, file: File): Promise<Artist> {
    const fd = new FormData();
    fd.set("avatar", file);
    return fetch(`/api/artists/${id}/avatar`, {
      method: "POST",
      body: fd,
    }).then(json<Artist>);
  },

  mergeArtists(sourceId: string, targetId: string): Promise<Artist> {
    return fetch("/api/artists/merge", {
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
    const res = await fetch(`/api/artists/${artistId}/link-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songId, role }),
    });
    return { ok: res.ok, status: res.status };
  },

  listLinkRequests(status = "pending"): Promise<LinkRequest[]> {
    return fetch(`/api/artists/link-requests?status=${status}`).then(
      json<LinkRequest[]>,
    );
  },

  decideLinkRequest(id: string, action: "approve" | "reject"): Promise<Response> {
    return fetch(`/api/artists/link-requests/${id}/${action}`, {
      method: "POST",
    });
  },

  // --- duplicate review (admin) -------------------------------------------

  listDuplicates(status = "pending"): Promise<DuplicateReview[]> {
    return fetch(`/api/duplicates?status=${status}`).then(
      json<DuplicateReview[]>,
    );
  },

  decideDuplicate(id: string, action: "duplicate" | "different"): Promise<Response> {
    return fetch(`/api/duplicates/${id}/${action}`, { method: "POST" });
  },

  // --- Last.fm -------------------------------------------------------------

  lastfmStatus(): Promise<LastfmStatus> {
    return fetch("/api/lastfm/status").then(json<LastfmStatus>);
  },

  // Not fetched — Last.fm's own auth page needs a real browser navigation,
  // not an XHR/fetch redirect.
  lastfmConnectUrl(): string {
    return "/api/lastfm/connect";
  },

  lastfmDisconnect(): Promise<Response> {
    return fetch("/api/lastfm/disconnect", { method: "POST" });
  },

  lastfmNowPlaying(track: {
    title: string;
    artist: string;
    album?: string | null;
    durationS?: number | null;
  }): Promise<Response> {
    return fetch("/api/lastfm/now-playing", {
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
    return fetch("/api/lastfm/scrobble", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(track),
    });
  },
};