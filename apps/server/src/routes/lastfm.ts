import { Hono } from "hono";

import { config } from "../config.ts";
import { sql } from "../db/index.ts";
import { requireAuth, type AppEnv } from "../auth/middleware.ts";
import * as lastfm from "../lib/lastfm.ts";

export const lastfmRoutes = new Hono<AppEnv>();

lastfmRoutes.use("*", requireAuth);

lastfmRoutes.get("/status", (c) => {
  const user = c.get("user")!;
  return c.json({
    configured: lastfm.isConfigured(),
    connected: Boolean(user.lastfm_session_key),
    username: user.lastfm_username,
  });
});

// Kicks off Last.fm's "Web Application" auth flow: redirect the browser to
// Last.fm with our callback URL, the user approves there, Last.fm redirects
// back to /callback with a token we exchange for a session key.
lastfmRoutes.get("/connect", (c) => {
  if (!lastfm.isConfigured()) {
    return c.json({ error: "lastfm_not_configured" }, 400);
  }
  const callbackUrl = `${config.appUrl}/api/lastfm/callback`;
  return c.redirect(lastfm.getAuthUrl(callbackUrl));
});

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