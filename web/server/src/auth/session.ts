// Everything auth-related lives in Redis, so there's no session secret:
//  - Sessions are opaque random ids -> userId (server-side, revocable).
//  - The OIDC login handshake (state / nonce / PKCE verifier) is stashed under
//    a random id for the ~minute between /login and /callback.
// The cookie only ever holds an opaque id; nothing signed, nothing to leak.

import { config } from "../config.ts";
import { redis } from "../redis.ts";

const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days, sliding
const HANDSHAKE_TTL_SEC = 600; // 10 minutes
const EXCHANGE_TTL_SEC = 120; // 2 minutes — deeplink -> app -> exchange

function sessKey(id: string): string {
  return `music:sess:${id}`;
}

function userSetKey(userId: string): string {
  return `music:usess:${userId}`;
}

function handshakeKey(id: string): string {
  return `music:oidc:${id}`;
}

function exchangeKey(code: string): string {
  return `music:xchg:${code}`;
}

function randomId(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// --- server-side sessions -------------------------------------------------

export async function createSession(userId: string): Promise<string> {
  const id = randomId();
  await redis
    .multi()
    .set(sessKey(id), userId, "EX", SESSION_TTL_SEC)
    .sadd(userSetKey(userId), id)
    .exec();
  return id;
}

// Returns the userId, refreshing the TTL (sliding expiry).
//
// The lookup that matters is the GET. The EXPIRE that renews the sliding
// window is deliberately fire-and-forget: previously it was awaited inside
// the same try/catch, so a single transient Redis hiccup on the *refresh*
// would throw and make a perfectly valid session read as null — i.e. the user
// got logged out mid-playback (every stream range request hits this) for no
// reason. Now a failed renewal can't invalidate a session we already resolved.
export async function readSession(id: string): Promise<string | null> {
  let userId: string | null;
  try {
    userId = await redis.get(sessKey(id));
  } catch {
    // A genuine Redis read failure — we can't confirm the session right now.
    // ioredis retries the command internally; the next request will try again.
    return null;
  }
  if (!userId) return null;

  // Best-effort renewal: never let its failure affect the resolved session.
  redis.expire(sessKey(id), SESSION_TTL_SEC).catch(() => {});
  return userId;
}

export async function destroySession(id: string): Promise<void> {
  const userId = await redis.get(sessKey(id));
  const m = redis.multi().del(sessKey(id));
  if (userId) m.srem(userSetKey(userId), id);
  await m.exec();
}

// Force-logout every session for a user.
export async function destroyAllSessions(userId: string): Promise<void> {
  const ids = await redis.smembers(userSetKey(userId));
  const m = redis.multi();
  for (const id of ids) m.del(sessKey(id));
  m.del(userSetKey(userId));
  await m.exec();
}

// --- OIDC login handshake -------------------------------------------------

export type Handshake = {
  state: string;
  nonce: string;
  verifier: string;
  // Present only for native (desktop / mobile) logins. `appChallenge` is the
  // app's own PKCE challenge for the deeplink -> exchange hop; `redirect` is
  // the (allowlisted) custom-scheme URL to bounce back to after callback.
  native?: {
    appChallenge: string;
    redirect: string;
  };
  // Web only: the same-origin path (already validated — see routes/auth.ts)
  // to send the browser back to after callback, so a deep link (e.g. a
  // shared /artist/<id> url) survives the SSO round trip instead of always
  // landing on "/".
  webRedirect?: string;
};

export async function saveHandshake(data: Handshake): Promise<string> {
  const id = randomId();
  await redis.set(
    handshakeKey(id),
    JSON.stringify(data),
    "EX",
    HANDSHAKE_TTL_SEC,
  );
  return id;
}

// One-shot read: fetch and delete atomically so a handshake can't be replayed.
export async function takeHandshake(id: string): Promise<Handshake | null> {
  try {
    const raw = await redis.getdel(handshakeKey(id));
    return raw ? (JSON.parse(raw) as Handshake) : null;
  } catch {
    return null;
  }
}

// --- native deeplink exchange codes ---------------------------------------
// After a native login completes, /callback mints one of these and puts the
// opaque `code` in the doughmination:// deeplink. The app then trades the
// code (plus the PKCE verifier that never left the device) for the real
// session token. One-shot + PKCE-bound: intercepting the deeplink is useless
// without the verifier, and the code can't be replayed.

export async function mintExchangeCode(data: {
  sessionId: string;
  appChallenge: string;
}): Promise<string> {
  const code = randomId();
  await redis.set(
    exchangeKey(code),
    JSON.stringify(data),
    "EX",
    EXCHANGE_TTL_SEC,
  );
  return code;
}

export async function takeExchangeCode(
  code: string,
): Promise<{ sessionId: string; appChallenge: string } | null> {
  try {
    const raw = await redis.getdel(exchangeKey(code));
    return raw
      ? (JSON.parse(raw) as { sessionId: string; appChallenge: string })
      : null;
  } catch {
    return null;
  }
}

// --- cookies --------------------------------------------------------------

export const cookieNames = {
  session: "ms_session",
  handshake: "ms_oidc",
} as const;

export const secureCookieOpts = {
  httpOnly: true,
  sameSite: "Lax",
  path: "/",
  secure: config.isProd,
} as const;
