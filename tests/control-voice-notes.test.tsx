import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { PairingView } from '../src/onboarding/pairing';
import type { BudgetView, SpendView } from '../src/control/types';
import {
  duration,
  isVoiceNote,
  pickRecordType,
  sendType,
  startRecording,
  VOICE_BITS_PER_SECOND,
  VOICE_MAX_BYTES,
  VOICE_MAX_MS,
  VOICE_MP4_MAX_MS,
  voiceLimitMs,
  voiceFileName,
  type RecorderDeps,
} from '../src/control/voice';

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const IN_ID = 'c'.repeat(64);
const C = 'e'.repeat(64);
const DAY = 86_400_000;
const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null };

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

/** A MediaRecorder stand-in: one "hi" chunk when stopped. */
class FakeRecorder {
  static made: FakeRecorder[] = [];
  static isTypeSupported = (t: string) => t.startsWith('audio/webm');
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream, public opts: MediaRecorderOptions) { FakeRecorder.made.push(this); }
  start() { this.state = 'recording'; }
  static clip: () => Blob = () => new Blob(['hi']);
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: FakeRecorder.clip() });
    this.onstop?.();
  }
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

const deps = (over: Partial<RecorderDeps> = {}): RecorderDeps => ({
  getUserMedia: async () => fakeStream().stream,
  MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
  now: () => Date.UTC(2026, 8, 29, 12, 0, 0),
  ...over,
});

describe('voice note helpers', () => {
  it('prefers Opus in WebM and sends it as audio/webm', () => {
    expect(pickRecordType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecordType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordType(() => false)).toBeNull();
    expect(sendType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(sendType('audio/mp4;codecs=mp4a')).toBe('audio/mp4');
  });

  it('names clips so both ends recognise them, and nothing else', () => {
    const name = voiceFileName(Date.UTC(2026, 8, 29, 12, 0, 0), 'audio/webm');
    expect(name).toMatch(/^voice-note-\d{8}-\d{6}\.webm$/);
    expect(isVoiceNote(200, name)).toBe(true);
    expect(isVoiceNote(200, `[file: ${name}]`)).toBe(true);
    expect(isVoiceNote(0, name)).toBe(false);
    expect(isVoiceNote(200, 'brief.txt')).toBe(false);
    expect(isVoiceNote(200, 'voice-note-../x.webm')).toBe(false);
    expect(isVoiceNote(200, null)).toBe(false);
    expect(duration(65_400)).toBe('1:05');
    expect(duration(VOICE_MAX_MS)).toBe('2:00');
  });
});

describe('startRecording', () => {
  beforeEach(() => { FakeRecorder.made = []; FakeRecorder.clip = () => new Blob(['hi']); });

  it('caps the MP4/AAC fallback shorter than WebM, and stops on a byte budget whatever the codec', async () => {
    expect(voiceLimitMs('audio/webm;codecs=opus')).toBe(VOICE_MAX_MS);
    expect(voiceLimitMs('audio/mp4')).toBe(VOICE_MP4_MAX_MS);
    // 128 kbps for the MP4 limit stays under the 1.4 MB file cap.
    expect((VOICE_MP4_MAX_MS / 1000) * 128_000 / 8).toBeLessThan(1_400_000);
    const onlyMp4 = class extends FakeRecorder { static isTypeSupported = (t: string) => t === 'audio/mp4'; };
    const mp4 = await startRecording(() => {}, deps({ MediaRecorder: onlyMp4 as unknown as typeof MediaRecorder }));
    expect(mp4.limitMs).toBe(VOICE_MP4_MAX_MS);
    mp4.cancel();
    const onLimit = vi.fn();
    const rec = await startRecording(onLimit, deps());
    const r = FakeRecorder.made[FakeRecorder.made.length - 1];
    r.ondataavailable!({ data: new Blob([new Uint8Array(VOICE_MAX_BYTES - 1)]) });
    expect(onLimit).not.toHaveBeenCalled();
    r.ondataavailable!({ data: new Blob([new Uint8Array(1)]) });
    r.ondataavailable!({ data: new Blob([new Uint8Array(1)]) });
    expect(onLimit).toHaveBeenCalledTimes(1);
    rec.cancel();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('records Opus at 32 kbps and returns an audio/webm file, releasing the microphone', async () => {
    const { stream, track } = fakeStream();
    const rec = await startRecording(() => {}, deps({ getUserMedia: async () => stream }));
    expect(FakeRecorder.made[0].opts).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: VOICE_BITS_PER_SECOND });
    const clip = await rec.stop();
    expect(clip?.type).toBe('audio/webm');
    expect(clip?.name).toMatch(/^voice-note-.*\.webm$/);
    expect(clip?.size).toBe(2);
    expect(track.stop).toHaveBeenCalled();
    // A second stop hands back nothing (the clip was already taken).
    expect(await rec.stop()).toBeNull();
  });

  it('asks the caller to stop at about two minutes', async () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const rec = await startRecording(onLimit, deps());
    vi.advanceTimersByTime(VOICE_MAX_MS - 1);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect((await rec.stop())?.type).toBe('audio/webm');
  });

  it('says so plainly when there is no microphone', async () => {
    await expect(startRecording(() => {}, null)).rejects.toThrow('cannot record audio');
    await expect(startRecording(() => {}, deps({ getUserMedia: () => Promise.reject(new Error('NotAllowedError')) }))).rejects.toThrow(/Microphone not available/);
    expect(FakeRecorder.made).toHaveLength(0);
  });
});

