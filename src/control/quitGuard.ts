import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';

/** The parts of a Tauri window this guard uses (getCurrentWindow() on desktop). */
export type ClosableWindow = {
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
};

/**
 * Closing the window during a live call asks first: "You are in a call with X.
 * End it and quit?". Display only: confirming closes the window exactly as an
 * unguarded close does, and staying changes nothing. The listener exists only
 * while a call is live, so every other close is untouched.
 */
export function createCallQuitGuard(inCallWith: () => string | null, win: () => ClosableWindow | null) {
  const [asking, setAsking] = createSignal<string | null>(null);
  const live = createMemo(() => inCallWith() !== null);
  createEffect(() => {
    if (!live()) { setAsking(null); return; }
    let w: ClosableWindow | null;
    try { w = win(); } catch { return; /* No window API here: nothing to guard. */ }
    if (!w) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    w.onCloseRequested((event) => {
      const name = inCallWith();
      if (name === null) return;
      event.preventDefault();
      setAsking(name);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }, () => { /* No window API: nothing to guard. */ });
    onCleanup(() => { disposed = true; unlisten?.(); });
  });
  return {
    asking,
    stay: () => setAsking(null),
    quit: () => {
      setAsking(null);
      try { void win()?.destroy().catch(() => { /* The window is already gone. */ }); } catch { /* No window API. */ }
    },
  };
}
