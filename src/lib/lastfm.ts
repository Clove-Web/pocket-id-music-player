

import { createHash } from "node:crypto";

import { config } from "../config.ts";

const API_BASE = "https://ws.audioscrobbler.com/2.0/";

export function isConfigured(): boolean {
  return Boolean(config.lastfm.apiKey && config.lastfm.sharedSecret);
}

export interface TrackInfo {
  title: string;
  artist: string;
  album?: string | null;
  durationS?: number | null;
}

// Last.fm's signing scheme: sort every param (excluding format/callback) by
// key, concatenate as `${key}${value}` with no separators, append the
// shared secret, then md5 the result.
function sign(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  const base = keys.map((k) => `${k}${params[k]}`).join("") + config.lastfm.sharedSecret;
  return createHash("md5").update(base, "utf8").digest("hex");
}

interface LastfmError {
  error: number;
  message: string;
}

async function call<T>(
  method: string,
  params: Record<string, string>,
  opts: { signed?: boolean; httpMethod?: "GET" | "POST" } = {},
): Promise<T> {
  const allParams: Record<string, string> = {
    method,
    api_key: config.lastfm.apiKey,
    ...params,
  };
  if (opts.signed) {
    allParams.api_sig = sign(allParams);
  }
  allParams.format = "json"; // excluded from the signature, added after

  let res: Response;
  if (opts.httpMethod === "POST") {
    res = await fetch(API_BASE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(allParams),
    });
  } else {
    const url = new URL(API_BASE);
    for (const [k, v] of Object.entries(allParams)) url.searchParams.set(k, v);
    res = await fetch(url);
  }

  const data = (await res.json()) as T | LastfmError;
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(`Last.fm API error ${data.error}: ${data.message}`);
  }
  return data as T;
}

export function getAuthUrl(callbackUrl: string): string {
  const url = new URL("https://www.last.fm/api/auth/");
  url.searchParams.set("api_key", config.lastfm.apiKey);
  url.searchParams.set("cb", callbackUrl);
  return url.toString();
}

export async function getSession(
  token: string,
): Promise<{ key: string; username: string }> {
  const data = await call<{ session: { key: string; name: string } }>(
    "auth.getSession",
    { token },
    { signed: true, httpMethod: "GET" },
  );
  return { key: data.session.key, username: data.session.name };
}

function trackParams(track: TrackInfo): Record<string, string> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
  };
  if (track.album) params.album = track.album;
  if (track.durationS) params.duration = String(Math.round(track.durationS));
  return params;
}

export async function updateNowPlaying(
  sessionKey: string,
  track: TrackInfo,
): Promise<void> {
  await call(
    "track.updateNowPlaying",
    { ...trackParams(track), sk: sessionKey },
    { signed: true, httpMethod: "POST" },
  );
}

export async function scrobble(
  sessionKey: string,
  track: TrackInfo & { startedAt: number },
): Promise<void> {
  await call(
    "track.scrobble",
    {
      ...trackParams(track),
      sk: sessionKey,
      timestamp: String(track.startedAt),
    },
    { signed: true, httpMethod: "POST" },
  );
}