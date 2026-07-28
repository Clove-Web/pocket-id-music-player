// Controller around a single <audio> element, with shuffle, repeat, volume.
// Works unchanged in a browser tab or a Tauri desktop webview — both give
// us a real HTMLAudioElement/AudioContext/localStorage, so there's no
// platform abstraction here beyond the injectable prefs storage.

import type { Song } from "@musicapp/shared";

import { Emitter } from "./events.ts";
import { localStoragePrefs, type Prefs, type PrefsStorage } from "./storage.ts";

export type RepeatMode = Prefs["repeat"];

type PlayerEvents = {
  change: [];
  trackchange: [Song];
  error: [string];
};

export class Player {
  readonly events = new Emitter<PlayerEvents>();

  private audio = new Audio();
  private storage: PrefsStorage;
  private queue: Song[] = []; // playback order (shuffled or not)
  private originalOrder: Song[] = []; // order as given to playQueue, never shuffled
  private index = -1;
  private lastTrackChangeId: string | null = null;
  private playToken = 0; // bumped on every load(); see tryPlay()
  private prefs: Prefs;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  // iOS ignores HTMLMediaElement.volume (hardware-controlled). Detect so the
  // UI can hide the volume slider there.
  readonly volumeSupported = !isIOS();

  constructor(storage: PrefsStorage = localStoragePrefs) {
    this.storage = storage;
    this.prefs = { volume: 1, shuffle: false, repeat: "off", ...this.storage.load() };

    this.audio.volume = this.prefs.volume;
    // iOS needs these: inline playback + the element attached to the document.
    this.audio.preload = "metadata";
    this.audio.setAttribute("playsinline", "");
    this.audio.setAttribute("webkit-playsinline", "");
    this.audio.setAttribute("controlsList", "nodownload");
    if (typeof document !== "undefined") {
      this.audio.style.display = "none";
      document.body.appendChild(this.audio);
    }

    this.audio.addEventListener("ended", () => this.onEnded());
    this.audio.addEventListener("timeupdate", () => this.events.emit("change"));
    this.audio.addEventListener("play", () => this.events.emit("change"));
    this.audio.addEventListener("pause", () => this.events.emit("change"));
    this.audio.addEventListener("volumechange", () => this.events.emit("change"));
    this.audio.addEventListener("error", () => {
      const err = this.audio.error;
      if (err) this.events.emit("error", `Audio error (code ${err.code})`);
    });
  }

