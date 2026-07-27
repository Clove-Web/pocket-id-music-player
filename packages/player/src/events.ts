// Minimal typed multi-listener emitter. Replaces the old single-callback
// `onChange`/`onTrackChange`/`onError` properties on Player, which could
// only ever have one subscriber — the UI. That meant the UI's render loop
// and the Last.fm scrobble-threshold check had to be hand-merged into one
// closure (see the old web/app.ts). With a real emitter, the UI and any
// number of integrations can each subscribe independently.
export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<(...args: any[]) => void>>();

  on<K extends keyof Events>(
    event: K,
    handler: (...args: Events[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: any[]) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(
    event: K,
    handler: (...args: Events[K]) => void,
  ): void {
    this.listeners.get(event)?.delete(handler as (...args: any[]) => void);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    this.listeners.get(event)?.forEach((handler) => handler(...args));
  }
}
