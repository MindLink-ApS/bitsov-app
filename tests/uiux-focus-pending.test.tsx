import { readFileSync } from 'node:fs';
import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlCenter } from '../src/control/Shell';
import { HubChannelConfirm, acknowledgeHubChannel } from '../src/control/HubTrust';
import { escapeDepth, onEscape } from '../src/control/escapeStack';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';
import type { LiveEvent, OpView } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
const cleanups: (() => void)[] = [];
afterEach(() => {
  dispose?.();
  dispose = undefined;
  cleanups.splice(0).forEach((cleanup) => cleanup());
  mount?.remove();
  vi.restoreAllMocks();
  expect(escapeDepth()).toBe(0);
});
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => mount.querySelector<T>(selector)!;
const esc = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function mountIn() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}
async function shell(source: Source = sampleSource({ firstLiveMs: 1e9 })) {
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
  await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
}

it.each(['Escape', 'Back'])('Wallet restores focus to You after %s, even after changing tabs', async (close) => {
  await shell();
  const opener = $('[data-profile]');
  opener.focus();
  opener.click();
  await tick();
  $('[data-open-wallet]').click();
  await tick();
  expect(document.activeElement).toBe($('[data-wallet-close]'));
  $('[data-wallet-tab="channels"]').focus();
  $('[data-wallet-tab="channels"]').click();
  if (close === 'Escape') esc();
  else $('[data-wallet-close]').click();
  await tick();
  expect($('[data-wallet-page]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it.each(['Escape', 'Got it', 'backdrop'])('InfoModal focuses its dialog and restores its opener on %s', async (close) => {
  await shell();
  $('.track-head .context-toggle').click();
  await tick();
  const opener = $('[data-info="metabolism"]');
  opener.focus();
  opener.click();
  await tick();
  expect(document.activeElement).toBe($('.info-modal'));
  if (close === 'Escape') esc();
  else if (close === 'Got it') $('[data-info-close]').click();
  else $('[data-info-modal]').click();
  await tick();
  expect($('[data-info-modal]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect($('[data-settings-open="true"]')).not.toBeNull();
  esc();
  expect($('[data-settings-open="true"]')).toBeNull();
});

it('Wallet opened through Settings returns to the visible Settings opener', async () => {
  await shell();
  const opener = $('.node-pill');
  opener.focus();
  opener.click();
  await tick();
  $('[data-tab="wallet"]').click();
  $('[data-open-wallet-page]').focus();
  $('[data-open-wallet-page]').click();
  await tick();
  expect(document.activeElement).toBe($('[data-wallet-close]'));
  esc();
  await tick();
  expect(document.activeElement).toBe(opener);
  expect($('[data-settings-open="true"]')).toBeNull();
});

it('InfoModal lets a newer Escape layer close first', async () => {
  await shell();
  $('[data-info="metabolism"]').click();
  await tick();
  let closed = false;
  const off = onEscape(() => { closed = true; off(); });
  cleanups.push(off);
  esc();
  expect(closed).toBe(true);
  expect($('[data-info-modal]')).not.toBeNull();
  esc();
  expect($('[data-info-modal]')).toBeNull();
});

it.each(['Escape', 'Not now', 'confirm'])('Hub confirm focuses in and restores focus on %s without closing the layer below', async (close) => {
  let lowerClosed = false;
  cleanups.push(onEscape(() => { lowerClosed = true; }));
  const [open, setOpen] = createSignal(false);
  dispose = render(() => <>
    <button data-opener onClick={() => setOpen(true)}>Open channel</button>
    <Show when={open()}><HubChannelConfirm nodeId={`focus-${close}`} onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); }} /></Show>
  </>, mountIn());
  const opener = $('[data-opener]');
  opener.focus();
  opener.click();
  await tick();
  expect(document.activeElement).toBe($('[data-hub-channel-confirm]'));
  if (close === 'Escape') esc();
  else $(close === 'Not now' ? '[data-hub-channel-cancel]' : '[data-hub-channel-ack]').click();
  await tick();
  expect($('[data-hub-channel-confirm]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(lowerClosed).toBe(false);
});

it('an already acknowledged hub opens without taking focus or registering an Escape layer', async () => {
  acknowledgeHubChannel('focus-acknowledged');
  const [open, setOpen] = createSignal(false);
  dispose = render(() => <>
    <button data-opener onClick={() => setOpen(true)}>Open channel</button>
    <Show when={open()}><HubChannelConfirm nodeId="focus-acknowledged" onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); }} /></Show>
  </>, mountIn());
  $('[data-opener]').focus();
  $('[data-opener]').click();
  await tick();
  expect($('[data-hub-channel-confirm]')).toBeNull();
  expect(document.activeElement).toBe($('[data-opener]'));
  expect(escapeDepth()).toBe(0);
});

