import { createSignal, type JSX, onCleanup, onMount } from 'solid-js';
import { t as tr } from '../i18n';
import { onEscape } from './escapeStack';

/**
 * The video area of a call: their picture large, yours small. Presentation
 * only; the media, its quality and its payment are untouched.
 *
 * - Full screen: the button, a double-click on the picture, Esc to leave.
 *   The DOM Fullscreen API on this area (the webview allows element full
 *   screen); where it is missing or refused, the area fills the window instead.
 * - The call window can be moved and resized (pointer or arrow keys), within
 *   the window and to at most 70% of its width, so the chat stays usable beside it.
 * - Your own picture moves between the four corners (drag, click or arrow keys).
 */
export type SelfCorner = 'br' | 'bl' | 'tr' | 'tl';
const CORNERS: SelfCorner[] = ['br', 'bl', 'tl', 'tr'];
const MIN_WIDTH = 280;
const STEP = 24;
const SIZE_STEP = 40;

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fullscreenElement = () => {
  const doc = document as FullscreenDoc;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
};

/** Largest call window: the chat keeps at least 30% of the window beside it. */
export const maxPanelWidth = (viewport: number) => Math.min(960, Math.floor(viewport * 0.7));
/** Smallest call window: 280 px, or less where 70% of the window is less. */
export const minPanelWidth = (viewport: number) => Math.min(MIN_WIDTH, maxPanelWidth(viewport));

/** How far a press may wander and still count as a tap on your own picture (pointer jitter, a touch). */
export const TAP_SLOP_PX = 8;

