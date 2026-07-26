function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const appUrl = optional("MUSIC_APP_URL", "http://localhost:4060").replace(
  /\/$/,
  "",
);

export const config = {
  appUrl,
  port: Number(optional("MUSIC_PORT", "4060")),
  isProd: process.env.NODE_ENV === "production",

  databaseUrl: required("MUSIC_DATABASE_URL"),
  redisUrl: required("MUSIC_REDIS_URL"), // shared with the other services

  oidc: {
    issuer: required("OIDC_ISSUER").replace(/\/$/, ""), // shared PocketID
    clientId: required("MUSIC_OIDC_CLIENT_ID"), // dedicated music client
    clientSecret: required("MUSIC_OIDC_CLIENT_SECRET"),
    redirectUri: `${appUrl}/api/auth/callback`, // derived, not a separate var
    scope: "openid profile email",
  },

  // PocketID has no outbound webhooks (as of writing), so disabling a user
  // there doesn't reach this app on its own. If MUSIC_POCKETID_API_KEY is
  // set, a background poller checks PocketID's user list on this interval
  // and kills local sessions for anyone it finds disabled. See
  // lib/pocketid-guard.ts. Leave the API key unset to disable this feature.
  pocketId: {
    apiKey: optional("MUSIC_POCKETID_API_KEY", ""),
    pollIntervalMs: Number(optional("MUSIC_POCKETID_POLL_MS", "60000")),
  },

  // Last.fm scrobbling. api_key/sharedSecret are ONE app-level credential
  // pair (register once at last.fm/api/account/create) — not per-user.
  // Each user then does a "Connect Last.fm" handshake (see routes/lastfm.ts)
  // that exchanges a short-lived token for their own session key, which is
  // what actually gets stored per-user (users.lastfm_session_key). Leave
  // MUSIC_LASTFM_API_KEY unset to hide the feature entirely.
  lastfm: {
    apiKey: optional("MUSIC_LASTFM_API_KEY", ""),
    sharedSecret: optional("MUSIC_LASTFM_SHARED_SECRET", ""),
  },

  mediaDir: optional("MUSIC_MEDIA_DIR", "./data/media"),
  maxUploadBytes: Number(optional("MUSIC_MAX_UPLOAD_MB", "200")) * 1024 * 1024,

  // Duplicate detection: a candidate scoring >= threshold is sent to the
  // admin review queue (see lib/duplicates.ts). Score is a sum of signal
  // weights, not a percentage, so the threshold is tuned against those
  // weights rather than 0-100.
  duplicateReviewThreshold: Number(
    optional("MUSIC_DUPLICATE_THRESHOLD", "55"),
  ),
  // Recordings within this many seconds of each other count as a duration
  // match signal.
  duplicateDurationToleranceS: Number(
    optional("MUSIC_DUPLICATE_DURATION_TOLERANCE_S", "2"),
  ),

  // Comma-separated admin identifiers (PocketID username or email) that may
  // edit/fix any song in the shared library, e.g. "clove" or "me@example.com".
  admins: optional("MUSIC_ADMINS", "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
} as const;