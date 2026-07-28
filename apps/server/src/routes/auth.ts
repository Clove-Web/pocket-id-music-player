// OIDC login / callback / logout, plus /api/me.

import { Hono } from "hono";
import {
  getCookie,
  setCookie,
  deleteCookie,
} from "hono/cookie";

import { config } from "../config.ts";
import { sql, type User } from "../db/index.ts";
import {
  requireAuth,
  sessionToken,
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
  mintExchangeCode,
  saveHandshake,
  secureCookieOpts,
  takeExchangeCode,
  takeHandshake,
} from "../auth/session.ts";

export const authRoutes = new Hono<AppEnv>();

const loginLimit = rateLimit({ name: "login", limit: 10, windowSec: 60 });

authRoutes.get("/login", loginLimit, async (c) => {
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  const challenge = await pkceChallenge(verifier);

  // Native (desktop / mobile) clients open this in the *system* browser and
  // pass ?mode=native plus their own PKCE challenge for the deeplink hop.
  // Web omits these and gets the classic cookie + redirect-to-"/" flow.
  let native: { appChallenge: string; redirect: string } | undefined;
  if (c.req.query("mode") === "native") {
    const appChallenge = c.req.query("app_challenge");
    if (!appChallenge) {
      return c.json({ error: "missing_app_challenge" }, 400);
    }
    // Only allowlisted custom schemes are accepted, so this can never be
    // turned into an open redirect. A client may request a specific one;
    // otherwise it gets the first configured redirect.
    const requested = c.req.query("redirect");
    const redirect = requested
      ? config.nativeRedirects.includes(requested)
        ? requested
        : null
      : config.nativeRedirects[0];
    if (!redirect) {
      return c.json({ error: "redirect_not_allowed" }, 400);
    }
    native = { appChallenge, redirect };
  }

  // Stash the handshake in Redis; the cookie only holds its opaque id.
  const handshakeId = await saveHandshake({ state, nonce, verifier, native });
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
  const sessionId = await createSession(user.id);

  // Native flow: don't set a cookie (it'd land in the system browser, where
  // it's useless to the app). Instead mint a one-time, PKCE-bound exchange
  // code and bounce back into the app via its custom-scheme deeplink. The
  // app trades that code for the session token over HTTPS.
  if (hs.native) {
    const exchange = await mintExchangeCode({
      sessionId,
      appChallenge: hs.native.appChallenge,
    });
    const dest = new URL(hs.native.redirect);
    dest.searchParams.set("code", exchange);
    // NB: return an interstitial, NOT a 302 to the custom scheme. Browsers
    // routinely block a server-initiated redirect to a non-http(s) protocol
    // unless it's driven by a user gesture, so we auto-attempt the hand-off
    // AND give a button the user can click if the browser held it back.
    return c.html(returnToAppPage(dest.toString()));
  }

  // Web flow: httpOnly session cookie + back to the app.
  setCookie(c, cookieNames.session, sessionId, secureCookieOpts);
  return c.redirect("/");
});

// Native clients trade the one-time deeplink code (+ the PKCE verifier that
// never left the device) for the actual session token. Bearer it on every
// subsequent request. Rate-limited: the code is single-use anyway, but this
// blunts brute-forcing of the opaque code space.
const exchangeLimit = rateLimit({
  name: "native-exchange",
  limit: 20,
  windowSec: 60,
});

authRoutes.post("/native/exchange", exchangeLimit, async (c) => {
  let body: { code?: string; verifier?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const { code, verifier } = body;
  if (!code || !verifier) {
    return c.json({ error: "missing_params" }, 400);
  }

  // One-shot read (deleted on fetch) so a code can't be replayed.
  const record = await takeExchangeCode(code);
  if (!record) {
    return c.json({ error: "invalid_code" }, 400);
  }

  // PKCE proof: only the app that started the login holds the verifier.
  const expected = await pkceChallenge(verifier);
  if (expected !== record.appChallenge) {
    return c.json({ error: "pkce_mismatch" }, 400);
  }

  return c.json({ token: record.sessionId });
});

authRoutes.post("/logout", async (c) => {
  const sid = sessionToken(c); // cookie (web) or Authorization: Bearer (native)
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

// Post-login hand-off page for native clients. Auto-tries the deeplink on
// load; the button is the reliable path when the browser requires a user
// gesture to open a custom-scheme URL. `deeplink` is server-built from an
// allowlisted scheme + a base64url code, but we still escape defensively.
function returnToAppPage(deeplink: string): string {
  const attr = deeplink.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const js = JSON.stringify(deeplink);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Return to Doughmination Music</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b0b0f;
           color: #eee; display: grid; place-items: center; height: 100vh;
           margin: 0; text-align: center; }
    .card { max-width: 22rem; padding: 2rem; }
    h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
    p { color: #9aa; margin: 0 0 1.5rem; line-height: 1.5; }
    a.btn { display: inline-block; background: #7c3aed; color: #fff;
            text-decoration: none; padding: .8rem 1.6rem; border-radius: 9999px;
            font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're signed in ✅</h1>
    <p>Head back to the Doughmination Music app to finish. If it doesn't open
       automatically, tap below.</p>
    <a class="btn" href="${attr}">Open Doughmination Music</a>
  </div>
  <script>
    // Best-effort auto hand-off; the button covers gesture-gated browsers.
    try { window.location.href = ${js}; } catch (e) {}
  </script>
</body>
</html>`;
}
