import { createSignal } from 'solid-js';

/** Claim an entrance once per logical message for this shell session, even across navigation. */
export function createMessageEntrance(key: string, arrived: boolean, seen: Set<string>) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [fresh, setFresh] = createSignal(arrived && !seen.has(key) && !reduced);
  // History is seen too: a later socket echo must not make it new again.
  seen.add(key);
  return { fresh, finish: () => setFresh(false) };
}
