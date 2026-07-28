// Hono middleware: loads the current user from the session cookie.
// `requireAuth` rejects unauthenticated requests with 401.

import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";

import { config } from "../config.ts";
import { sql, type User } from "../db/index.ts";
import {
  cookieNames,
  readSession,
} from "./session.ts";

// Admin = username or email listed in MUSIC_ADMINS.
export function isAdmin(user: User | null): boolean {
  if (!user) return false;
  const ids = [user.username, user.email]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  return ids.some((id) => config.admins.includes(id));
}

// Typed vars available on the context after this middleware runs.
export type AppEnv = {
  Variables: {
    user: User | null;
  };
};

// Web sends the session as an httpOnly cookie (same-origin). Native clients
// (desktop / mobile) have no shared cookie jar with the server, so they send
// it as `Authorization: Bearer <token>` instead. Either is accepted; the
// token itself is the same opaque, revocable session id in both cases.
export function sessionToken(c: Context<AppEnv>): string | undefined {
  const auth = c.req.header("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return getCookie(c, cookieNames.session);
}

export async function loadUser(c: Context<AppEnv>, next: Next) {
  c.set("user", null);

  const token = sessionToken(c);
  if (token) {
    const uid = await readSession(token);
    if (uid) {
      const rows = await sql<User[]>`
        SELECT * FROM users WHERE id = ${uid}
      `;
      if (rows[0]) c.set("user", rows[0]);
    }
  }

  await next();
}

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  if (!c.get("user")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
