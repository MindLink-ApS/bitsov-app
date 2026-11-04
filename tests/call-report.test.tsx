import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE, type CallView } from '../src/control/call';
import type { MinutesView } from '../src/control/callMinutes';
import { appVersion, callReport, callReportLines } from '../src/control/callReport';
import { CallReportCopy } from '../src/control/CallReportCopy';
import { setLanguagePref } from '../src/i18n';
import { version } from '../package.json';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; setLanguagePref('system'); });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const PEER = 'ab12cd34' + '0'.repeat(48) + 'ef56ab78';
const CALL_ID = '0123456789abcdef0123456789abcdef';
const LIVE_AT = Date.UTC(2026, 10, 2, 10, 0, 0);
const ENDED_AT = LIVE_AT + 312_400;

const minutes = (patch: Partial<MinutesView> = {}): MinutesView => ({
  agreedBlockMsat: 1000, reservationMaxMsat: 240_000,
  reservation: { reserved_msat: 60_000, spent_msat: 5_050, remaining_msat: 0, per_block_msat: 1000, per_block_fee_msat: 10, max_call_minutes: 60, released_msat: 54_950, closed: true },
  confirmed: true, confirming: false, holdError: null, paidUntilMs: ENDED_AT, blocks: 5, receiptsMsat: 5_050,
  paying: false, lostMinute: false, undeliveredMinute: false, stop: null, settled: true, final: true, ...patch,
});
const ended = (patch: Partial<CallView> = {}): CallView => ({
  ...IDLE, phase: 'ended', state: 'ended', peer: PEER, callId: CALL_ID, media: 'audio', outgoing: true,
  liveAt: LIVE_AT, paidMsat: 3_030, reason: 'hangup', minutes: minutes(), ...patch,
});

