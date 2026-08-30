// Where the app points its window. The desktop app is a thin shell over the
// live web player, so this is just a URL:
//
//   DMND_SERVER_URL env var           (highest priority; for dev / testing)
//   <userData>/settings.json          (persisted "Set Server URL…" choice)
//   DEFAULT_URL                        (the hosted instance)

import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_URL = "https://doughmination.me";

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function readFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getServerUrl(): string {
  const fromEnv = process.env.DMND_SERVER_URL?.trim();
  if (fromEnv) return normalize(fromEnv);
  const stored = readFile().serverUrl;
  if (typeof stored === "string" && stored.trim()) return normalize(stored);
  return DEFAULT_URL;
}

export function setServerUrl(url: string): void {
  const value = normalize(url);
  const data = readFile();
  data.serverUrl = value;
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2));
}

// Trim, add a scheme if missing, drop a trailing slash.
function normalize(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
}
