// App entrypoint. Wires middleware + routes, serves the built frontend.

import { join } from "node:path";

import { Hono } from "hono";
import { cors } from "hono/cors";

import { config } from "./config.ts";
import {
  loadUser,
  isAdmin,
  type AppEnv,
} from "./auth/middleware.ts";
import {
  resolveDownload,
  versionNames,
  platformNames,
} from "./lib/downloads.ts";
import { ensureMediaDirs, mimeForAudioPath } from "./lib/media.ts";
import { startPocketIdGuard } from "./lib/pocketid-guard.ts";
import { authRoutes } from "./routes/auth.ts";
import {
  songRoutes,
  getSong,
  canSee,
  serveSongDownload,
} from "./routes/songs.ts";
import { playlistRoutes } from "./routes/playlists.ts";
import { artistRoutes, getArtist } from "./routes/artists.ts";
import { duplicateRoutes } from "./routes/duplicates.ts";
import { lastfmRoutes } from "./routes/lastfm.ts";

await ensureMediaDirs();
startPocketIdGuard();

const app = new Hono<AppEnv>();

// Allow the native apps' webviews to call the API cross-origin. They use
// bearer tokens, not cookies, so this runs without credentials — web is
// same-origin and never hits CORS at all. Only allowlisted origins pass.
app.use(
  "/api/*",
  cors({
    origin: (origin) =>
      config.nativeOrigins.includes(origin) ? origin : null,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
);

// Every request gets the current user (or null) attached.
app.use("*", loadUser);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar_url,
      isAdmin: isAdmin(user),
      lastfmConnected: Boolean(user.lastfm_session_key),
      lastfmUsername: user.lastfm_username,
    },
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/songs", songRoutes);
app.route("/api/playlists", playlistRoutes);
app.route("/api/artists", artistRoutes);
app.route("/api/duplicates", duplicateRoutes);
app.route("/api/lastfm", lastfmRoutes);

// Resolved against this file's location (not process.cwd()) so `bun run
// src/server.ts` behaves the same whether it's launched from the repo
// root, from web/server, or from inside a Docker image — the web client
// (web/client) is a sibling workspace package, not a subfolder.
// We use Bun.file() directly rather than hono/bun's serveStatic: that
// middleware's root/path resolution is documented as relative to
// process.cwd(), and path.join() silently mangles an absolute path passed
// as `path` (it strips the leading "/" instead of erroring), so it's not
// a safe fit for cwd-independent paths. Bun.file() takes an absolute path
// unambiguously and infers the content-type from the extension.
const webDist = join(import.meta.dir, "../../client/dist");
const webSrc = join(import.meta.dir, "../../client/src");
const serverPublic = join(import.meta.dir, "../public");

async function serveFile(path: string, cacheControl?: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const headers = cacheControl ? { "cache-control": cacheControl } : undefined;
  return new Response(file, headers ? { headers } : undefined);
}

// The bundle filename isn't content-hashed, so tell clients to revalidate
// every load rather than trust a heuristic cache. Without this the Tauri
// (WKWebView) shell kept serving a stale app.js across deploys — the browser
// showed the new UI while the desktop app ran old code. "no-cache" still
// allows a 304, so it's cheap: it just forbids using a cached copy blind.
app.get("/app.js", () => serveFile(join(webDist, "app.js"), "no-cache"));
app.get("/styles.css", () => serveFile(join(webSrc, "styles.css"), "no-cache"));
app.get("/favicon.png", () => serveFile(join(serverPublic, "favicon.png")));

// Vanity download redirect. Must sit before the SPA catch-all below, or
// the `*` route would swallow it and serve index.html instead.
//
//   /download                          -> the repo page
//   /download?version=willow           -> that release's page
//   /download?platform=windows         -> latest release's installer
//   /download?version=willow&platform=windows -> that release's installer
//
// The codename -> tag and platform -> filename tables live in
// lib/downloads.json; see lib/downloads.ts.
app.get("/download", (c) => {
  const target = resolveDownload(c.req.query("version"), c.req.query("platform"));

  switch (target.kind) {
    case "unknown-version":
      return c.text(
        `Unknown version "${target.value}". Available: ${versionNames.join(", ")}`,
        404,
      );
    case "unknown-platform":
      return c.text(
        `Unknown platform "${target.value}". Available: ${platformNames.join(", ")}`,
        404,
      );
    default:
      return c.redirect(target.url, 302);
  }
});

// Shareable per-song link. Must sit before the SPA catch-all.
//
//   /song/<id>              -> the SPA, with song-specific unfurl metadata
//                             injected so Discord/Slack/iMessage previews show
//                             the track (the SPA then routes to the song view)
//   /song/<id>?download=1   -> downloads the ORIGINAL uploaded master as a file
//
// Open to everyone: streaming and downloading need no account. Pending/rejected
// uploads are only visible to their uploader or an admin.
app.get("/song/:id", async (c) => {
  const song = await getSong(c.req.param("id"));

  if (c.req.query("download") != null && song && canSee(song, c.get("user"))) {
    return serveSongDownload(c.req.header("range"), song);
  }

  const file = Bun.file(join(webSrc, "index.html"));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  let html = await file.text();
  if (song && canSee(song, c.get("user"))) {
    html = injectSongMeta(html, song);
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
});

// Inline audio-player embed for a song, for platforms that render a
// `twitter:card=player` iframe (Discord, Twitter/X). Deliberately framework-
// free and tiny; served with no X-Frame-Options / frame-ancestors so it can be
// embedded cross-origin. Open to everyone (streaming needs no account).
app.get("/embed/song/:id", async (c) => {
  const song = await getSong(c.req.param("id"));
  if (!song || !canSee(song, c.get("user"))) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(embedPage(song), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
});

// Shareable artist link: same idea as /song/:id, but a plain summary card
// (name, bio, avatar) — no audio/player. Falls through to a normal SPA load
// for humans.
app.get("/artist/:id", async (c) => {
  const artist = await getArtist(c.req.param("id"));
  const file = Bun.file(join(webSrc, "index.html"));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  let html = await file.text();
  if (artist) html = injectArtistMeta(html, artist);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
});

// SPA fallback: any non-API route returns index.html. Also no-cache, so a
// stale shell can't keep pointing the webview at an old asset.
app.get("*", () => serveFile(join(webSrc, "index.html"), "no-cache"));

const htmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The common title / description / url / image swaps applied to index.html's
// static unfurl tags. Song- or artist-specific extras are layered on by the
// callers below.
function injectBaseMeta(
  html: string,
  meta: { title: string; desc: string; url: string; image: string },
): string {
  const title = htmlEsc(meta.title);
  const desc = htmlEsc(meta.desc);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      /(<meta (?:property|name)="(?:og:title|twitter:title)" content=")[^"]*(")/g,
      `$1${title}$2`,
    )
    .replace(
      /(<meta (?:property|name)="(?:og:description|twitter:description|description)" content=")[^"]*(")/g,
      `$1${desc}$2`,
    )
    .replace(/(<meta property="og:url" content=")[^"]*(")/g, `$1${meta.url}$2`)
    .replace(
      /(<meta (?:property|name)="(?:og:image|twitter:image)" content=")[^"]*(")/g,
      `$1${meta.image}$2`,
    );
}

function injectArtistMeta(
  html: string,
  artist: { id: string; name: string; bio: string | null; avatar_path: string | null },
): string {
  return injectBaseMeta(html, {
    title: `${artist.name} — Doughmination Music`,
    desc: artist.bio || `Music by ${artist.name} on Doughmination Music.`,
    url: `${config.appUrl}/artist/${artist.id}`,
    image: artist.avatar_path
      ? `${config.appUrl}/api/artists/${artist.id}/avatar`
      : `${config.appUrl}/favicon.png`,
  }).replace(
    "</head>",
    `  <meta property="og:type" content="profile" />\n  </head>`,
  );
}

type ShareSong = {
  id: string;
  title: string;
  artist: string;
  cover_path: string | null;
  duration_s: number | null;
  stream_path: string | null;
  file_path: string;
};

function songUrls(song: ShareSong) {
  return {
    page: `${config.appUrl}/song/${song.id}`,
    embed: `${config.appUrl}/embed/song/${song.id}`,
    stream: `${config.appUrl}/api/songs/${song.id}/stream`,
    image: song.cover_path
      ? `${config.appUrl}/api/songs/${song.id}/cover`
      : `${config.appUrl}/favicon.png`,
    audioMime: mimeForAudioPath(song.stream_path ?? song.file_path),
  };
}

// Rewrite the static unfurl tags in index.html for a specific song, and append
// audio/player tags so link previews get an inline play button where supported.
// Bots don't run JS, so this has to happen server-side; humans still boot the
// SPA normally.
function injectSongMeta(html: string, song: ShareSong): string {
  const u = songUrls(song);
  const extra =
    [
      `<meta property="og:type" content="music.song" />`,
      song.duration_s ? `<meta property="music:duration" content="${song.duration_s}" />` : "",
      `<meta property="og:audio" content="${u.stream}" />`,
      `<meta property="og:audio:secure_url" content="${u.stream}" />`,
      `<meta property="og:audio:type" content="${u.audioMime}" />`,
      `<meta name="twitter:player" content="${u.embed}" />`,
      `<meta name="twitter:player:width" content="480" />`,
      `<meta name="twitter:player:height" content="160" />`,
      `<meta name="twitter:player:stream" content="${u.stream}" />`,
    ]
      .filter(Boolean)
      .join("\n    ") + "\n  ";

  return injectBaseMeta(html, {
    title: `${song.title} — ${song.artist}`,
    desc: `Listen to ${song.title} by ${song.artist} on Doughmination Music.`,
    url: u.page,
    image: u.image,
  })
    // summary -> player so a preview iframe (twitter:player below) is used.
    .replace(/(<meta name="twitter:card" content=")[^"]*(")/, `$1player$2`)
    .replace("</head>", `  ${extra}</head>`);
}

function embedPage(song: ShareSong): string {
  const u = songUrls(song);
  const title = htmlEsc(`${song.title} — ${song.artist}`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta name="theme-color" content="#f5a9b8" />
  <meta property="og:type" content="music.song" />
  <meta property="og:title" content="${title}" />
  <meta property="og:image" content="${u.image}" />
  <meta property="og:audio" content="${u.stream}" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background: #12141c; color: #f4f6fb; display: flex; gap: 14px;
      align-items: center; padding: 14px; }
    img { width: 92px; height: 92px; border-radius: 10px; object-fit: cover;
      background: #1b1e2a; flex-shrink: 0; }
    .meta { min-width: 0; flex: 1; }
    .t { font-weight: 700; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .a { color: #9aa3c2; font-size: .85rem; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; margin: 2px 0 8px; }
    audio { width: 100%; height: 34px; }
    a.brand { color: #9aa3c2; font-size: .7rem; text-decoration: none; }
  </style>
</head>
<body>
  <img src="${u.image}" alt="" />
  <div class="meta">
    <div class="t">${htmlEsc(song.title)}</div>
    <div class="a">${htmlEsc(song.artist)}</div>
    <audio controls preload="none" src="${u.stream}"></audio>
    <div><a class="brand" href="${u.page}" target="_blank" rel="noopener">Doughmination Music ↗</a></div>
  </div>
</body>
</html>`;
}

console.log(`Music server on ${config.appUrl} (port ${config.port})`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Allow large uploads.
  maxRequestBodySize: config.maxUploadBytes + 16 * 1024 * 1024,
};
