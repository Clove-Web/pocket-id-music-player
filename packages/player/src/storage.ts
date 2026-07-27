// Volume/shuffle/repeat persistence, pulled behind an interface so the
// Player class itself doesn't hard-depend on localStorage. Both the web
// app and the Tauri desktop app can use the default localStorage-backed
// implementation as-is (Tauri's webview supports it natively) — this
// exists so a future non-webview client (or a "sync prefs across devices"
// feature) has somewhere to plug in without touching Player.
export type Prefs = {
  volume: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
};

export interface PrefsStorage {
  load(): Partial<Prefs> | null;
  save(prefs: Prefs): void;
}

const PREFS_KEY = "music:prefs";

export const localStoragePrefs: PrefsStorage = {
  load() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? (JSON.parse(raw) as Partial<Prefs>) : null;
    } catch {
      return null;
    }
  },
  save(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  },
};