  get current(): Song | null {
    return this.queue[this.index] ?? null;
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  get volume(): number {
    return this.prefs.volume;
  }

  get shuffle(): boolean {
    return this.prefs.shuffle;
  }

  get repeat(): RepeatMode {
    return this.prefs.repeat;
  }

  get progress(): { current: number; duration: number } {
    return {
      current: this.audio.currentTime || 0,
      duration: this.audio.duration || 0,
    };
  }

  // Start a fresh queue. `startAt` indexes into `songs` as given; if shuffle is
  // on, that song plays first and the rest are shuffled after it.
  playQueue(songs: Song[], startAt = 0): void {
    this.originalOrder = songs.slice();
    if (this.prefs.shuffle) {
      const first = songs[startAt];
      const rest = songs.filter((_, i) => i !== startAt);
      this.queue = first ? [first, ...shuffleArray(rest)] : shuffleArray(rest);
      this.index = 0;
    } else {
      this.queue = songs.slice();
      this.index = startAt;
    }
    this.load();
  }

  toggle(): void {
    if (this.audio.paused) this.tryPlay();
    else this.audio.pause();
  }

  next(): void {
    if (this.index < this.queue.length - 1) {
      this.index++;
      this.load();
    } else if (this.prefs.repeat === "all" && this.queue.length > 0) {
      this.index = 0;
      this.load();
    }
  }

  prev(): void {
    // Restart the track if we're more than 3s in; otherwise go back one.
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    if (this.index > 0) {
      this.index--;
      this.load();
    }
  }

  seek(seconds: number): void {
    this.audio.currentTime = seconds;
  }

  setVolume(v: number): void {
    this.prefs.volume = Math.min(1, Math.max(0, v));
    this.audio.volume = this.prefs.volume;
    this.save();
  }

  toggleShuffle(): void {
    this.prefs.shuffle = !this.prefs.shuffle;
    this.save();
    this.reshuffleQueue();
    this.events.emit("change");
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ["off", "all", "one"];
    const nextIdx = (order.indexOf(this.prefs.repeat) + 1) % order.length;
    this.prefs.repeat = order[nextIdx]!;
    this.save();
    this.events.emit("change");
  }

  private onEnded(): void {
    if (this.prefs.repeat === "one") {
      this.audio.currentTime = 0;
      this.tryPlay();
      const song = this.current;
      if (song) this.events.emit("trackchange", song); // same track, but a fresh listen
      return;
    }
    this.next();
  }

  // Re-derives the playback queue for the current shuffle preference. The
  // song that's currently playing stays right where it is (nothing skips or
  // restarts) — only the order of the *other* songs changes. This is what
  // was missing before: toggling the shuffle button used to only affect the
  // *next* playQueue() call, so it looked like shuffle "did nothing" if you
  // toggled it mid-playback.
  private reshuffleQueue(): void {
    const current = this.current;
    if (!current || this.originalOrder.length === 0) return;

    if (this.prefs.shuffle) {
      const rest = this.originalOrder.filter((s) => s.id !== current.id);
      this.queue = [current, ...shuffleArray(rest)];
    } else {
      this.queue = this.originalOrder.slice();
    }
    const idx = this.queue.findIndex((s) => s.id === current.id);
    this.index = idx >= 0 ? idx : 0;
  }

  private load(): void {
    const song = this.current;
    if (!song) return;
    const changed = song.id !== this.lastTrackChangeId;

    // Each load supersedes any in-flight play(). This token lets tryPlay()
    // tell "my play() was interrupted because a newer track started" (an
    // expected AbortError we should ignore) apart from a real failure.
    const token = ++this.playToken;

    this.audio.src = song.streamUrl;
    this.audio.volume = this.prefs.volume;
    // NB: deliberately NO explicit audio.load() here. Assigning .src already
    // kicks off loading; calling .load() in the same tick as play() is the
    // canonical cause of "The play() request was interrupted by a call to
    // load()" — the AbortError users were seeing on every track change.
    this.tryPlay(token);

    this.events.emit("change");
    if (changed) {
      this.lastTrackChangeId = song.id;
      this.events.emit("trackchange", song);
    }
  }

  // Web Audio analyser for the visualizer. Exposed for the canvas draw loop.
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  // Snapshot of the current session, for resume-after-reload.
  snapshot(): { ids: string[]; index: number; position: number } | null {
    if (!this.current) return null;
    return {
      ids: this.queue.map((s) => s.id),
      index: this.index,
      position: this.audio.currentTime || 0,
    };
  }

  // Load a saved queue WITHOUT autoplaying; seek once metadata is ready.
  restore(songs: Song[], index: number, position: number): void {
    if (!songs.length) return;
    this.queue = songs;
    this.originalOrder = songs.slice();
    this.index = Math.min(Math.max(index, 0), songs.length - 1);
    const song = this.current;
    if (!song) return;
    this.audio.src = song.streamUrl;
    this.audio.load();
    const onMeta = () => {
      try {
        this.audio.currentTime = position;
      } catch {
        /* ignore */
      }
      this.audio.removeEventListener("loadedmetadata", onMeta);
      this.events.emit("change");
    };
    this.audio.addEventListener("loadedmetadata", onMeta);
    this.events.emit("change");
  }

  // Build the Web Audio graph once (source -> analyser -> speakers). Wrapped so
  // any failure leaves plain <audio> playback untouched.
  private setupGraph(): void {
    if (this.ctx) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(this.audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  // Play the current element and surface only *real* failures. `token` ties
  // this attempt to the load() that started it: if a newer track has since
  // loaded, the play() promise rejects with AbortError and we ignore it (it
  // was superseded on purpose). A genuine "element wasn't ready yet" abort is
  // retried once on `canplay`; autoplay-policy blocks get a friendlier note.
  private tryPlay(token = this.playToken, retried = false): void {
    this.setupGraph();
    void this.ctx?.resume();

    const p = this.audio.play();
    if (!p || typeof p.catch !== "function") return;

    p.catch((err: unknown) => {
      // A newer track load already moved on — this rejection is expected.
      if (token !== this.playToken) return;

      const name = (err as { name?: string })?.name ?? "Error";

      if (name === "AbortError") {
        // The element wasn't ready when play() was called. Retry once as soon
        // as it can play, still guarded by the token so a later skip wins.
        if (retried) return;
        this.audio.addEventListener(
          "canplay",
          () => this.tryPlay(token, true),
          { once: true },
        );
        return;
      }

      if (name === "NotAllowedError") {
        // Autoplay policy blocked us (no user gesture yet) — nothing broke.
        this.events.emit("error", "Tap play to start");
        return;
      }

      this.events.emit("error", `Can't play (${name})`);
    });
  }

  private save(): void {
    this.storage.save(this.prefs);
  }
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPhone/iPod/iPad, plus iPadOS 13+ which reports as Mac with touch.
  return (
    /iP(hone|od|ad)/.test(ua) ||
    (ua.includes("Macintosh") && "ontouchend" in document)
  );
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