describe('the call report', () => {
  it('lists the fields of an ended call with 5 paid blocks, in order', () => {
    expect(callReportLines({ view: ended(), routed: true, endedAt: ENDED_AT })).toEqual([
      'BitSov call report',
      'app record; compare with the node journal',
      `app_version: ${version}`,
      `call_id: ${CALL_ID}`,
      'node_call_id: unknown',
      'direction: outgoing',
      'peer: ab12cd34…ef56ab78',
      'media: audio',
      'media_path: node-routed',
      'clock: this device',
      'start_time: 2026-11-02T10:00:00.000Z',
      'end_time: 2026-11-02T10:05:12.400Z',
      'duration_s: 312',
      'end_reason: hangup',
      'hangup_reason: hangup',
      'minutes_stop: none',
      'offer_receipt_msat: unknown',
      'signal_receipts_up_to_msat: 3030',
      'blocks_paid: 5',
      'block_receipts: count and sum only; seq, amount and time of each are in the node journal',
      'sum_of_receipts_msat: 5050',
      'reserved_msat: 60000',
      'spent_msat: 5050',
      'released_msat: 54950',
      'still_held_msat: 0',
      'reservation_closed: yes',
      'max_call_minutes: 60',
    ]);
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names the unpaid, duration-cap and payment-failure ends', () => {
    const reason = (view: CallView) => callReportLines({ view, routed: true, endedAt: ENDED_AT }).find(l => l.startsWith('end_reason:'));
    const stop = (code: NonNullable<MinutesView['stop']>['code']) => ({ code, message: 'ignored' });
    expect(reason(ended({ reason: 'unpaid', minutes: minutes({ stop: stop('unpaid') }) }))).toBe('end_reason: unpaid');
    expect(reason(ended({ reason: 'unpaid', minutes: null }))).toBe('end_reason: unpaid');
    const capped = minutes({ blocks: 60, reservation: { ...minutes().reservation!, max_call_minutes: 60 }, stop: stop('node_ended') });
    expect(reason(ended({ minutes: capped }))).toBe('end_reason: duration_cap');
    expect(reason(ended({ reason: 'failed', minutes: minutes({ stop: stop('payment_failed') }) }))).toBe('end_reason: payment_failed');
    expect(reason(ended({ reason: 'failed', minutes: minutes({ stop: stop('budget_limit') }) }))).toBe('end_reason: budget_limit');
    expect(reason(ended({ reason: 'hangup', minutes: minutes({ stop: stop('node_ended') }) }))).toBe('end_reason: node_ended');
    // An incoming call the app only watched: no reservation of ours, nothing summed.
    const lines = callReportLines({ view: ended({ outgoing: false, minutes: null, reason: 'declined' }), routed: true, endedAt: ENDED_AT });
    expect(lines).toContain('direction: incoming');
    expect(lines).toContain('end_reason: declined');
    expect(lines).toContain('blocks_paid: unknown');
    expect(lines).toContain('reserved_msat: unknown');
  });

  it('never carries endpoints, invoices, tickets or key-like strings, even from odd state', () => {
    const hex64 = 'f'.repeat(64);
    // Address-shaped values, built at run time.
    const lan = [192, 168, 1, 20].join('.');
    const ten = [10, 0, 0, 1].join('.');
    const odd = ended({
      peer: `bitsov://pair?ticket=${hex64}`,
      callId: `http://${lan}:3000/x`,
      error: `lnbc10u1p${hex64} preimage ${hex64}`,
      media: 'lntb1xyz' as CallView['media'],
      reason: ten as CallView['reason'],
      paidMsat: Number.NaN,
      liveAt: -1,
      connection: { local: lan, remote: 'https://example.com' },
      minutes: minutes({
        stop: { code: 'bitsov://x' as 'unpaid', message: `https://example.com ${hex64}` },
        holdError: `token ${hex64}`,
        blocks: 1.5,
        receiptsMsat: -1,
        reservation: { ...minutes().reservation!, reserved_msat: Infinity, max_call_minutes: 'lnbc1' as unknown as number },
      }),
    });
    const text = callReport({ view: odd, routed: false, endedAt: ENDED_AT, version: `http://${ten}/` });
    for (const bad of [/bitsov:\/\//i, /https?:/i, /\bln(bc|tb|bcrt)[0-9a-z]+/i, /\b\d{1,3}(\.\d{1,3}){3}\b/, /[0-9a-f]{64}/i, /ticket|token|preimage/i]) {
      expect(text).not.toMatch(bad);
    }
    expect(text).toContain('call_id: unknown');
    expect(text).toContain('peer: unknown');
    expect(text).toContain('app_version: unknown');
    expect(text).toContain('start_time: unknown');
    expect(text).toContain('duration_s: unknown');
    expect(text).toContain('signal_receipts_up_to_msat: unknown');
    expect(text).toContain('blocks_paid: unknown');
    expect(text).toContain('sum_of_receipts_msat: unknown');
    expect(text).toContain('media_path: app-to-app');
  });

  it('copies the report from the ended card, says Copied, and is in Danish and English', async () => {
    setLanguagePref('da');
    const copy = vi.fn(async (_text: string) => {});
    const [view, setView] = createSignal<CallView>({ ...ended(), phase: 'live', state: 'live' });
    let clock = ENDED_AT;
    dispose = render(() => <CallReportCopy view={view()} routed copy={copy} now={() => clock} />, document.body);
    const button = () => document.querySelector<HTMLButtonElement>('[data-call-report-copy]');
    // While the call is live: no report.
    expect(button()).toBeNull();
    setView(ended());
    await flush();
    clock = ENDED_AT + 60_000;
    expect(button()!.textContent).toBe('Kopiér opkaldsrapport');
    expect(document.querySelector('[data-call-report-copied]')).toBeNull();
    button()!.click();
    await flush();
    expect(copy).toHaveBeenCalledTimes(1);
    const text = copy.mock.calls[0][0];
    expect(text.split('\n')[1]).toBe('app record; compare with the node journal');
    // The end time is when the card first showed the end, not when the button was pressed.
    expect(text).toContain('end_time: 2026-11-02T10:05:12.400Z');
    expect(document.querySelector('[data-call-report-copied]')!.textContent).toBe('Kopieret.');
    setLanguagePref('en');
    await flush();
    expect(button()!.textContent).toBe('Copy call report');
    expect(document.querySelector('[data-call-report-copied]')!.textContent).toBe('Copied.');
  });

  it('says so when the copy fails, and shows nothing for a call that never started', async () => {
    setLanguagePref('en');
    const [view, setView] = createSignal<CallView>(ended());
    dispose = render(() => <CallReportCopy view={view()} routed copy={() => Promise.reject(new Error('denied'))} />, document.body);
    document.querySelector<HTMLButtonElement>('[data-call-report-copy]')!.click();
    await flush();
    expect(document.querySelector('[data-call-report-copied]')!.textContent).toBe('Could not copy.');
    setView({ ...ended(), callId: null });
    await flush();
    expect(document.querySelector('[data-call-report-copy]')).toBeNull();
    for (const phase of ['ringing', 'connecting', 'reconnecting', 'incoming', 'calling'] as const) {
      setView({ ...ended(), phase });
      await flush();
      expect(document.querySelector('[data-call-report-copy]')).toBeNull();
    }
  });
});
