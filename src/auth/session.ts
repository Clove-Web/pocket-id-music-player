// Everything auth-related lives in Redis, so there's no session secret:
//  - Sessions are opaque random ids -> userId (server-side, revocable).
//  - The OIDC login handshake (state / nonce / PKCE verifier) is stashed under
//    a random id for the ~minute between /login and /callback.
// The cookie only ever holds an opaque id; nothing signed, nothing to leak.

import { config } from "../config.ts";
import { redis } from "../redis.ts";

const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days, sliding
const HANDSHAKE_TTL_SEC = 600; // 10 minutes

function sessKey(id: string): string {
  return `music:sess:${id}`;
}

function userSetKey(userId: string): string {
  return `music:usess:${userId}`;
}

function handshakeKey(id: string): string {
  return `music:oidc:${id}`;
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

// Returns the userId, refreshing the TTL (sliding expiry). Fails open to null.
export async function readSession(id: string): Promise<string | null> {
  try {
    const userId = await redis.get(sessKey(id));
    if (!userId) return null;
    await redis.expire(sessKey(id), SESSION_TTL_SEC);
    return userId;
  } catch {
    return null;
  }
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
