import { config } from "../config.ts";
import { sql } from "../db/index.ts";
import { destroyAllSessions } from "../auth/session.ts";

interface PocketIdUser {
  id: string;
  username: string;
  disabled: boolean;
}

interface PocketIdUserPage {
  data: PocketIdUser[];
}

async function fetchAllUsers(): Promise<PocketIdUser[]> {
  const users: PocketIdUser[] = [];
  const limit = 100;
  let page = 1;

  for (;;) {
    const url = new URL(`${config.oidc.issuer}/api/users`);
    url.searchParams.set("pagination[page]", String(page));
    url.searchParams.set("pagination[limit]", String(limit));

    const res = await fetch(url, {
      headers: { "X-API-KEY": config.pocketId.apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable body>");
      throw new Error(
        `PocketID user list request failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as PocketIdUserPage;
    users.push(...body.data);

    if (body.data.length < limit) break; // last page
    page++;
  }

  return users;
}

export async function pollDisabledUsers(): Promise<void> {
  if (!config.pocketId.apiKey) return;

  const allUsers = await fetchAllUsers();
  const disabledIds = allUsers.filter((u) => u.disabled).map((u) => u.id);

  console.log(
    `pocketid-guard: checked ${allUsers.length} PocketID user(s), ${disabledIds.length} disabled`,
  );
  if (disabledIds.length === 0) return;

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE oidc_sub = ANY(${disabledIds})
  `;
  if (rows.length === 0) return;

  for (const row of rows) {
    await destroyAllSessions(row.id);
  }
  console.log(
    `pocketid-guard: revoked sessions for ${rows.length} disabled user(s)`,
  );
}

export function startPocketIdGuard(): void {
  if (!config.pocketId.apiKey) {
    console.log(
      "pocketid-guard: MUSIC_POCKETID_API_KEY not set, disabled-user polling is off",
    );
    return;
  }

  const maskedKey =
    config.pocketId.apiKey.length > 4
      ? `${"*".repeat(config.pocketId.apiKey.length - 4)}${config.pocketId.apiKey.slice(-4)}`
      : "****";
  console.log(
    `pocketid-guard: starting, polling ${config.oidc.issuer}/api/users every ${config.pocketId.pollIntervalMs}ms (key ${maskedKey})`,
  );

  const run = () => {
    pollDisabledUsers().catch((err) => {
      // Log the full error, not just the message — auth/network failures
      // (401, DNS, TLS, wrong issuer URL) all need to be visible here,
      // since a silent failure here is exactly what this file exists to
      // avoid for user sessions.
      console.error("pocketid-guard: poll failed:", err);
    });
  };

  run(); // catch anyone already disabled before this process started
  setInterval(run, config.pocketId.pollIntervalMs);
}