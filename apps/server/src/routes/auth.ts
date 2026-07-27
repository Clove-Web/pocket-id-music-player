// OIDC login / callback / logout, plus /api/me.

import { Hono } from "hono";
import {
  getCookie,
  setCookie,
  deleteCookie,
} from "hono/cookie";

import { sql, type User } from "../db/index.ts";
import {
  requireAuth,
  type AppEnv,
} from "../auth/middleware.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import {
  buildAuthUrl,
  exchangeCode,
  endSessionUrl,
  pkceChallenge,
  randomString,
} from "../auth/oidc.ts";
import {
  cookieNames,
  createSession,
  destroyAllSessions,
  destroySession,
  saveHandshake,
  secureCookieOpts,
  takeHandshake,
} from "../auth/session.ts";

export const authRoutes = new Hono<AppEnv>();

const loginLimit = rateLimit({ name: "login", limit: 10, windowSec: 60 });

authRoutes.get("/login", loginLimit, async (c) => {
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  const challenge = await pkceChallenge(verifier);

  // Stash the handshake in Redis; the cookie only holds its opaque id.
  const handshakeId = await saveHandshake({ state, nonce, verifier });
  setCookie(c, cookieNames.handshake, handshakeId, secureCookieOpts);

  const url = await buildAuthUrl({
    state,
    nonce,
    codeChallenge: challenge,
  });
  return c.redirect(url);
});

authRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");

  const handshakeId = getCookie(c, cookieNames.handshake);
  deleteCookie(c, cookieNames.handshake, secureCookieOpts);

  if (!code || !returnedState || !handshakeId) {
    return c.json({ error: "invalid_callback" }, 400);
  }

  // One-shot read (deleted on fetch) so a handshake can't be replayed.
  const hs = await takeHandshake(handshakeId);

  if (!hs || hs.state !== returnedState) {
    return c.json({ error: "state_mismatch" }, 400);
  }

  let claims;
  try {
    claims = await exchangeCode({
      code,
      verifier: hs.verifier,
      expectedNonce: hs.nonce,
    });
  } catch (err) {
    console.error("OIDC exchange error:", err);
    return c.json({ error: "oidc_exchange_failed" }, 401);
  }

  // Upsert the user by their PocketID subject, pulling their profile picture.
  const name = claims.name ?? claims.preferred_username ?? null;
  const username = claims.preferred_username ?? null;
  const avatar = claims.picture ?? null;
  const rows = await sql<User[]>`
    INSERT INTO users (oidc_sub, email, name, username, avatar_url)
    VALUES (${claims.sub}, ${claims.email ?? null}, ${name}, ${username}, ${avatar})
    ON CONFLICT (oidc_sub) DO UPDATE
      SET email      = EXCLUDED.email,
          name       = EXCLUDED.name,
          username   = EXCLUDED.username,
          avatar_url = EXCLUDED.avatar_url
    RETURNING *
  `;
  const user = rows[0]!;

  setCookie(
    c,
    cookieNames.session,
    await createSession(user.id),
    secureCookieOpts,
  );

  return c.redirect("/");
});

authRoutes.post("/logout", async (c) => {
  const sid = getCookie(c, cookieNames.session);
  if (sid) await destroySession(sid);
  deleteCookie(c, cookieNames.session, secureCookieOpts);
  const url = await endSessionUrl();
  return c.json({ ok: true, endSession: url ?? null });
});

// Revoke every session for the current user (all devices).
authRoutes.post("/logout-all", requireAuth, async (c) => {
  const user = c.get("user")!;
  await destroyAllSessions(user.id);
  deleteCookie(c, cookieNames.session, secureCookieOpts);
  const url = await endSessionUrl();
  return c.json({ ok: true, endSession: url ?? null });
});