const openBudget = (): BudgetView => ({
  paused: false,
  waiting_for_owner: false,
  ceiling_msat: 500_000,
  max_daily_msat: 100_000_000,
  spent_msat: 0,
  unsettled_msat: 0,
  preset: 'careful',
  presets: [{ id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 }],
  rows: [{ target: A, room: false, limit_msat: 50_000, spent_msat: 0 }],
  autopay: { state: 'open', open_until_ms: Date.now() + DAY, ceiling_msat: 500_000, basis: 'node_grant' },
  window_ms: 600_000,
  node_grant: null,
});

function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  const spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    trust_acknowledge: () => true,
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }, { node_id: C, addr: null, label: 'Josh', connected: true, fingerprint: null }],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, max_routing_fee_msat: 0, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => spend,
    budget_status: () => openBudget(),
    file_send: (args) => ({
      message_id: 'voice-sent', recipient: args!.recipient, filename: args!.filename, size_bytes: 2,
      delivered: true, amount_msat: 3000, total_msat: 8000, max_routing_fee_msat: 5000, sent_at_ms: Date.now(),
      accepted: true, state: 'acked',
    }),
    voice_note_fetch: () => ({ filename: 'voice-note-20260929-120000.webm', mime_type: 'audio/webm', size_bytes: 2, data_b64: 'aGk=' }),
    file_fetch: () => ({ filename: 'voice-note-20260929-120000.webm', mime_type: 'audio/webm', size_bytes: 2, data_b64: 'aGk=' }),
    file_save: () => ({ saved: true, filename: 'voice-note-20260929-120000.webm', mime_type: 'audio/webm', size_bytes: 2 }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try { return Promise.resolve(reply(args)); } catch (e) { return Promise.reject(e); }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  return { used: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

describe('voice notes in the composer and thread', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    FakeRecorder.made = [];
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:voice-${++n}`);
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => fakeStream().stream } });
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';

  async function openShell() {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
  }

  async function recordClip() {
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-record="stop"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-voice-record="stop"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-preview]')).not.toBeNull());
  }

  it('records, previews and sends the clip once as a paid audio/webm file at the file price', async () => {
    const host = stubHost();
    await openShell();
    await recordClip();
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('file');
    await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send · 8 sats$/));
    const send = $<HTMLButtonElement>('[data-send]')!;
    send.click();
    send.click();
    await vi.waitFor(() => expect(host.used('file_send')).toHaveLength(1));
    expect(host.used('file_send')[0].args).toMatchObject({ recipient: A, mime_type: 'audio/webm', data_b64: 'aGk=', max_msat: 8000 });
    expect(host.used('file_send')[0].args!.filename).toMatch(/^voice-note-\d{8}-\d{6}\.webm$/);
    // The sent clip plays from its own bytes: no read back from the node.
    await vi.waitFor(() => expect($('[data-message="voice-sent"] [data-voice-play]')).not.toBeNull());
    $<HTMLButtonElement>('[data-message="voice-sent"] [data-voice-play]')!.click();
    await vi.waitFor(() => expect($('[data-message="voice-sent"] audio[data-voice-audio]')).not.toBeNull());
    expect(host.used('voice_note_fetch')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.used('file_send')).toHaveLength(1);
  });

  it('a budget stop pays nothing and does not retry', async () => {
    const host = stubHost({ file_send: () => Promise.reject({ code: 'budget_exhausted', message: 'Maya’s budget is used up.' }) });
    await openShell();
    await recordClip();
    await vi.waitFor(() => expect(text('[data-send]')).toMatch(/^Send · 8 sats$/));
    $<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(host.used('file_send')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(host.used('file_send')).toHaveLength(1);
    expect($('[data-voice-preview]')).not.toBeNull();
  });

  it('plays a received voice note inline after one read-only fetch; other files stay plain', async () => {
    const at = Date.now() - 60_000;
    const host = stubHost({
      messages_list: (args) => (args!.peer === A
        ? [
            { id: IN_ID, kind: 200, sender: A, recipient: OWN, timestamp: at, plaintext: '[file: voice-note-20260929-120000.webm]', payment_amount_msat: 3000 },
            { id: 'd'.repeat(64), kind: 200, sender: A, recipient: OWN, timestamp: at + 1, plaintext: '[file: brief.txt]', payment_amount_msat: 3000 },
          ]
        : []),
    });
    await openShell();
    await vi.waitFor(() => expect($(`[data-message="${IN_ID}"] [data-voice-play]`)).not.toBeNull());
    expect($(`[data-message="${'d'.repeat(64)}"] [data-voice-play]`)).toBeNull();
    expect(text(`[data-message="${'d'.repeat(64)}"] .file-name`)).toBe('brief.txt');
    expect(host.used('voice_note_fetch')).toHaveLength(0);
    $<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.click();
    await vi.waitFor(() => expect($(`[data-message="${IN_ID}"] audio[data-voice-audio]`)?.getAttribute('src')).toMatch(/^blob:/));
    expect(host.used('voice_note_fetch').map((c) => c.args)).toEqual([{ message_id: IN_ID }]);
  });

  it('a voice note that failed to load for another reason can be tried again', async () => {
    let fail = true;
    stubHost({
      messages_list: (args) => (args!.peer === A
        ? [{ id: IN_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 1000, plaintext: '[file: voice-note-20260929-120000.webm]', payment_amount_msat: 3000 }]
        : []),
      voice_note_fetch: () => fail ? Promise.reject('connection dropped') : ({ filename: 'voice-note-20260929-120000.webm', mime_type: 'audio/webm', size_bytes: 2, data_b64: 'aGk=' }),
    });
    await openShell();
    await vi.waitFor(() => expect($(`[data-message="${IN_ID}"] [data-voice-play]`)).not.toBeNull());
    $<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.click();
    await vi.waitFor(() => expect(text(`[data-message="${IN_ID}"] [data-voice-play]`)).toMatch(/could not load/));
    expect($<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.disabled).toBe(false);
    fail = false;
    $<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.click();
    await vi.waitFor(() => expect(text(`[data-message="${IN_ID}"] [data-voice-play]`)).not.toMatch(/could not load/));
  });

  it('names a voice note this device does not hold', async () => {
    stubHost({
      messages_list: (args) => (args!.peer === A
        ? [{ id: IN_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 1000, plaintext: '[file: voice-note-20260929-120000.webm]', payment_amount_msat: 3000 }]
        : []),
      voice_note_fetch: () => Promise.reject('voice note not stored on this node'),
    });
    await openShell();
    await vi.waitFor(() => expect($(`[data-message="${IN_ID}"] [data-voice-play]`)).not.toBeNull());
    $<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.click();
    await vi.waitFor(() => expect(text(`[data-message="${IN_ID}"] [data-voice-play]`)).toMatch(/not stored on this device/));
  });

  it('explains a missing microphone without leaving message mode', async () => {
    stubHost();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new Error('denied')) } });
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect(mount.textContent).toMatch(/Microphone not available/));
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('message');
  });

  it('stops recording when the window loses focus and keeps the clip unsent', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-record="stop"]')).not.toBeNull());
    window.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect($('[data-voice-preview]')).not.toBeNull());
    expect(FakeRecorder.made[0].state).toBe('inactive');
    expect(host.used('file_send')).toHaveLength(0);
  });

  it('blur then hide while recording still keeps the clip as a preview', async () => {
    const host = stubHost();
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-record="stop"]')).not.toBeNull());
    // Real webviews fire blur then visibilitychange(hidden) on minimise / tab switch.
    // stopRecording clears recording before onstop; a blind gen bump would drop the clip.
    window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect($('[data-voice-preview]')).not.toBeNull());
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('file');
    expect(host.used('file_send')).toHaveLength(0);
  });

  it('a track switch while stop awaits does not attach the clip to the new track', async () => {
    stubHost();
    let releaseStop: (() => void) | null = null;
    class SlowRecorder extends FakeRecorder {
      stop() {
        this.state = 'inactive';
        // Resolve after the test switches tracks — generation must discard the clip.
        void new Promise<void>((r) => { releaseStop = r; }).then(() => {
          this.ondataavailable?.({ data: FakeRecorder.clip() });
          this.onstop?.();
        });
      }
    }
    vi.stubGlobal('MediaRecorder', SlowRecorder);
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-record="stop"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-voice-record="stop"]')!.click();
    await vi.waitFor(() => expect(releaseStop).not.toBeNull());
    $<HTMLElement>(`[data-track="peer:${C}"]`)!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${C}"]`)?.getAttribute('aria-current')).toBe('true'));
    releaseStop!();
    // Macrotask drain: stopRecording's await chain needs more than two microtasks.
    await new Promise((r) => setTimeout(r, 20));
    expect($('[data-voice-preview]')).toBeNull();
    expect($('[data-composer]')!.getAttribute('data-mode')).toBe('message');
  });

  it('a microphone prompt answered after the window blurs does not start recording', async () => {
    stubHost();
    let grant!: (s: MediaStream) => void;
    const { stream, track } = fakeStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise<MediaStream>((r) => { grant = r; }) },
    });
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect(grant).toBeDefined());
    window.dispatchEvent(new Event('blur'));
    grant(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());
    expect($('[data-voice-record="stop"]')).toBeNull();
    expect(FakeRecorder.made.every((r) => r.state === 'inactive')).toBe(true);
  });

  it('a microphone prompt answered after switching contact does not record for the new one', async () => {
    stubHost();
    let grant!: (s: MediaStream) => void;
    const { stream, track } = fakeStream();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>((r) => { grant = r; }) } });
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect(grant).toBeDefined());
    $<HTMLElement>(`[data-track="peer:${C}"]`)!.click();
    await vi.waitFor(() => expect($(`[data-track="peer:${C}"]`)?.getAttribute('aria-current')).toBe('true'));
    grant(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());
    expect($('[data-voice-record="stop"]')).toBeNull();
    expect(FakeRecorder.made.every((r) => r.state === 'inactive')).toBe(true);
  });

  it('refuses a clip over the file cap before anything is sent', async () => {
    const host = stubHost();
    FakeRecorder.clip = () => new Blob([new Uint8Array(1_400_001)]);
    await openShell();
    $<HTMLButtonElement>('[data-voice-record="start"]')!.click();
    await vi.waitFor(() => expect($('[data-voice-record="stop"]')).not.toBeNull());
    $<HTMLButtonElement>('[data-voice-record="stop"]')!.click();
    await vi.waitFor(() => expect(mount.textContent).toMatch(/over 1\.4 MB, too large to send/));
    expect($('[data-voice-preview]')).toBeNull();
    expect(host.used('file_send')).toHaveLength(0);
    FakeRecorder.clip = () => new Blob(['hi']);
  });

  it('names a spoofed voice-note file as not audio, not as missing', async () => {
    stubHost({
      messages_list: (args) => (args!.peer === A
        ? [{ id: IN_ID, kind: 200, sender: A, recipient: OWN, timestamp: Date.now() - 1000, plaintext: '[file: voice-note-20260929-120000.webm]', payment_amount_msat: 3000 }]
        : []),
      voice_note_fetch: () => Promise.reject('not a voice note'),
    });
    await openShell();
    await vi.waitFor(() => expect($(`[data-message="${IN_ID}"] [data-voice-play]`)).not.toBeNull());
    $<HTMLButtonElement>(`[data-message="${IN_ID}"] [data-voice-play]`)!.click();
    await vi.waitFor(() => expect(text(`[data-message="${IN_ID}"] [data-voice-play]`)).toBe('File · voice-note-20260929-120000.webm (not audio, not played)'));
  });

  it('the recording pill uses the accent ink for contrast', async () => {
    const css = (await import('node:fs')).readFileSync('src/styles.css', 'utf8');
    const rule = css.split('\n').find((l) => l.startsWith('.attach.soft.voice-record.recording'))!;
    expect(rule).toContain('background: var(--accent)');
    expect(rule).toContain('color: var(--accent-ink)');
  });
});
