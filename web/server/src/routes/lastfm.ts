import { Hono } from "hono";

import { config } from "../config.ts";
import { sql } from "../db/index.ts";
import { requireAuth, type AppEnv } from "../auth/middleware.ts";
import * as lastfm from "../lib/lastfm.ts";

export const lastfmRoutes = new Hono<AppEnv>();

// --- unauthenticated: the desktop "connect in the system browser" hops ------
// The system browser has no session, so these two can't sit behind
// requireAuth. Neither touches user data: /connect only builds the Last.fm
// redirect, and /native-callback only bounces the returned token back into
// the app via the doughmination:// deep link. The app then finishes the
// exchange with an authenticated POST /native-complete.

lastfmRoutes.get("/connect", (c) => {
  if (!lastfm.isConfigured()) {
    return c.json({ error: "lastfm_not_configured" }, 400);
  }
  const native = c.req.query("native") != null;
  const callbackUrl = `${config.appUrl}/api/lastfm/${native ? "native-callback" : "callback"}`;
  return c.redirect(lastfm.getAuthUrl(callbackUrl));
});

lastfmRoutes.get("/native-callback", (c) => {
  const token = c.req.query("token");
  const target = token
    ? `doughmination://lastfm/callback?token=${encodeURIComponent(token)}`
    : `doughmination://lastfm/callback?error=1`;
  const esc = target.replace(/"/g, "&quot;");
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Last.fm</title>
<meta http-equiv="refresh" content="0;url=${esc}">
<style>body{font:14px system-ui,sans-serif;background:#0a0b10;color:#f4f6fb;
display:grid;place-items:center;height:100vh;margin:0}a{color:#f5a9b8}</style>
</head><body><p>Returning to Doughmination Music… <a href="${esc}">continue</a></p></body></html>`,
  );
});

lastfmRoutes.use("*", requireAuth);

lastfmRoutes.get("/status", (c) => {
  const user = c.get("user")!;
  return c.json({
    configured: lastfm.isConfigured(),
    connected: Boolean(user.lastfm_session_key),
    username: user.lastfm_username,
  });
});

// The web flow's return leg: the browser still has the session cookie, so we
// exchange the token and attach the session key right here, then redirect
// back into the app. (The /connect that kicks this off is registered above,
// unauthenticated.)
lastfmRoutes.get("/callback", async (c) => {
  const user = c.get("user")!;
  const token = c.req.query("token");
  if (!token) return c.redirect(`${config.appUrl}/?lastfm=error`);

  try {
    const session = await lastfm.getSession(token);
    await sql`
      UPDATE users
      SET lastfm_session_key = ${session.key},
          lastfm_username    = ${session.username}
      WHERE id = ${user.id}
    `;
    return c.redirect(`${config.appUrl}/?lastfm=connected`);
  } catch (err) {
    console.error("lastfm: connect failed:", err);
    return c.redirect(`${config.appUrl}/?lastfm=error`);
  }
});

// The desktop flow's return leg: /native-callback bounced the Last.fm token
// back through the doughmination:// deep link, and the app POSTs it here with
// its bearer token so we know which user to bind the session key to.
lastfmRoutes.post("/native-complete", async (c) => {
  const user = c.get("user")!;
  const body = await c.req
    .json<{ token?: string }>()
    .catch(() => ({}) as { token?: string });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return c.json({ error: "token_required" }, 400);

  try {
    const session = await lastfm.getSession(token);
    await sql`
      UPDATE users
      SET lastfm_session_key = ${session.key},
          lastfm_username    = ${session.username}
      WHERE id = ${user.id}
    `;
    return c.json({ ok: true, username: session.username });
  } catch (err) {
    console.error("lastfm: native connect failed:", err);
    return c.json({ error: "lastfm_connect_failed" }, 502);
  }
});

lastfmRoutes.post("/disconnect", async (c) => {
  const user = c.get("user")!;
  await sql`
    UPDATE users
    SET lastfm_session_key = NULL, lastfm_username = NULL
    WHERE id = ${user.id}
  `;
  return c.json({ ok: true });
});

interface NowPlayingBody {
  title: string;
  artist: string;
  album?: string;
  durationS?: number;
}

// Fire-and-forget from the player's perspective — scrobbling failures
// (Last.fm down, revoked session, etc) never gate actual playback, so these
// always return 204 and just log server-side on failure.
lastfmRoutes.post("/now-playing", async (c) => {
  const user = c.get("user")!;
  if (!user.lastfm_session_key) return c.body(null, 204);

  const body = await c.req.json<NowPlayingBody>().catch(() => null);
  if (!body?.title || !body?.artist) {
    return c.json({ error: "title_and_artist_required" }, 400);
  }

  try {
    await lastfm.updateNowPlaying(user.lastfm_session_key, body);
  } catch (err) {
    console.error("lastfm: now-playing failed:", err);
  }
  return c.body(null, 204);
});

interface ScrobbleBody extends NowPlayingBody {
  startedAt: number; // epoch seconds when the track STARTED playing
}

lastfmRoutes.post("/scrobble", async (c) => {
  const user = c.get("user")!;
  if (!user.lastfm_session_key) return c.body(null, 204);

  const body = await c.req.json<ScrobbleBody>().catch(() => null);
  if (!body?.title || !body?.artist || !body?.startedAt) {
    return c.json({ error: "title_artist_startedAt_required" }, 400);
  }

  try {
    await lastfm.scrobble(user.lastfm_session_key, body);
  } catch (err) {
    console.error("lastfm: scrobble failed:", err);
  }
  return c.body(null, 204);
});