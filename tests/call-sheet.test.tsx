/**
 * The call sheet reads like a phone call: the person (their local name and a
 * round avatar), one status line, and big Answer / Decline or Cancel / Hang up.
 * No price, spending approval or command on its face; costs stay under Details.
 * Escape quiets a ringing call or closes an ended card, and never answers,
 * pays or hangs up. Presentation only: the call engine is driven as in the
 * other call tests, and every check reads the rendered card.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref, type Language } from '../src/i18n';
import { IDLE, type CallView } from '../src/control/call';
import { CallSheetHead, callInitials, callStatusLine } from '../src/control/CallSheetHead';
import { CallCues, CUE_BUSY, CUE_CONNECTED, CUE_ENDED, CUE_INTERRUPTED, cueFor } from '../src/control/IncomingCallAlerts';
import { escapeDepth } from '../src/control/escapeStack';
import { resetContactsForTests, setPetname } from '../src/control/petnames';
import { setDenom, setStunPref } from '../src/control/prefs';
import type { CallQuote, LiveEvent, SpendView } from '../src/control/types';
import type { PairingView } from '../src/onboarding/pairing';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const QUOTE: CallQuote = { offer_msat: 10_000, offer_max_routing_fee_msat: 5_000, signal_msat: 1_000, signal_max_routing_fee_msat: 5_000, call_total_msat: 21_000 };
const view = (over: Partial<CallView>): CallView => ({ ...IDLE, peer: A, callId: ID, ...over });

// ---- the head of the sheet: name, avatar and status, in English and Danish ----

describe('the call sheet head', () => {
  let root: HTMLDivElement;
  let dispose: (() => void) | undefined;
  beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
  afterEach(() => { dispose?.(); dispose = undefined; root.remove(); setLanguagePref('en'); });

  const STATES: [string, Partial<CallView>, string, string][] = [
    ['incoming audio', { phase: 'incoming' }, 'Incoming audio call', 'Indgående lydopkald'],
    ['incoming video', { phase: 'incoming', media: 'video', camera: true }, 'Incoming video call', 'Indgående videoopkald'],
    ['calling', { phase: 'calling', outgoing: true }, 'Calling…', 'Ringer op…'],
    ['calling with video', { phase: 'calling', outgoing: true, media: 'video' }, 'Calling… · Video', 'Ringer op… · Video'],
    ['ringing', { phase: 'ringing', outgoing: true }, 'Ringing…', 'Ringer…'],
    ['connecting', { phase: 'connecting' }, 'Connecting…', 'Forbinder…'],
    ['live', { phase: 'live', liveAt: 1_000 }, 'In call', 'I samtale'],
    ['live video', { phase: 'live', liveAt: 1_000, media: 'video' }, 'In video call', 'I videosamtale'],
    ['reconnecting', { phase: 'reconnecting', liveAt: 1_000 }, 'Reconnecting…', 'Genopretter forbindelsen…'],
    ['frozen media (shown as reconnecting)', { phase: 'live', liveAt: 1_000, interruptedUntil: 99_000 }, 'Reconnecting…', 'Genopretter forbindelsen…'],
    ['ended: busy', { phase: 'ended', reason: 'busy' }, 'Busy', 'Optaget'],
    ['ended: declined', { phase: 'ended', reason: 'declined' }, 'Declined', 'Afvist'],
    ['ended: no answer', { phase: 'ended', reason: 'timeout' }, 'No answer', 'Intet svar'],
    ['ended: hung up', { phase: 'ended', reason: 'hangup' }, 'Hung up', 'Lagt på'],
    ['ended: no reason', { phase: 'ended' }, 'Call ended', 'Opkald afsluttet'],
  ];

  it.each(STATES)('%s says one plain status line (EN and DA)', (_case, over, en, da) => {
    for (const [lang, said] of [['en', en], ['da', da]] as [Language, string][]) {
      setLanguagePref(lang);
      expect(callStatusLine(view(over), 'Maya')).toBe(said);
    }
  });

  it('a known contact: name as the heading, initials in the avatar, the clock beside the status but never announced', () => {
    dispose = render(() => <CallSheetHead view={view({ phase: 'live', liveAt: 1_000 })} name="Maya Jensen" known nameId="n" statusId="s" now={66_000} />, root);
    const heading = root.querySelector('h2#n')!;
    expect(heading.textContent).toBe('Maya Jensen');
    expect(root.querySelector('[data-call-avatar="initials"]')!.textContent).toBe('MJ');
    expect(root.querySelector('[data-call-avatar]')!.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('#s')!.textContent).toBe('In call · 1:05');
    expect(root.querySelector('[data-call-title]')!.textContent).toBe('In call');
    // The live region holds the state words only, so the running clock is not read out every second.
    expect(root.querySelector('[data-call-status-live]')!.textContent).toBe('In call');
    expect(root.querySelector('[data-call-status-live]')!.getAttribute('role')).toBe('status');
  });

  it('an unknown caller: Unknown contact, a neutral avatar, and no id anywhere in the head', () => {
    setLanguagePref('da');
    dispose = render(() => <CallSheetHead view={view({ phase: 'incoming' })} name="Ukendt kontakt" known={false} nameId="n" statusId="s" now={0} />, root);
    expect(root.querySelector('h2')!.textContent).toBe('Ukendt kontakt');
    expect(root.querySelector('[data-call-avatar="unknown"] svg')).not.toBeNull();
    expect(root.textContent).not.toMatch(/aaaa/);
    // The incoming alert announces a ringing call; the head stays quiet so it is not said twice.
    expect(root.querySelector('[data-call-status-live]')!.textContent).toBe('');
  });

  it('initials come from the first and last word, in capitals', () => {
    expect(callInitials('maya')).toBe('M');
    expect(callInitials('  Far  ')).toBe('F');
    expect(callInitials('Anne Sofie Holm')).toBe('AH');
    expect(callInitials('Øjvind Ærø')).toBe('ØÆ');
  });
});

// ---- the short state cues: once per change, never over the ringtone or ringback ----

describe('call state cues', () => {
  it('pick at most one cue per change of state', () => {
    const at = (phase: string) => ({ callId: ID, phase });
    expect(cueFor(at('connecting'), view({ phase: 'live', liveAt: 1 }))).toBe(CUE_CONNECTED);
    expect(cueFor(at('live'), view({ phase: 'live', liveAt: 1 }))).toBeNull();
    expect(cueFor(at('live'), view({ phase: 'live', liveAt: 1, interruptedUntil: 9 }))).toBe(CUE_INTERRUPTED);
    expect(cueFor(at('reconnecting'), view({ phase: 'live', liveAt: 1 }))).toBe(CUE_CONNECTED);
    expect(cueFor(at('ringing'), view({ phase: 'ended', reason: 'busy' }))).toBe(CUE_BUSY);
    expect(cueFor(at('live'), view({ phase: 'ended', reason: 'hangup' }))).toBe(CUE_ENDED);
    // Incoming has its ringtone; a missed or declined incoming call ends quietly.
    expect(cueFor(null, view({ phase: 'incoming' }))).toBeNull();
    expect(cueFor(at('incoming'), view({ phase: 'ended', reason: 'timeout' }))).toBeNull();
    // An outgoing call ringing has its ringback, and a first sight of an old ended call plays nothing.
    expect(cueFor(at('calling'), view({ phase: 'ringing', outgoing: true }))).toBeNull();
    expect(cueFor(null, view({ phase: 'ended' }))).toBeNull();
    expect(cueFor({ callId: 'other', phase: 'live' }, view({ phase: 'ended' }))).toBeNull();
  });

  it('plays a cue once per change on this device, and a refused audio context stays silent', async () => {
    const started: number[] = [];
    const ctx = () => ({
      currentTime: 0, destination: {}, resume: async () => {}, close: async () => {},
      createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }),
      createOscillator: () => { const o = { frequency: { value: 0 }, connect() {}, start() { started.push(o.frequency.value); }, stop() {} }; return o; },
    });
    const root = document.createElement('div');
    const { createSignal } = await import('solid-js');
    const [v, setV] = createSignal<CallView>(view({ phase: 'connecting' }));
    const dispose = render(() => <CallCues view={v()} audioContext={ctx as never} />, root);
    setV(view({ phase: 'live', liveAt: 1 }));
    setV(view({ phase: 'live', liveAt: 1, muted: true }));
    expect(started).toEqual(CUE_CONNECTED.hz);
    setV(view({ phase: 'ended', reason: 'hangup' }));
    expect(started).toEqual([...CUE_CONNECTED.hz, ...CUE_ENDED.hz]);
    dispose();
    // A webview that refuses audio stays silent. The change must really ask for a context, so mount before live.
    let asked = 0;
    const [w, setW] = createSignal<CallView>(view({ phase: 'connecting' }));
    const refused = render(() => <CallCues view={w()} audioContext={() => { asked++; throw new Error('no audio'); }} />, root);
    expect(() => setW(view({ phase: 'live', liveAt: 1 }))).not.toThrow();
    expect(asked).toBe(1);
    expect(() => refused()).not.toThrow();
    // A context that opens but refuses to resume or to make tones stays silent too, and is still closed.
    let closed = 0;
    const broken = { currentTime: 0, destination: {}, resume: () => Promise.reject(new Error('blocked')),
      close: () => { closed++; return Promise.resolve(); },
      createOscillator: () => { throw new Error('no tones'); }, createGain: () => { throw new Error('no tones'); } };
    const [x, setX] = createSignal<CallView>(view({ phase: 'connecting' }));
    const silent = render(() => <CallCues view={x()} audioContext={() => broken as never} />, root);
    expect(() => setX(view({ phase: 'live', liveAt: 1 }))).not.toThrow();
    expect(() => silent()).not.toThrow();
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0));
  });
});

// ---- the sheet in the app: controls, copy, focus and Escape ----

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };
const spending = (): SpendView => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
type Reply = (args?: Record<string, unknown>) => unknown;

function stubHost(overrides: Record<string, Reply> = {}, name: string | null = 'Maya') {
  resetContactsForTests();
  if (name) setPetname(A, name);
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now() }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Claimed Name', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: spending,
    budget_status: () => ({
      paused: false, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
      preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
      rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
      autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
      window_ms: 600_000, node_grant: null,
    }),
    call_quote: () => QUOTE,
    call_signal: (args) => ({ message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    op_end_call: (args) => ({ op_id: `end-${args!.call_id}`, kind: 'call_hangup', peer: A, call_id: args!.call_id, state: 'settled', cap_msat: 6_000, paid_msat: 6_000, message_id: 'hangup' }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return {
    used: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    emitLive: (payload: LiveEvent) => {
      const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
      callbacks.get(listen!.args!.handler as number)!({ event: 'node-live', id: 1, payload });
    },
  };
}

class FakePc {
  static made: FakePc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  restartIce = vi.fn();
  constructor() { FakePc.made.push(this); }
  async getStats() { return new Map(); }
  addTrack(t: MediaStreamTrack) { return { track: t, replaceTrack: async () => {} }; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d; }
  async addIceCandidate() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}
function stream() {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [], addTrack() {}, removeTrack() {} } as unknown as MediaStream;
}

/** What the card shows without opening anything: closed Details keep only their summary. */
function visible(el: Element | null): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('details:not([open])').forEach((d) => [...d.childNodes].forEach((n) => { if (!(n instanceof Element && n.tagName === 'SUMMARY')) n.remove(); }));
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return copy.textContent ?? '';
}
/** No price, spending approval, grant or command words on the face of a call sheet. */
const MONEY_OR_SETUP = /\bsats?\b|\bmsat\b|approve spending|godkend betalinger|\bgrant\b|tilladelse|konsensus|--op|\d+\s*(min|minutes|minutter)\b/i;
const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('the call sheet in the app', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  beforeEach(() => {
    setStunPref('');
    setDenom('sats');
    FakePc.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePc);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
  });
  afterEach(() => {
    setLanguagePref('en');
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.hasAttribute('data-trust-continue'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-trust-continue'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }
  const incoming = (host: ReturnType<typeof stubHost>, media: 'audio' | 'video' = 'audio') => host.emitLive({ type: 'message', room_id: null,
    message: { id: `live-${media}`, kind: 400, sender: A, recipient: OWN, timestamp: Date.now(), plaintext: JSON.stringify({ v: 1, call_id: ID, media, sdp: 'v=0 offer' }), payment_amount_msat: 10_000 } });
  const ring = async () => {
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')!.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call="audio"]')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-confirm="audio"]')?.disabled).toBe(false));
    $<HTMLButtonElement>('[data-call-confirm="audio"]')!.click();
  };

  it.each([
    ['en', 'Maya', 'Incoming audio call', 'Answer', 'Decline', 'Details'],
    ['da', 'Maya', 'Indgående lydopkald', 'Besvar', 'Afvis', 'Detaljer'],
  ] as const)('incoming (%s): the person first, a big green Answer and a red Decline, no money on its face', async (lang, name, status, answer, decline, details) => {
    const host = stubHost();
    await openShell();
    setLanguagePref(lang);
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    const panel = $('[data-call-panel="incoming"]')!;
    // The dialog is named by the person and described by the status line.
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toBe(name);
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)!.textContent).toBe(status);
    expect(panel.querySelector('h2')!.textContent).toBe(name);
    // Their own claimed name is never the heading.
    expect(panel.textContent).not.toContain('Claimed Name');
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('.call-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual([answer, decline]);
    expect(buttons[0].classList.contains('call-answer')).toBe(true);
    expect(buttons[1].classList.contains('danger')).toBe(true);
    expect(visible(panel)).not.toMatch(MONEY_OR_SETUP);
    // What answering costs is one tap away, under the one Details.
    const cost = $('[data-call-answer-cost]')!;
    expect(cost.closest('details')!.open).toBe(false);
    expect(cost.closest('details')!.querySelector('summary')!.textContent).toBe(details);
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it('incoming: focus lands on the sheet, then Answer, Decline and Details in that order', async () => {
    const host = stubHost();
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect(document.activeElement).toBe($('[data-call-panel="incoming"]')));
    const focusable = [...$('[data-call-panel="incoming"]')!.querySelectorAll<HTMLElement>('button, summary, a[href], input')]
      .map((el) => el.matches('[data-call-accept]') ? 'answer' : el.matches('[data-call-decline]') ? 'decline' : el.tagName === 'SUMMARY' ? 'details' : el.outerHTML.slice(0, 40));
    expect(focusable).toEqual(['answer', 'decline', 'details']);
  });

  it('Escape quiets the ringtone only: the sheet stays, nothing is answered, sent or paid', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const host = stubHost();
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-accept]')?.disabled).toBe(false));
    const ringtone = play.mock.contexts.find((a) => a instanceof HTMLAudioElement && a.loop) as HTMLAudioElement;
    expect(ringtone).toBeDefined();
    key('Escape');
    await vi.waitFor(() => expect(pause.mock.contexts).toContain(ringtone));
    expect($('[data-call-panel="incoming"]')).not.toBeNull();
    expect($('[data-call-ring-quiet]')!.textContent).toBe('Ringtone off. You can still answer or decline.');
    expect($<HTMLButtonElement>('[data-call-accept]')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-call-decline]')!.disabled).toBe(false);
    key('Escape');
    expect($('[data-call-panel="incoming"]')).not.toBeNull();
    // The quiet call is still announced (once) for screen readers.
    expect($('[data-incoming-announcement]')!.textContent).toBe('Maya is calling');
    expect(host.used('call_signal')).toHaveLength(0);
    expect(host.used('op_end_call')).toHaveLength(0);
    expect(host.used('spend_request')).toHaveLength(0);
    setLanguagePref('da');
    expect($('[data-call-ring-quiet]')!.textContent).toBe('Ringetonen er slået fra. Du kan stadig svare eller afvise.');
  });

  it('an unknown caller is Unknown contact on the sheet and in the announcement, with their key start under Details', async () => {
    const host = stubHost({}, null);
    await openShell();
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).not.toBeNull());
    const panel = $('[data-call-panel="incoming"]')!;
    expect(panel.querySelector('h2')!.textContent).toBe('Unknown contact');
    expect(panel.querySelector('[data-call-avatar="unknown"]')).not.toBeNull();
    expect(visible(panel)).not.toMatch(/aaaa/);
    expect($('[data-incoming-announcement]')!.textContent).toBe('Unknown contact is calling');
    const key16 = $('[data-call-unknown-key]')!;
    expect(key16.closest('details')!.open).toBe(false);
    expect(key16.textContent).toBe('Not in your contacts. Their key starts aaaa · aaaa · aaaa · aaaa.');
    setLanguagePref('da');
    expect(panel.querySelector('h2')!.textContent).toBe('Ukendt kontakt');
  });

  it.each([
    ['en', 'Calls are not set up on this device yet, so this call can’t be answered here. Declining still works.', 'Set up calls'],
    ['da', 'Opkald er ikke gjort klar på denne enhed endnu, så du kan ikke svare her. Du kan stadig afvise.', 'Gør klar til opkald'],
  ] as const)('spending not open (%s): a plain line on the sheet, no spending form; setup stays under Details', async (lang, line, setup) => {
    const host = stubHost({
      pairing_status: () => ({ ...paired, scopes: ['read', 'receive'] }),
      spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
      budget_status: () => null,
    });
    await openShell();
    setLanguagePref(lang);
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-spend-needed]')).not.toBeNull());
    const panel = $('[data-call-panel="incoming"]')!;
    expect($('[data-call-spend-needed]')!.textContent).toBe(line);
    expect(visible(panel)).not.toMatch(MONEY_OR_SETUP);
    expect($('[data-call-approval]')).toBeNull();
    const button = $('[data-call-spend-approve]')!;
    expect(button.textContent).toBe(setup);
    expect(button.closest('details')!.open).toBe(false);
    expect(host.used('spend_request')).toHaveLength(0);
    // Decline still works at once, and costs nothing.
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each([
    ['en', 'Payments are paused, so this call can’t be answered here. Declining still works.'],
    ['da', 'Betalinger er sat på pause, så du kan ikke svare her. Du kan stadig afvise.'],
  ] as const)('payments paused (%s): the sheet says paused, not "not set up", and offers no approval it could not honour', async (lang, line) => {
    const host = stubHost({
      spend_status: () => ({ state: 'expired', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
      budget_status: () => ({
        paused: true, waiting_for_owner: false, ceiling_msat: 500_000, max_daily_msat: 100_000_000, spent_msat: 0, unsettled_msat: 0,
        preset: 'careful', presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
        rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
        autopay: { state: 'off', open_until_ms: null, ceiling_msat: null, basis: null },
        window_ms: 600_000, node_grant: null,
      }),
    });
    await openShell();
    setLanguagePref(lang);
    incoming(host);
    await vi.waitFor(() => expect($('[data-call-spend-needed]')).not.toBeNull());
    expect($('[data-call-spend-needed]')!.textContent).toBe(line);
    expect($('[data-call-spend-approve]')).toBeNull();
    expect($<HTMLButtonElement>('[data-call-accept]')?.disabled ?? true).toBe(true);
    expect(host.used('spend_request')).toHaveLength(0);
    $<HTMLButtonElement>('[data-call-decline]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="incoming"]')).toBeNull());
    expect(host.used('call_signal')).toHaveLength(0);
  });

  it.each([
    ['en', 'Calling…', 'Cancel', 'Ringing…', 'Hang up', 'In call'],
    ['da', 'Ringer op…', 'Annuller', 'Ringer…', 'Læg på', 'I samtale'],
  ] as const)('outgoing (%s): the person, Calling then Ringing, one red Cancel; Escape never hangs up', async (lang, calling, cancel, ringing, hangUp, live) => {
    let finish!: () => void;
    const host = stubHost({
      call_signal: (args) => new Promise((resolve) => { finish = () => resolve({ message_id: 'sig', kind: args!.kind, amount_msat: 10_000, total_msat: 15_000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }); }),
    });
    await openShell();
    setLanguagePref(lang);
    await ring();
    await vi.waitFor(() => expect($('[data-call-panel="calling"]')).not.toBeNull());
    let panel = $('[data-call-panel="calling"]')!;
    expect(panel.querySelector('h2')!.textContent).toBe('Maya');
    expect($('[data-call-title]')!.textContent).toBe(calling);
    expect([...panel.querySelectorAll('.call-actions button')].map((b) => b.textContent)).toEqual([cancel]);
    expect($('[data-call-hangup]')!.classList.contains('danger')).toBe(true);
    expect(visible(panel)).not.toMatch(MONEY_OR_SETUP);
    key('Escape');
    finish();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    panel = $('[data-call-panel="ringing"]')!;
    expect($('[data-call-title]')!.textContent).toBe(ringing);
    expect(visible(panel)).not.toMatch(MONEY_OR_SETUP);
    expect(host.used('op_end_call')).toHaveLength(0);
    FakePc.made[0].connect();
    await vi.waitFor(() => expect($('[data-call-panel="live"]')).not.toBeNull());
    expect($('[data-call-title]')!.textContent).toBe(live);
    expect($('[data-call-hangup]')!.textContent).toBe(hangUp);
    key('Escape');
    expect($('[data-call-panel="live"]')).not.toBeNull();
    expect(host.used('op_end_call')).toHaveLength(0);
  });

  it('Escape closes an ended card once nothing is settling, and is not needed to end a call', async () => {
    const host = stubHost();
    await openShell();
    await ring();
    await vi.waitFor(() => expect($('[data-call-panel="ringing"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-call-hangup]')!.click();
    await vi.waitFor(() => expect($('[data-call-panel="ended"]')).not.toBeNull());
    expect(host.used('op_end_call')).toHaveLength(1);
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call-dismiss]')?.disabled).toBe(false));
    // Once the node has closed the call (nothing more can be paid for it).
    await vi.waitFor(() => expect($('[data-call-nothing-more]')).not.toBeNull());
    // The ended card is the one Escape target.
    await vi.waitFor(() => expect(escapeDepth()).toBe(1));
    key('Escape');
    await vi.waitFor(() => expect($('[data-call-panel]')).toBeNull());
  });
});

// ---- the stylesheet: the colours and sizes jsdom does not apply ----

describe('the call sheet styles', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  it('Decline and hang up are as big as Answer, and red from the theme', () => {
    expect(css).toMatch(/\.call-actions :is\(\.call-decline, \[data-call-hangup\]\) \{[^}]*min-height:\s*48px/);
    expect(css).toMatch(/button\.danger \{[^}]*background:\s*var\(--err\)/);
  });
  it('on a phone-sized window the ringing and calling sheet fills the screen; waiting cards keep their place', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(phone).toMatch(/\.call-panel\[data-call-main\]:is\(\[data-call-panel="incoming"\], \[data-call-panel="calling"\], \[data-call-panel="ringing"\]\) \{[^}]*top:[^}]*bottom:[^}]*left:[^}]*right:/);
  });
  it('the ringing card does not pulse or glow under reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.slice(0, reduced.indexOf('\n}\n'))).toMatch(/\.call-panel\[data-call-panel="incoming"\][\s\S]*\[data-call-accept\][\s\S]*animation: none !important/);
  });
});
