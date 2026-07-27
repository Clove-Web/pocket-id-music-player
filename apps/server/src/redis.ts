// Shared Redis connection (sessions + rate limiting).

import { Redis } from "ioredis";

import { config } from "./config.ts";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("error", (err) => {
  // Don't crash the process on transient Redis blips; log and move on.
  console.error("Redis error:", err.message);
});
