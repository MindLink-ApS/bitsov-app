// One Escape at a time: only the most recently opened dialog, sheet or menu
// closes. Each opener registers while it is open; one window listener calls
// the top entry. Before this, every open layer had its own window listener, so
// Escape in Settings also cancelled a meeting plan underneath it.

type Entry = { close: () => void };
const stack: Entry[] = [];

function onKey(e: KeyboardEvent) {
  // A focused dialog that handled Escape itself (e.g. the pairing dialog) wins.
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

/** Register `close` as the topmost Escape target; call the returned function when the layer closes. */
export function onEscape(close: () => void): () => void {
  const entry: Entry = { close };
  if (stack.length === 0 && typeof window !== 'undefined') window.addEventListener('keydown', onKey);
  stack.push(entry);
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0 && typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
  };
}

/** Open layers, for tests. */
export const escapeDepth = () => stack.length;
