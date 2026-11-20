import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { OnCallPill } from '../src/control/OnCallPill';
import { OfflineNode } from '../src/control/OfflineNode';
import { IDLE, type CallView } from '../src/control/call';
import { Onboarding } from '../src/onboarding/Onboarding';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';
import { SettledPayment } from '../src/control/SettledPayment';
import { setDenom } from '../src/control/prefs';
import { logActivity, loggedActivity, resetActivityLog, updateInvoice } from '../src/control/wallet';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); resetActivityLog(); setDenom('sats'); });

it('says each call state in one word, ticks only while live, tolerates missing timestamps, and cleans up its clock', () => {
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const [view, setView] = createSignal<CallView>(IDLE);
  dispose = render(() => <OnCallPill view={view()} onReturn={() => {}} />, document.body);
  // No pill with no call, nor for an incoming call (it has its own ring card).
  for (const phase of ['idle', 'incoming'] as const) {
    setView({ ...IDLE, phase });
    expect(document.querySelector('[data-on-call]')).toBeNull();
  }
  const words = { calling: 'Calling', ringing: 'Ringing', connecting: 'Connecting', reconnecting: 'Reconnecting…', ended: 'Call ended' } as const;
  for (const [phase, word] of Object.entries(words) as [keyof typeof words, string][]) {
    setView({ ...IDLE, phase });
    expect(document.querySelector('[data-on-call]')!.getAttribute('data-on-call')).toBe(phase);
    expect(document.body.textContent).toBe(word);
    expect(document.querySelector('[data-on-call]')!.getAttribute('aria-label')).toBe(`${word} · Return to call`);
    expect(vi.getTimerCount()).toBe(0);
  }
  setView({ ...IDLE, phase: 'live', liveAt: 8000 });
  expect(document.body.textContent).toContain('Live · 03:12');
  vi.advanceTimersByTime(1000);
  expect(document.body.textContent).toContain('Live · 03:13');
  setView({ ...IDLE, phase: 'live', liveAt: null });
  expect(document.body.textContent).toBe('Live');
  setView({ ...IDLE, phase: 'live', liveAt: Date.now() + 1000 });
  expect(document.body.textContent).toBe('Live · 00:00');
  // Display only: the browser reports no network.
  setView({ ...IDLE, phase: 'live', liveAt: Date.now() + 1000, offline: true });
  expect(document.body.textContent).toBe('Live · offline · 00:00');
  dispose(); dispose = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps retry single-flight, explains failures and allows a later retry', async () => {
  let fail!: () => void;
  const retry = vi.fn(() => new Promise<void>((_, reject) => { fail = () => reject(new Error('offline')); }));
  dispose = render(() => <OfflineNode remote onRetry={retry} />, document.body);
  const button = document.querySelector('button')!;
  expect(document.body.textContent).toContain('Last seen: unknown');
  button.click(); button.click();
  expect(retry).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Retrying…');
  fail();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Still unavailable');
  button.click();
  expect(retry).toHaveBeenCalledTimes(2);
  fail();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
});

it('shows only the observed last-seen timestamp and distinguishes a local node', () => {
  dispose = render(() => <OfflineNode remote={false} lastSeen={0} onRetry={() => {}} />, document.body);
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('1970-01-01T00:00:00.000Z');
  expect(document.body.textContent).toContain('Your node is offline');
  expect(document.body.textContent).toContain('running on this computer');
});

it('keeps the paired illustration mounted through status refreshes, without replaying its pulse', () => {
  const [pairing, setPairing] = createSignal({ ...INITIAL_PAIRING, remote: true });
  dispose = render(() => <Onboarding status={() => ({ ready: true, node_id: 'a'.repeat(64), error: null })}
    pairing={pairing} trustAck={() => false} onRetry={() => {}} selectedTarget="network" />, document.body);
  setPairing({ ...pairing(), state: 'paired' });
  const box = document.querySelector('[data-pairing="paired"] .box-illustration.paired');
  expect(box).not.toBeNull();
  expect(document.body.textContent).toContain('Paired with your box');
  setPairing({ ...pairing(), scopes: ['read'] });
  expect(document.querySelector('[data-pairing="paired"] .box-illustration.paired')).toBe(box);
});

it('never substitutes an invoice request amount for an unknown settled amount', () => {
  resetActivityLog();
  logActivity([{ id: 'invoice', at: 1, kind: 'invoice', direction: 'in', msat: 99000, who: null, label: 'Invoice', status: 'waiting' }]);
  updateInvoice('invoice', { state: 'paid', amount_msat: null });
  dispose = render(() => <SettledPayment direction="received" msat={loggedActivity()[0].msat} />, document.body);
  expect(document.body.textContent).toContain('Amount unknown');
  expect(document.body.textContent).not.toContain('99');
});

it('keeps zero exact, rounds a fractional receipt down as "about" with the exact amount under Details, and keeps BTC exact', () => {
  setDenom('sats');
  const [msat, setMsat] = createSignal(0);
  dispose = render(() => <SettledPayment direction="received" msat={msat()} />, document.body);
  expect(document.body.textContent).toContain('0 sats');
  setMsat(1500);
  expect(document.querySelector('.settled-amount')?.textContent).toBe('about 1 sat');
  expect(document.querySelector('[data-settled-exact]')?.textContent).toBe('Detailsexactly 1.5 sats');
  setDenom('btc');
  expect(document.body.textContent).toContain('0.000000015 BTC');
});
