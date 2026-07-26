// Simple fixed-window rate limiter backed by Redis. Fails open if Redis is
// unreachable (better to allow traffic than to lock everyone out).

import type {
  Context,
  Next,
} from "hono";

import { redis } from "../redis.ts";
import type { AppEnv } from "../auth/middleware.ts";

function clientIp(c: Context<AppEnv>): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip")?.trim() ?? "unknown";
}

export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSec: number;
}) {
  return async (c: Context<AppEnv>, next: Next) => {
    const key = `music:rl:${opts.name}:${clientIp(c)}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, opts.windowSec);
      }
      if (count > opts.limit) {
        const ttl = await redis.ttl(key);
        c.header("Retry-After", String(Math.max(ttl, 1)));
        return c.json({ error: "rate_limited", retryAfter: ttl }, 429);
      }
    } catch {
      // Redis down: fail open.
    }

    await next();
  };
}
