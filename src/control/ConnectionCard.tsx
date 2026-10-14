import { createSignal, Show } from 'solid-js';
import type { LinkState } from './types';

/** The last time this device's status read reached the node, and its round trip. */
export type NodeAnswer = { at: number; ms: number };
/** Where calls get their STUN server from (never the address itself). */
export type StunSource = 'node' | 'custom' | 'off' | 'none';
/** Candidate types of a call's selected pair (never addresses). */
export type CallRoute = { local: string; remote: string };

const STUN_TEXT: Record<StunSource, string> = {
  node: 'your node',
  custom: 'a server you chose',
  off: 'off (direct connections only)',
  none: 'none (your node does not offer one)',
};
const LINK_TEXT: Record<LinkState, string> = { open: 'Live', connecting: 'Connecting', closed: 'Reconnecting' };
const clock = (ms: number) => new Date(ms).toLocaleTimeString();

/**
 * What this device can say about its own connection, for a hands-on test
 * across a phone, a Mac and different networks. Read-only: only facts the
 * app already has, and never an id, address, ticket or token. "Check now"
 * runs one status read; "Copy details" copies the same facts as text.
 */
export function connectionSummary(props: { remote: boolean; link: LinkState | null; live: boolean; answer: NodeAnswer | null; stun: StunSource; lastCall: CallRoute | null }): string[] {
  const reach = props.remote ? 'over the network (a node you run elsewhere)' : 'on this Mac';
  const answer = props.answer
    ? props.live
      ? `${clock(props.answer.at)} · ${props.answer.ms} ms`
      : `not answering since ${clock(props.answer.at)}`
    : props.live ? 'not measured yet' : 'no answer yet';
  return [
    `How this device reaches your node: ${reach}`,
    `Live updates: ${props.link ? LINK_TEXT[props.link] : 'Waiting'}`,
    `Last answer from your node: ${answer}`,
    `Calls · STUN: ${STUN_TEXT[props.stun]}`,
    'Calls · relay (TURN): none yet',
    `Last call route: ${props.lastCall ? `${props.lastCall.local} (this device) / ${props.lastCall.remote} (theirs)` : 'no call yet'}`,
  ];
}

export function ConnectionCard(props: {
  remote: boolean;
  link: LinkState | null;
  live: boolean;
  answer: NodeAnswer | null;
  stun: StunSource;
  lastCall: CallRoute | null;
  /** One status read; the card's own button waits for it. */
  onCheck?: () => Promise<void>;
  /** Clipboard write (injected for tests). */
  copy?: (text: string) => Promise<void>;
}) {
  const [checking, setChecking] = createSignal(false);
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
