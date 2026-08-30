// Shared response/DTO shapes used by both the API client and every
// consumer of it (web app, desktop app, and eventually the server routes
// that produce these shapes).

export type Song = {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  album: string | null;
  durationS: number | null;
  explicit: boolean;
  coverUrl: string | null;
  streamUrl: string;
  uploadedBy: string | null;
  // Present on library / liked / single-song responses; omitted from the
  // trimmed song shape inside playlist + artist detail payloads.
  downloadUrl?: string;
  status?: "pending" | "approved" | "rejected";
};

// A pending upload awaiting admin approval, with who uploaded it.
export type PendingSong = Song & { uploaderName: string | null };

// A non-admin's proposed metadata fix, awaiting admin approval.
export type SongEditRequest = {
  id: string;
  songId: string;
  current: { title: string; artist: string; album: string | null; explicit: boolean };
  proposed: {
    title: string | null;
    artist: string | null;
    album: string | null;
    explicit: boolean | null;
  };
  requestedByName: string | null;
  status: string;
  createdAt: string;
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