it('does not suppress the Hub confirm focus outline', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  expect(css).not.toMatch(/\.hub-channel-confirm:focus\s*\{[^}]*outline:\s*(?:none|0)/);
});

it('an incoming call focuses the call panel once, without refocusing', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  let emit!: (event: LiveEvent) => void;
  source.onLive = async (handler) => { emit = handler; return () => {}; };
  await shell(source);
  $('[data-composer] textarea').focus();
  emit({ type: 'message', room_id: null, message: {
    id: 'incoming-focus', kind: 400, sender: 'a'.repeat(64), recipient: SAMPLE_OWN_ID,
    timestamp: Date.now(), payment_amount_msat: 10000,
    plaintext: JSON.stringify({ v: 1, call_id: '0123456789abcdef0123456789abcdef', media: 'audio', sdp: 'v=0 offer' }),
  } });
  await tick();
  expect($('[data-call-panel="incoming"]')).not.toBeNull();
  expect(document.activeElement).toBe($('[data-call-panel="incoming"]'));
  $('[data-composer] textarea').focus();
  await tick();
  expect(document.activeElement).toBe($('[data-composer] textarea'));
});

it('AI Composer options reports its collapsed and expanded state', async () => {
  await shell();
  $('[data-track="ai"]').click();
  const toggle = $('[aria-label="Composer options"]');
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it.each(['none', 'spend', 'unsettled'] as const)('Check pending result is shown only for pending work (%s)', async (pending) => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  if (pending === 'spend') {
    const spend = await source.spendStatus();
    source.spendStatus = async () => ({ ...spend, state: 'pending', pending: {
      op_id: 'pending-focus', expires_at_ms: Date.now() + 600000, owner_action: 'approve', owner_can_grant: true,
    } });
  }
  if (pending === 'unsettled') {
    const budget = await source.budgetStatus();
    source.budgetStatus = async () => ({ ...budget, unsettled_msat: 2000 });
  }
  await shell(source);
  expect(Boolean($('[data-spend-reconcile]'))).toBe(pending !== 'none');
});

it.each(['dispatching', 'unknown', 'paid', 'paid_undelivered'] as const)('a restored %s operation keeps its check until reconciliation settles it', async (state) => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  let op: OpView = { op_id: 'restored-pending', kind: 'message', peer: 'a'.repeat(64), call_id: null,
    state, cap_msat: 10000, paid_msat: null, message_id: null };
  source.opList = async () => ({ operations: [op], skipped: 0, has_more: false });
  source.spendReconcile = async () => { op = { ...op, state: 'settled' }; return 'Previous action settled.'; };
  await shell(source);
  await vi.waitFor(() => expect($('[data-artifact="restored"]')).not.toBeNull());
  expect($('[data-spend-reconcile]')).not.toBeNull();
  $('[data-spend-reconcile]').click();
  await vi.waitFor(() => expect($('[data-restored-state]')?.textContent).toContain('finished'));
  expect($('[data-spend-reconcile]')).toBeNull();
  expect($('[data-reconciliation]')?.textContent).toBe('Previous action settled.');
});

it('Wallet keeps a pending-result check while spend approval is pending', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const spend = await source.spendStatus();
  source.spendStatus = async () => ({ ...spend, state: 'pending', pending: {
    op_id: 'wallet-pending', expires_at_ms: Date.now() + 600000, owner_action: 'approve', owner_can_grant: true,
  } });
  await shell(source);
  $('[data-profile]').click();
  $('[data-open-wallet]').click();
  $('[data-wallet-tab="send"]').click();
  expect($('[data-wallet-page] [data-spend-reconcile]')).not.toBeNull();
});
