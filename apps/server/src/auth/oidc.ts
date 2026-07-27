// Minimal, spec-correct OIDC (auth-code + PKCE) client for PocketID.
// No heavy library: discovery + PKCE + JWKS verification via `jose`.

import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";

import { config } from "../config.ts";

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
};

let cached: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function discovery(): Promise<Discovery> {
  if (cached) return cached;

  const url = `${config.oidc.issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  }

  cached = (await res.json()) as Discovery;
  jwks = createRemoteJWKSet(new URL(cached.jwks_uri));
  return cached;
}

// --- PKCE helpers ---------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomString(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

// --- URL builders + token exchange ---------------------------------------

export async function buildAuthUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const d = await discovery();

  const url = new URL(d.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.oidc.clientId);
  url.searchParams.set("redirect_uri", config.oidc.redirectUri);
  url.searchParams.set("scope", config.oidc.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type IdClaims = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  nonce?: string;
};

export async function exchangeCode(params: {
  code: string;
  verifier: string;
  expectedNonce: string;
}): Promise<IdClaims> {
  const d = await discovery();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    code_verifier: params.verifier,
  });

  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new Error("Token response had no id_token");
  }
  if (!jwks) await discovery();

  const { payload } = await jwtVerify(tokens.id_token, jwks!, {
    issuer: d.issuer,
    audience: config.oidc.clientId,
  });

  if (payload.nonce !== params.expectedNonce) {
    throw new Error("OIDC nonce mismatch");
  }

  return payload as IdClaims;
}

export async function endSessionUrl(): Promise<string | null> {
  const d = await discovery();
  if (!d.end_session_endpoint) return null;

  const url = new URL(d.end_session_endpoint);
  url.searchParams.set("post_logout_redirect_uri", config.appUrl);
  url.searchParams.set("client_id", config.oidc.clientId);
  return url.toString();
}