export function CallVideoStage(props: {
  /** The call window this area sits in: moved and resized as a whole. */
  panel: () => HTMLElement | undefined;
  remote: JSX.Element;
  self: JSX.Element;
  cameraOff: boolean;
}) {
  let stage: HTMLDivElement | undefined;
  const [full, setFull] = createSignal<'native' | 'window' | null>(null);
  const [corner, setCorner] = createSignal<SelfCorner>('br');
  const [width, setWidth] = createSignal<number | null>(null);
  const [maxWidth, setMaxWidth] = createSignal(maxPanelWidth(window.innerWidth));
  let releaseEscape: (() => void) | null = null;
  /** Set once the stage is gone (the call ended): no late drag or resize writes geometry again. */
  let disposed = false;
  /** Drags in progress: each removes its own window listeners. Ended all at once on dispose. */
  const drags = new Set<() => void>();
  const follow = (move: (m: PointerEvent) => void) => {
    const guarded = (m: PointerEvent) => { if (!disposed) move(m); };
    const up = () => {
      window.removeEventListener('pointermove', guarded);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      drags.delete(up);
    };
    window.addEventListener('pointermove', guarded);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    drags.add(up);
  };

  const leaveWindowFill = () => {
    releaseEscape?.();
    releaseEscape = null;
    if (full() === 'window') setFull(null);
  };
  const fillWindow = () => {
    // A request that settles after the call ended registers nothing.
    if (disposed) return;
    setFull('window');
    releaseEscape?.();
    releaseEscape = onEscape(leaveWindowFill);
  };
  const toggleFullscreen = async () => {
    if (!stage) return;
    if (full() === 'window') { leaveWindowFill(); return; }
    const doc = document as FullscreenDoc;
    if (fullscreenElement() === stage) {
      try { await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.()); } catch { /* already left */ }
      setFull(null);
      return;
    }
    const el = stage as FullscreenEl;
    const request = el.requestFullscreen ? () => el.requestFullscreen() : el.webkitRequestFullscreen ? () => el.webkitRequestFullscreen!() : null;
    const enabled = doc.fullscreenEnabled !== false || !!el.webkitRequestFullscreen;
    if (!request || !enabled) { fillWindow(); return; }
    try {
      await request();
      if (disposed) {
        // Granted after the call ended: leave full screen again, nothing to show.
        try { await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.()); } catch { /* already left */ }
        return;
      }
      setFull('native');
    } catch {
      // Refused (no user gesture, a webview without element full screen): fill the window instead.
      fillWindow();
    }
  };
  const fullscreenChanged = () => {
    if (full() === 'native' && fullscreenElement() !== stage) setFull(null);
  };
  onMount(() => {
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  });
  onCleanup(() => {
    disposed = true;
    for (const end of [...drags]) end();
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    document.removeEventListener('webkitfullscreenchange', fullscreenChanged);
    releaseEscape?.();
    if (stage && fullscreenElement() === stage) {
      const doc = document as FullscreenDoc;
      try { void (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.())?.catch?.(() => {}); } catch { /* gone */ }
    }
    // The call window goes back to its own place and size for the next call.
    const panel = props.panel();
    if (panel) for (const p of ['right', 'bottom', 'width']) panel.style.removeProperty(p);
    panel?.removeAttribute('data-call-window-moved');
  });

  // ---- moving and resizing the call window ----
  const place = () => {
    const panel = props.panel();
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      panel,
      right: panel.style.right ? parseFloat(panel.style.right) : Math.max(0, window.innerWidth - rect.right),
      bottom: panel.style.bottom ? parseFloat(panel.style.bottom) : Math.max(0, window.innerHeight - rect.bottom),
      width: panel.style.width ? parseFloat(panel.style.width) : rect.width || 340,
      height: rect.height,
    };
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const moveTo = (right: number, bottom: number, width?: number) => {
    if (disposed) return;
    const p = place();
    if (!p) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = clamp(width ?? p.width, minPanelWidth(vw), maxPanelWidth(vw));
    p.panel.style.width = `${Math.round(w)}px`;
    setWidth(Math.round(w));
    setMaxWidth(maxPanelWidth(vw));
    p.panel.style.right = `${Math.round(clamp(right, 0, vw - w))}px`;
    // The card is taller once wider (its video is 4:3): measure it at the new width before placing it.
    const height = p.panel.getBoundingClientRect().height || p.height;
    p.panel.style.bottom = `${Math.round(clamp(bottom, 0, vh - Math.min(height, vh)))}px`;
    p.panel.setAttribute('data-call-window-moved', '');
  };
  /** The app window changed size: a moved or resized call window keeps the 70% cap and stays inside. */
  const viewportChanged = () => {
    const p = place();
    if (p?.panel.hasAttribute('data-call-window-moved')) moveTo(p.right, p.bottom, p.width);
    else setMaxWidth(maxPanelWidth(window.innerWidth));
  };
  onMount(() => window.addEventListener('resize', viewportChanged));
  onCleanup(() => window.removeEventListener('resize', viewportChanged));
  const moveBy = (dx: number, dy: number) => { const p = place(); if (p) moveTo(p.right - dx, p.bottom - dy); };
  /** The window keeps its right edge; growing widens it to the left. */
  const resizeBy = (d: number) => { const p = place(); if (p) moveTo(p.right, p.bottom, p.width + d); };

  const drag = (e: PointerEvent, onMove: (dx: number, dy: number, start: NonNullable<ReturnType<typeof place>>) => void) => {
    const start = place();
    if (!start || e.button > 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    const move = (m: PointerEvent) => onMove(m.clientX - x0, m.clientY - y0, start);
    follow(move);
  };
  const arrows = (e: KeyboardEvent, by: (dx: number, dy: number) => void, step: number) => {
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    by(d[0], d[1]);
  };

  // ---- your own picture ----
  const nextCorner = () => setCorner(CORNERS[(CORNERS.indexOf(corner()) + 1) % CORNERS.length]);
  const selfKeys = (e: KeyboardEvent) => {
    const c = corner();
    const v = c[0] as 'b' | 't';
    const h = c[1] as 'r' | 'l';
    const to: Record<string, SelfCorner> = { ArrowLeft: `${v}l`, ArrowRight: `${v}r`, ArrowUp: `t${h}`, ArrowDown: `b${h}` } as Record<string, SelfCorner>;
    if (to[e.key]) { e.preventDefault(); setCorner(to[e.key]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextCorner(); }
  };
  let selfMoved = false;
  const selfDrag = (e: PointerEvent) => {
    if (!stage || e.button > 0) return;
    e.stopPropagation();
    selfMoved = false;
    const box = stage.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (m: PointerEvent) => {
      if (!box.width || !box.height) return;
      // A tap's small wobble is still a tap: only a real move is a drag, and only a drag moves the picture.
      if (!selfMoved && Math.hypot(m.clientX - startX, m.clientY - startY) < TAP_SLOP_PX) return;
      selfMoved = true;
      const x = (m.clientX - box.left) / box.width;
      const y = (m.clientY - box.top) / box.height;
      setCorner(`${y < 0.5 ? 't' : 'b'}${x < 0.5 ? 'l' : 'r'}` as SelfCorner);
    };
    follow(move);
  };

  return (
    <div
      ref={stage}
      class="call-videos"
      data-call-stage
      data-call-fullscreen={full() ?? undefined}
      role="group"
      aria-label={tr('caVideoStageLabel')}
      onDblClick={(e) => {
        // A double-click on your own picture or a control is not a full-screen request.
        if ((e.target as HTMLElement).closest('[data-call-self], [data-call-stage-controls]')) return;
        void toggleFullscreen();
      }}
    >
      {props.remote}
      {/* Your own picture, named and shown as in a mirror; with the camera off it says so instead of going black. */}
      <div
        class="call-self" data-call-self data-camera-off={props.cameraOff ? '' : undefined} data-corner={corner()}
        role="button" tabindex="0" aria-label={tr('caVideoSelfMove')}
        onPointerDown={selfDrag}
        onClick={() => { if (!selfMoved) nextCorner(); selfMoved = false; }}
        onKeyDown={selfKeys}
      >
        {props.self}
      </div>
      <div class="call-stage-controls" data-call-stage-controls>
        <button
          type="button" class="call-stage-btn" data-call-move aria-label={tr('caVideoMove')} title={tr('caVideoMove')}
          hidden={full() !== null}
          onPointerDown={(e) => drag(e, (dx, dy, s) => moveTo(s.right - dx, s.bottom - dy))}
          onKeyDown={(e) => arrows(e, moveBy, STEP)}
        ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l2.5 2.5h-1.75v3.75h3.75V5.5L15 8l-2.5 2.5V8.75H8.75v3.75h1.75L8 15l-2.5-2.5h1.75V8.75H3.5v1.75L1 8l2.5-2.5v1.75h3.75V3.5H5.5z" fill="currentColor" /></svg></button>
        {/* Wider to the left (Left/Up), narrower (Right/Down); the window keeps its right edge. */}
        <div
          class="call-stage-btn" data-call-resize role="slider" tabindex="0" title={tr('caVideoResize')}
          aria-label={tr('caVideoResize')} aria-orientation="horizontal"
          aria-valuemin={Math.min(MIN_WIDTH, maxWidth())} aria-valuemax={maxWidth()}
          aria-valuenow={width() ?? 340}
          hidden={full() !== null}
          onPointerDown={(e) => drag(e, (dx, _dy, s) => moveTo(s.right, s.bottom, s.width - dx))}
          onKeyDown={(e) => {
            const d = ({ ArrowLeft: SIZE_STEP, ArrowUp: SIZE_STEP, ArrowRight: -SIZE_STEP, ArrowDown: -SIZE_STEP } as Record<string, number>)[e.key];
            if (d) { e.preventDefault(); resizeBy(d); }
          }}
        ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M2 2l5 5M14 10v4h-4M14 14l-5-5" stroke="currentColor" stroke-width="1.6" fill="none" /></svg></div>
        <button
          type="button" class="call-stage-btn" data-call-fullscreen-toggle
          aria-pressed={full() !== null}
          aria-label={full() !== null ? tr('caVideoExitFullscreen') : tr('caVideoFullscreen')}
          title={full() !== null ? tr('caVideoExitFullscreen') : tr('caVideoFullscreen')}
          onClick={() => void toggleFullscreen()}
        ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={full() !== null ? 'M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4' : 'M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4'} stroke="currentColor" stroke-width="1.6" fill="none" /></svg></button>
      </div>
    </div>
  );
}
