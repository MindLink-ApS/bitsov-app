import { createSignal, Show } from 'solid-js';
import type { LinkState } from './types';
import type { CallView } from './call';

/**
 * The last good status check: this app asking its own host (which usually
 * answers from its cached view of the node), and how long that took. Not a
 * round trip to the node itself.
 */
export type NodeAnswer = { at: number; ms: number };
/** Where calls get their STUN server from (never the address itself); 'checking' before the node's first overview. */
export type StunSource = 'node' | 'custom' | 'off' | 'none' | 'checking';
/** Candidate types of a call's selected pair (never addresses). */
export type CallRoute = { local: string; remote: string };
/** The latest call: whether it connected (went live), and its route when the stats named one. */
export type LastCall = { connected: boolean; route: CallRoute | null };
/** The latest call as tracked: its own call id, or null for a local refusal (no id, so no peer-chosen call_id can match it). */
export type TrackedCall = LastCall & { id: string | null };

/**
 * The latest call, from one call view. A call counts once it was placed, or
 * answered here; a call refused before it had an id (their node takes no
 * calls, the grant is too small) counts too, as one that did not connect.
 */
export function nextLastCall(prev: TrackedCall | null, v: CallView): TrackedCall | null {
  if (!v.callId) return v.phase === 'ended' && v.peer ? { id: null, connected: false, route: null } : prev;
  const same = prev?.id != null && prev.id === v.callId;
  if (!same && !(v.outgoing || ['connecting', 'live', 'reconnecting'].includes(v.phase))) return prev;
  return { id: v.callId, connected: (same && prev!.connected) || v.liveAt !== null, route: v.connection ?? (same ? prev!.route : null) };
}

const STUN_TEXT: Record<StunSource, string> = {
  node: 'your node',
  custom: 'a server you chose',
  off: 'off (direct connections only)',
  none: 'none (your node does not offer one)',
  checking: 'checking…',
};
const LINK_TEXT: Record<LinkState, string> = { open: 'Live', connecting: 'Connecting', closed: 'Reconnecting' };
const clock = (ms: number) => new Date(ms).toLocaleTimeString();

/**
 * What this device can say about its own connection, for a hands-on test
 * across a phone, a Mac and different networks. Read-only: only facts the
 * app already has, and never an id, address, ticket or token. "Check now"
 * runs one status read; "Copy details" copies the same facts as text.
 */
export function connectionSummary(props: { remote: boolean; link: LinkState | null; live: boolean; locked?: boolean; answer: NodeAnswer | null; stun: StunSource; lastCall: LastCall | null }): string[] {
  const reach = props.remote ? 'over the network (a node you run elsewhere)' : 'on this Mac';
  const check = props.locked
    ? 'your node is locked'
    : props.answer
      ? props.live
        ? `${clock(props.answer.at)} · ${props.answer.ms} ms (this app ↔ its host)`
        : `your node not answering since ${clock(props.answer.at)}`
      : props.live ? 'not measured yet' : 'no answer yet';
  // Connected is what the call did; the route is only what the stats could name (they may never have been read).
  const call = !props.lastCall
    ? 'no call yet'
    : props.lastCall.route
      ? `${props.lastCall.route.local} (this device) / ${props.lastCall.route.remote} (theirs)`
      : props.lastCall.connected ? 'connected, route unavailable' : 'no route (it didn’t connect)';
  return [
    `How this device reaches your node: ${reach}`,
    `Live updates: ${props.link ? LINK_TEXT[props.link] : 'Waiting'}`,
    `Last status check: ${check}`,
    `Calls · STUN: ${STUN_TEXT[props.stun]}`,
    'Calls · relay (TURN): none yet',
    `Last call: ${call}`,
  ];
}

export function ConnectionCard(props: {
  remote: boolean;
  link: LinkState | null;
  live: boolean;
  locked?: boolean;
  answer: NodeAnswer | null;
  stun: StunSource;
  lastCall: LastCall | null;
  /** One status read; reuses one already in flight. */
  onCheck?: () => Promise<void>;
  /** A check is in flight (held outside this card, so it survives leaving the page). */
  checking?: boolean;
  /** Clipboard write (injected for tests). */
  copy?: (text: string) => Promise<void>;
}) {
  const [localChecking, setChecking] = createSignal(false);
  const checking = () => props.checking ?? localChecking();
  const [copied, setCopied] = createSignal<'yes' | 'no' | null>(null);
  const lines = () => connectionSummary(props);
  const check = async () => {
    if (checking() || !props.onCheck) return;
    setChecking(true);
    try { await props.onCheck(); } catch { /* the lines below say what the read found */ } finally { setChecking(false); }
  };
  const copy = async () => {
    const write = props.copy ?? ((text: string) => navigator.clipboard.writeText(text));
    try { await write(['BitSov connection', ...lines()].join('\n')); setCopied('yes'); } catch { setCopied('no'); }
  };
  return (
    <section class="connection-card" data-connection-card aria-label="Connection">
      <h3>Connection</h3>
      <ul class="facts-list">
        {lines().map((line, i) => <li data-connection-line={i}>{line}</li>)}
      </ul>
      <div class="row" style={{ gap: 'var(--s-2)' }}>
        <Show when={props.onCheck}>
          <button type="button" class="soft small" data-connection-check disabled={checking()} onClick={() => void check()}>{checking() ? 'Checking…' : 'Check now'}</button>
        </Show>
        <button type="button" class="link" data-connection-copy onClick={() => void copy()}>Copy details</button>
        <Show when={copied()}>{(c) => <span class="hint" role="status" data-connection-copied>{c() === 'yes' ? 'Copied.' : 'Could not copy.'}</span>}</Show>
      </div>
    </section>
  );
}
