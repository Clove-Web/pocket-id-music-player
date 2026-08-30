// Discord Rich Presence over the local Discord IPC socket. Ported 1:1 from the
// old Rust `discord.rs` (Discord Social SDK) — same payload, no OAuth, no
// native SDK. `@xhayper/discord-rpc` handles the per-platform pipe/socket
// discovery; we only ever SetActivity / ClearActivity.
//
// Everything here is best-effort: if Discord isn't running the connect just
// fails and we retry on the next update. Nothing throws to the caller.

import { Client } from "@xhayper/discord-rpc";

// Doughmination Music Discord application id (Rich Presence).
const CLIENT_ID = "1531598882595930143";
const LISTENING = 2; // discord ActivityType.Listening

export type NowPlaying = {
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  coverUrl: string | null;
  positionS: number;
  playing: boolean;
};

let client: Client | null = null;
let connected = false;
let connecting: Promise<boolean> | null = null;

async function ensureConnected(): Promise<boolean> {
  if (connected && client) return true;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = new Client({ clientId: CLIENT_ID });
      c.on("disconnected", () => {
        connected = false;
      });
      await c.login();
      client = c;
      connected = true;
      return true;
    } catch {
      client = null;
      connected = false;
      return false;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export async function setNowPlaying(np: NowPlaying): Promise<void> {
  if (!(await ensureConnected()) || !client?.user) return;

  const state = np.album ? `${np.artist} — ${np.album}` : np.artist;
  const activity: Record<string, unknown> = {
    type: LISTENING,
    details: np.title,
    state,
    instance: false,
  };

  // Elapsed/remaining bar only while actually playing — anchor `start` back by
  // the current position so a resumed track shows real elapsed time.
  if (np.playing && np.durationS && np.durationS > 0) {
    const start = Date.now() - Math.max(0, np.positionS) * 1000;
    activity.startTimestamp = Math.round(start);
    activity.endTimestamp = Math.round(start + np.durationS * 1000);
  }

  if (np.coverUrl) {
    activity.largeImageKey = np.coverUrl;
    const tooltip = np.album ?? np.title;
    if (tooltip.length >= 2 && tooltip.length <= 128) {
      activity.largeImageText = tooltip;
    }
  }

  try {
    await client.user.setActivity(activity as Parameters<typeof client.user.setActivity>[0]);
  } catch {
    connected = false; // drop the connection so the next update reconnects
  }
}

export async function clear(): Promise<void> {
  if (!connected || !client?.user) return;
  try {
    await client.user.clearActivity();
  } catch {
    connected = false;
  }
}
