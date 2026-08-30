// Resolves /download?version=&platform= to a GitHub release URL.
//
// Everything that changes per release lives in downloads.json, not here:
// which codename maps to which tag, which file each platform ships, and
// which codename is currently "latest". Cutting a release means editing
// that file — no code change.
//
// A version entry may override the per-platform filenames. That exists
// because releases up to and including v2.2.0 ("Willow") carry the Tauri
// version in their asset names (Doughmination.Music_1.0.0_x64-setup.exe),
// while the release workflow now strips it. Old releases keep working by
// naming their own files; new ones inherit the defaults and need only a
// `tag`.

import manifest from "./downloads.json" with { type: "json" };

type Platform = string;

interface VersionEntry {
  tag: string;
  files?: Record<Platform, string>;
}

const repo: string = manifest.repo;
const platforms: Record<Platform, string> = manifest.platforms;
const aliases: Record<string, string> = manifest.aliases;
const versions: Record<string, VersionEntry> = manifest.versions;

export const repoUrl = `https://github.com/${repo}`;

/** Codenames a caller can pass as ?version=, for error messages. */
export const versionNames = Object.keys(versions);

/** Platform keys a caller can pass as ?platform=, aliases excluded. */
export const platformNames = Object.keys(platforms);

/**
 * Looks up a version by codename ("willow") or by its literal tag
 * ("v2.2.0"), so a link written against either keeps working.
 */
function findVersion(name: string): VersionEntry | undefined {
  const direct = versions[name];
  if (direct) return direct;
  return Object.values(versions).find((v) => v.tag.toLowerCase() === name);
}

export type DownloadTarget =
  | { kind: "repo"; url: string }
  | { kind: "release"; url: string; tag: string }
  | { kind: "asset"; url: string; tag: string; file: string }
  | { kind: "unknown-version"; value: string }
  | { kind: "unknown-platform"; value: string };

/**
 * Neither param -> the repo page. Version only -> that release's page.
 * Platform only -> that platform's file from whichever version the
 * manifest marks latest. Both -> that version's file for that platform.
 */
export function resolveDownload(
  versionParam: string | undefined,
  platformParam: string | undefined,
): DownloadTarget {
  const versionName = versionParam?.trim().toLowerCase();
  const platformInput = platformParam?.trim().toLowerCase();

  if (!versionName && !platformInput) return { kind: "repo", url: repoUrl };

  const version = versionName
    ? findVersion(versionName)
    : findVersion(manifest.latest);
  // A missing `latest` is a manifest bug, not a bad request — fall back to
  // the repo page rather than 404ing a link that looks fine to the caller.
  if (!version) {
    return versionName
      ? { kind: "unknown-version", value: versionName }
      : { kind: "repo", url: repoUrl };
  }

  if (!platformInput) {
    return {
      kind: "release",
      url: `${repoUrl}/releases/tag/${version.tag}`,
      tag: version.tag,
    };
  }

  const platform = aliases[platformInput] ?? platformInput;
  const file = version.files?.[platform] ?? platforms[platform];
  if (!file) return { kind: "unknown-platform", value: platformInput };

  return {
    kind: "asset",
    url: `${repoUrl}/releases/download/${version.tag}/${file}`,
    tag: version.tag,
    file,
  };
}
