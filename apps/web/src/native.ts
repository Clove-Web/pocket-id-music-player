// Native Android shell integration, mirroring desktop.ts for the Tauri build.
//
// When the web app runs inside apps/android, audio is played by a native
// Media3 engine and the Player already routes playback through it (see
// packages/player/src/native-audio.ts). The one thing the audio backend can't
// do on its own is resolve "next"/"prev" pressed on the *notification / lock
// screen*, because those must run the web queue. That's wired here.

import { hasNativeHost, type Player } from "@musicapp/player";

export const isNativeAndroid = hasNativeHost();

// Route notification/lock-screen transport buttons back into the web queue.
// The Player then loads the new song, which calls setTrack() on native again.
export function initNative(player: Player): void {
  if (!isNativeAndroid) return;

  const w = window as unknown as {
    __dmndNative?: Record<string, unknown>;
  };
  w.__dmndNative = {
    ...(w.__dmndNative ?? {}),
    onTransport: (cmd: string) => {
      if (cmd === "next") player.next();
      else if (cmd === "prev") player.prev();
    },
  };
}
