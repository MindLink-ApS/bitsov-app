import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PEERS, SAMPLE_PRESETS } from '../src/control/sample';
import { membraneNode } from '../src/control/body';
import type { Source } from '../src/control/source';
import type { MembraneEvent } from '../src/control/types';

// PR #47 merge-gate regressions (/tmp/bitsov-codex/47-verdict.txt, findings
// 5-7), from the reviewer's independent reproductions. Findings 1-4 are
// host-side: src-tauri/src/main.rs (`review_regression_*`, `pr47_*`) and
// src-tauri/tests/pr47_budget.rs.
describe('PR47 independent frontend regressions', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
  });
  function start(source: Source) {
    source.onLive = (handler) => {
      handler({ type: 'link', state: 'open', detail: null });
      return Promise.resolve(() => {});
    };
    source.liveLink = async () => 'open';
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  }

  it('retains a new N2 event when the node restarts its per-run sequence', () => {
    const oldEvent: MembraneEvent = {
      seq: 1, at: 1_000, direction: 'inbound', verdict: 'refused', code: 'unpaid',
      kind: 0, counterparty: null, first_contact: false,
      required_msat: 1000, paid_msat: 0, cap_msat: null,
    };
    const ctx = { contacts: new Set<string>() };
    const log = membraneNode([], oldEvent, ctx);
    const afterRestart = membraneNode(log, { ...oldEvent, at: 100_000, code: 'bad_signature' }, ctx);
    expect(afterRestart.some((entry) => entry.at === 100_000)).toBe(true);
  });

  it('does not claim a live complete membrane reading when the N2 seed failed', async () => {
    const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
    const failed = vi.fn(async () => { throw new Error('membrane endpoint unavailable'); });
    source.membrane = failed;
    start(source);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    const membrane = mount!.querySelector('[data-organ="membrane"]')!;
    // No successful reading: neither Live nor a claim that nothing knocked.
    expect(membrane.textContent).not.toContain('at your door: none');
    expect(membrane.textContent).toContain('at your door: not read yet');
    expect(membrane.querySelector('[data-organ-fresh]')!.textContent).toBe('Reading unavailable');
  });

  it('uses admission plus message price for the first outgoing reply to an inbound sender', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const peer = SAMPLE_PEERS[0].node_id;
    source.peers = async () => [SAMPLE_PEERS[0]];
    source.messages = async () => [{
      id: 'review-inbound-only', kind: 0, sender: peer, recipient: SAMPLE_OWN_ID,
      timestamp: Date.now() - 1000, plaintext: 'review: inbound only, never paid this peer', payment_amount_msat: 1000,
    }];
    source.budgetStatus = async () => ({
      paused: false, waiting_for_owner: false, preset: 'careful',
      autopay: { state: 'open', open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' },
      ceiling_msat: 500_000, spent_msat: 0, unsettled_msat: 0, rows: [],
      presets: SAMPLE_PRESETS, window_ms: 86_400_000, max_daily_msat: 100_000_000, node_grant: null,
    });
    source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0, peer_stale: false });
    source.firstContactQuote = async () => ({ recipient: peer, admission_msat: 3000, message_msat: 2000, total_msat: 5000, expires_at: Math.floor(Date.now() / 1000) + 60 });
    start(source);
    await vi.waitFor(() => expect(mount!.textContent).toContain('review: inbound only, never paid this peer'));
    await vi.waitFor(() => expect(mount!.querySelector('[data-first-contact]')).not.toBeNull());
    expect(mount!.querySelector('[data-cost-msat]')!.getAttribute('data-cost-msat')).toBe('5000');
  });

  const openBudget = async () => ({
    paused: false, waiting_for_owner: false, preset: 'careful' as const,
    autopay: { state: 'open' as const, open_until_ms: Date.now() + 86_400_000, ceiling_msat: 500_000, basis: 'node_grant' as const },
    ceiling_msat: 500_000, spent_msat: 0, unsettled_msat: 0, rows: [],
    presets: SAMPLE_PRESETS, window_ms: 86_400_000, max_daily_msat: 100_000_000, node_grant: null,
  });

  it('finding 5: the same event from the same run is still folded once', () => {
    const event: MembraneEvent = {
      seq: 7, at: 5_000, direction: 'inbound', verdict: 'refused', code: 'unpaid',
      kind: 0, counterparty: null, first_contact: false, required_msat: 1000, paid_msat: 0, cap_msat: null,
    };
    const ctx = { contacts: new Set<string>() };
    const once = membraneNode([], event, ctx);
    expect(membraneNode(once, { ...event }, ctx)).toBe(once);
  });

  it('finding 6: an old door price whose re-read fails is shown stale, not as current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const source = sampleSource({ firstLiveMs: 1e9, organism: 'v2' });
      let fail = false;
      const quote = source.priceQuote;
      source.priceQuote = async (peer) => {
        if (fail) throw new Error('node not answering');
        return quote(peer);
      };
      start(source);
      await vi.waitFor(() => expect(mount!.querySelector('[data-door-fresh]')?.getAttribute('data-door-fresh')).toBe('fresh'));
      fail = true;
      vi.advanceTimersByTime(30_001);
      await vi.waitFor(() => expect(mount!.querySelector('[data-door-fresh]')?.getAttribute('data-door-fresh')).toBe('stale'));
      expect(mount!.querySelector('[data-door]')!.textContent).toContain('could not re-read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('finding 7: a price refusal on a first contact asks the stranger for a fresh quote', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const peer = SAMPLE_PEERS[0].node_id;
    source.peers = async () => [SAMPLE_PEERS[0]];
    source.messages = async () => [];
    source.budgetStatus = openBudget;
    source.priceQuote = async () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 0, peer_stale: false });
    const quotes = vi.fn(async () => ({ recipient: peer, admission_msat: 3000, message_msat: 2000, total_msat: 5000, expires_at: Math.floor(Date.now() / 1000) + 60 }));
    source.firstContactQuote = quotes;
    source.send = async () => { throw { code: 'price_cap_exceeded', message: 'The node refused the changed price before any payment.' }; };
    start(source);
    await vi.waitFor(() => expect(mount!.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('5000'));
    expect(quotes).toHaveBeenCalledTimes(1);
    const box = mount!.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    box.value = 'hello';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(mount!.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(false));
    mount!.querySelector<HTMLButtonElement>('[data-send]')!.click();
    await vi.waitFor(() => expect(quotes).toHaveBeenCalledTimes(2));
  });
});
