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

export async function loadUser(c: Context<AppEnv>, next: Next) {
  c.set("user", null);

  const token = getCookie(c, cookieNames.session);
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
