// Native (Android) audio backend.
//
// On the web and in the Tauri desktop webview the Player drives a real
// HTMLAudioElement. Inside the native Android shell (apps/android) a bare
// WebView can't do reliable background/locked playback or surface a media
// notification, so audio is played by a native Media3/ExoPlayer engine instead.
//
// `NativeAudio` implements exactly the slice of HTMLAudioElement the Player
// uses, but every call is forwarded across the JS ⇄ native bridge
// (`window.DmndNative`), and playback state comes back from native via
// `window.__dmndNative.*`. The Player itself is unchanged — it just talks to a
// different "audio element". See apps/android/BRIDGE.md for the contract.

// The subset of HTMLAudioElement the Player relies on. A real HTMLAudioElement
// already satisfies this; NativeAudio emulates it.
export interface MediaEl {
  volume: number;
  preload: string;
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly playbackRate: number;
  readonly readyState: number;
  readonly error: { readonly code: number } | null;
  readonly style: { display: string };
  setAttribute(name: string, value: string): void;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, cb: (ev?: unknown) => void, opts?: { once?: boolean }): void;
  removeEventListener(type: string, cb: (ev?: unknown) => void): void;
  // Native-only: hand the current track's metadata to the OS notification.
  setMetadata?(meta: NativeTrackMeta): void;
}

export interface NativeTrackMeta {
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  durationS: number | null;
}

// The injected native interface (Android @JavascriptInterface).
interface NativeHost {
  setTrack(url: string, metadataJson: string, autoplay: boolean): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(v: number): void;
  ready(): boolean;
}

type Listener = (ev?: unknown) => void;

export function hasNativeHost(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { DmndNative?: NativeHost }).DmndNative !== "undefined" &&
    typeof (window as unknown as { DmndNative?: NativeHost }).DmndNative?.ready === "function"
  );
}

// Return the element the Player should drive: native-backed inside the Android
// shell, a real <audio> everywhere else.
export function createAudioElement(): MediaEl {
  if (hasNativeHost()) {
    return new NativeAudio((window as unknown as { DmndNative: NativeHost }).DmndNative);
  }
  return new Audio() as unknown as MediaEl;
}

function toAbsolute(url: string): string {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : undefined).href;
  } catch {
    return url;
  }
}

export class NativeAudio implements MediaEl {
  // Emulated element state — kept in sync from native callbacks.
  private _src = "";
  private _dirty = false; // src changed since the last setTrack()
  private _currentTime = 0;
  private _duration = 0;
  private _paused = true;
  private _volume = 1;
  private _meta = "{}";
  private _error: { code: number } | null = null;
  private listeners = new Map<string, Set<Listener>>();

  preload = "metadata";
  readonly style = { display: "" };

  constructor(private host: NativeHost) {
    installNativeCallbacks(this);
  }

  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = v;
    this.host.setVolume(v);
    this.emit("volumechange");
  }

  get src(): string {
    return this._src;
  }
  set src(url: string) {
    const abs = toAbsolute(url);
    if (abs !== this._src) {
      this._src = abs;
      this._dirty = true;
      this._duration = 0;
      this._currentTime = 0;
      this._error = null;
    }
  }

  get currentTime(): number {
    return this._currentTime;
  }
  set currentTime(t: number) {
    this._currentTime = t;
    this.host.seek(t);
  }

  get duration(): number {
    return this._duration;
  }
  get paused(): boolean {
    return this._paused;
  }
  get error(): { code: number } | null {
    return this._error;
  }
  get playbackRate(): number {
    return 1;
  }
  // Native owns buffering/recovery, so always report "enough to play through"
  // (HAVE_ENOUGH_DATA) once we have a duration — this keeps the Player's web
  // stall-watchdog from firing against state it can't see.
  get readyState(): number {
    return this._duration > 0 ? 4 : 0;
  }

  setAttribute(): void {
    /* playsinline / controlsList etc. are meaningless natively */
  }

  setMetadata(meta: NativeTrackMeta): void {
    this._meta = JSON.stringify(meta);
    // Metadata that arrives for an already-loaded track (rare) → refresh the
    // notification in place. The normal path is src → setMetadata → play(),
    // where play() sends the combined setTrack.
    if (!this._dirty && this._src) {
      this.host.setTrack(this._src, this._meta, !this._paused);
    }
  }

  load(): void {
    if (!this._src) return;
    this._dirty = false;
    this.host.setTrack(this._src, this._meta, false);
  }

  play(): Promise<void> {
    if (this._dirty) {
      this._dirty = false;
      this.host.setTrack(this._src, this._meta, true);
    } else {
      this.host.play();
    }
    // Native play never throws the way HTMLMediaElement.play() can, so there's
    // nothing for the Player's AbortError/autoplay handling to catch.
    return Promise.resolve();
  }

  pause(): void {
    this.host.pause();
  }

  addEventListener(type: string, cb: Listener, opts?: { once?: boolean }): void {
    const wrapped: Listener = opts?.once
      ? (ev) => {
          this.removeEventListener(type, wrapped);
          cb(ev);
        }
      : cb;
    // Track under the original cb so removeEventListener(cb) still works.
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(wrapped);
    if (wrapped !== cb) this.onceMap.set(cb, wrapped);
  }

  removeEventListener(type: string, cb: Listener): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(cb);
    const wrapped = this.onceMap.get(cb);
    if (wrapped) {
      set.delete(wrapped);
      this.onceMap.delete(cb);
    }
  }

  private onceMap = new Map<Listener, Listener>();

  // ---- called by native via window.__dmndNative ----
  _onReady(): void {
    this.emit("loadedmetadata");
    this.emit("canplay");
  }
  _onPosition(pos: number, dur: number): void {
    this._currentTime = pos;
    if (dur > 0 && dur !== this._duration) {
      this._duration = dur;
      this.emit("durationchange");
      this.emit("loadedmetadata");
    }
    this.emit("timeupdate");
  }
  _onPlay(): void {
    this._paused = false;
    this.emit("play");
  }
  _onPause(): void {
    this._paused = true;
    this.emit("pause");
  }
  _onEnded(): void {
    this.emit("ended");
  }
  _onError(_message: string): void {
    // Present it like a recoverable HTMLMediaElement network error (code 2) so
    // the Player's existing error handler re-fetches and resumes via native.
    this._error = { code: 2 };
    this.emit("error");
  }

  private emit(type: string, ev?: unknown): void {
    this.listeners.get(type)?.forEach((cb) => {
      try {
        cb(ev);
      } catch {
        /* a listener throwing must not break the bridge */
      }
    });
  }
}

// Expose the native → web callbacks. Merges rather than overwrites so the
// app-level transport handler (window.__dmndNative.onTransport, set in
// web/client/src/native.ts) survives, and vice-versa.
function installNativeCallbacks(a: NativeAudio): void {
  const w = window as unknown as { __dmndNative?: Record<string, unknown> };
  w.__dmndNative = {
    ...(w.__dmndNative ?? {}),
    onReady: () => a._onReady(),
    onPosition: (p: number, d: number) => a._onPosition(p, d),
    onPlay: () => a._onPlay(),
    onPause: () => a._onPause(),
    onEnded: () => a._onEnded(),
    onError: (m: string) => a._onError(m),
  };
}
