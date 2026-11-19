import { createContext, onCleanup, onMount, Show, useContext, type JSX } from 'solid-js';

/**
 * A note that floats over the message list. The shell provides it; every track with a message
 * list wraps its list in a StreamFrame, and the frame shows the note over the list only. The note
 * is never a child of the list itself, so it is not a message: scrolling, counting and the list's
 * own text are untouched.
 */
export type StreamNote = {
  /** True while the note should float over the message list. */
  show: () => boolean;
  /** The note itself. */
  note: () => JSX.Element;
  /** A frame came (+1) or went (-1); with no frame the shell shows the note in the column. */
  frame: (delta: 1 | -1) => void;
};

export const StreamNoteContext = createContext<StreamNote | null>(null);

export function StreamFrame(props: { children: JSX.Element }) {
  const ctx = useContext(StreamNoteContext);
  onMount(() => {
    if (!ctx) return;
    ctx.frame(1);
    onCleanup(() => ctx.frame(-1));
  });
  return (
    <div class="stream-frame">
      {/* First in reading order, as before; it paints over the list by its own stacking. */}
      <Show when={ctx?.show()}>
        <div class="stream-note-layer">{ctx!.note()}</div>
      </Show>
      {props.children}
    </div>
  );
}
