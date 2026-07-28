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
import { ensureMediaDirs } from "./lib/media.ts";
import { startPocketIdGuard } from "./lib/pocketid-guard.ts";
import { authRoutes } from "./routes/auth.ts";
import { songRoutes } from "./routes/songs.ts";
import { playlistRoutes } from "./routes/playlists.ts";
import { artistRoutes } from "./routes/artists.ts";
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
// root, from apps/server, or from inside a Docker image — important now
// that apps/web is a sibling workspace package rather than a subfolder.
// We use Bun.file() directly rather than hono/bun's serveStatic: that
// middleware's root/path resolution is documented as relative to
// process.cwd(), and path.join() silently mangles an absolute path passed
// as `path` (it strips the leading "/" instead of erroring), so it's not
// a safe fit for cwd-independent paths. Bun.file() takes an absolute path
// unambiguously and infers the content-type from the extension.
const webDist = join(import.meta.dir, "../../web/dist");
const webSrc = join(import.meta.dir, "../../web/src");
const serverPublic = join(import.meta.dir, "../public");

async function serveFile(path: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

app.get("/app.js", () => serveFile(join(webDist, "app.js")));
app.get("/styles.css", () => serveFile(join(webSrc, "styles.css")));
app.get("/favicon.png", () => serveFile(join(serverPublic, "favicon.png")));

// SPA fallback: any non-API route returns index.html.
app.get("*", () => serveFile(join(webSrc, "index.html")));

console.log(`Music server on ${config.appUrl} (port ${config.port})`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Allow large uploads.
  maxRequestBodySize: config.maxUploadBytes + 16 * 1024 * 1024,
};
