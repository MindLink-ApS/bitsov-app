import { readinessSource } from '../src/control/readiness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ControlCenter, setShowLegacyRoomsUi } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_OPEN_ROOM_ID, SAMPLE_PEERS } from '../src/control/sample';
import { asActionError, nodePill } from '../src/control/state';
import { provenUnpaid } from '../src/control/paymentOutcome';
import { setLanguagePref } from '../src/i18n';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
beforeEach(() => { setShowLegacyRoomsUi(true); });
afterEach(() => { dispose?.(); mount?.remove(); vi.useRealTimers(); setShowLegacyRoomsUi(false); });

function draftMessage() {
  const input = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
  input.value = 'hello'; input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function start(ready: boolean | undefined, setup?: (s: ReturnType<typeof sampleSource>) => void) {
  const source = sampleSource({ firstLiveMs: 1e9 });
  setup?.(source);
  const base = await source.nodeOverview();
  const status = { ...base, money_ready: ready, readiness: ready === undefined ? undefined : {
    money_ready: ready, state: ready ? 'ready' : 'offline', retry_attempt: 3, retry_after_secs: 10,
    events: [{ sequence: 1, timestamp: Math.floor(Date.now() / 1000) - 120, state: 'offline', money_ready: false }],
  } };
  source.nodeOverview = async () => ({ ...status, read_at: Date.now() });
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(mount.querySelector('[data-send]')).not.toBeNull());
  draftMessage();
  return { source, status };
}

describe('node money readiness', () => {
  it('disables a warm composer during retry cooldown and recovers without sending', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const send = vi.spyOn(source, 'send');
    const budgetSet = vi.spyOn(source, 'budgetSet');
    const [retry, setRetry] = createSignal<number | null>(null);
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active ready retryAfterSecs={retry()} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect(mount.querySelector('[data-composer] textarea')).not.toBeNull());
    draftMessage();
    await vi.waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-send]')?.disabled).toBe(false));
    const composer = mount.querySelector('[data-composer-bar]');
    mount.querySelector<HTMLButtonElement>('[data-tab="budget"]')!.click();
    mount.querySelector<HTMLButtonElement>('[data-budget-edit]')!.click();
    setRetry(42);
    expect(mount.querySelector<HTMLButtonElement>('[data-budget-save]')!.disabled).toBe(true);
    expect(budgetSet).not.toHaveBeenCalled();
    expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    expect(mount.querySelector('[data-money-notice]')?.textContent).toContain('Waiting for the connection');
    for (const mode of ['pay', 'request', 'file']) {
      mount.querySelector<HTMLButtonElement>(`[data-composer-mode="${mode}"]`)!.click();
      expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
    }
    setRetry(null);
    mount.querySelector<HTMLButtonElement>('[data-composer-close]')!.click();
    expect(mount.querySelector('[data-composer-bar]')).toBe(composer);
    expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not enqueue an old generation budget read after a late spend read', async () => {
    vi.useFakeTimers();
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.onLive = async () => () => {};
    const spend = await source.spendStatus();
    let finish!: (value: typeof spend) => void;
    const old = new Promise<typeof spend>(resolve => { finish = resolve; });
    let reads = 0;
    source.spendStatus = () => ++reads === 1 ? old : Promise.resolve(spend);
    const budget = vi.spyOn(source, 'budgetStatus');
    const [active, setActive] = createSignal(true);
    mount = document.createElement('div'); document.body.appendChild(mount);
    dispose = render(() => <ControlCenter source={source} active={active()} remote ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    setActive(false);
    setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(budget).toHaveBeenCalledTimes(1);
    finish(spend);
    await vi.advanceTimersByTimeAsync(0);
    expect(budget).toHaveBeenCalledTimes(1);
  });

  it.each([true, undefined])('preserves enabled actions with ready=%s', async (ready) => {
    await start(ready);
    expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(false);
    expect(mount.querySelector('[data-money-notice]')).toBeNull();
  });

  it('shows local health, retry and age, blocks every composer mode, then recovers without replay', async () => {
    vi.useFakeTimers();
    const { source, status } = await start(false);
    expect(mount.querySelector('.node-pill')?.textContent).toContain('Money not ready yet');
    expect(mount.querySelector('[data-panel="body"]')?.textContent).toContain('Local OK');
    expect(mount.querySelector('[data-readiness]')?.textContent).toContain('Retrying');
    expect(mount.querySelector('[data-readiness]')?.textContent).toContain('2 min');
    const send = vi.spyOn(source, 'send');
    expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(true);
    for (const mode of ['pay', 'request', 'file']) {
      (mount.querySelector(`[data-composer-mode="${mode}"]`) as HTMLButtonElement).click();
      expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(true);
    }
    expect(mount.querySelectorAll('[data-money-notice]')).toHaveLength(1);
    vi.useFakeTimers();
    status.money_ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mount.querySelector('[data-money-notice]')).toBeNull();
    (mount.querySelector('[data-composer-close]') as HTMLButtonElement).click();
    expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('refreshes failed room and file quotes on recovery without navigation', async () => {
    vi.useFakeTimers();
    let ready = false;
    const { status } = await start(false, (source) => {
      const roomQuote = source.roomQuote;
      source.roomQuote = (id) => ready ? roomQuote(id) : Promise.reject('offline');
      source.filePrice = () => ready ? Promise.resolve({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }) : Promise.reject('offline');
    });
    (mount.querySelector(`[data-track="room:${SAMPLE_OPEN_ROOM_ID}"]`) as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    ready = true; status.money_ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    const cost = mount.querySelector('[data-cost-msat]');
    expect(cost).not.toBeNull();
    expect(Number(cost!.getAttribute('data-cost-msat'))).toBeGreaterThan(0);
    (mount.querySelector(`[data-track="peer:${SAMPLE_PEERS[0].node_id}"]`) as HTMLButtonElement).click();
    (mount.querySelector('[data-composer-mode="file"]') as HTMLButtonElement).click();
    expect(mount.querySelector('[data-cost-msat]')?.getAttribute('data-cost-msat')).toBe('8000');
    expect(mount.querySelector('[data-money-notice]')).toBeNull();
  });

  it('keeps local app prerequisite errors distinct from chain readiness', () => {
    expect(asActionError({ code: 'app_not_ready', message: 'No node identity.' })).toEqual({ code: 'app_not_ready', message: 'No node identity.' });
  });

  it('shows a racing refusal once, preserves inputs, and recovers without replay', async () => {
    vi.useFakeTimers();
    const { source } = await start(true, (source) => {
      source.invoiceCreate = vi.fn().mockRejectedValue({ code: 'not_ready', message: 'backend offline' });
    });
    (mount.querySelector('[data-composer-mode="request"]') as HTMLButtonElement).click();
    const amount = mount.querySelector('[data-request-amount]') as HTMLInputElement;
    amount.value = '10'; amount.dispatchEvent(new Event('input', { bubbles: true }));
    (mount.querySelector('[data-send]') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mount.querySelectorAll('[data-money-notice]')).toHaveLength(1);
    expect(mount.querySelector('[data-composer-note]')).toBeNull();
    expect(amount.value).toBe('10');
    expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mount.querySelector('[data-money-notice]')).toBeNull();
    expect((mount.querySelector('[data-send]') as HTMLButtonElement).disabled).toBe(false);
    expect(amount.value).toBe('10');
    expect(source.invoiceCreate).toHaveBeenCalledTimes(1);
  });

  it('maps the node refusal to the common calm message', () => {
    expect(asActionError({ code: 'not_ready', message: 'backend unavailable' }).message).toBe('Money is not ready yet. Your node will retry automatically.');
  });

  it.each([
    ['en', 'Hanging up this call would cost more than your node grant allows per message payment, so it could not be ended. The owner would need to approve a larger per-payment limit. Nothing was sent or paid.'],
    ['da', 'At lægge på i dette opkald ville koste mere, end din nodes tilladelse giver pr. beskedbetaling, så opkaldet ville ikke kunne afsluttes. Ejeren skal godkende en højere grænse pr. betaling. Intet blev sendt eller betalt.'],
  ] as const)('the host refusing a call it could not end reads in the app language (%s), and nothing was paid', (lang, words) => {
    setLanguagePref(lang);
    try {
      const error = asActionError({ code: 'call_hangup_unpayable', message: 'host words in English' });
      expect(error).toEqual({ code: 'call_hangup_unpayable', message: words });
      expect(provenUnpaid(error.code)).toBe(true);
    } finally {
      setLanguagePref('en');
    }
  });

  it.each([
    ['en', 'Hanging up this call would cost more than any message payment may carry, so it could not be ended. A larger per-payment limit would not change that. Nothing was sent or paid.'],
    ['da', 'At lægge på i dette opkald ville koste mere, end en beskedbetaling højst må være, så opkaldet ville ikke kunne afsluttes. En højere grænse pr. betaling ville ikke ændre det. Intet blev sendt eller betalt.'],
  ] as const)('a hangup above the message maximum reads in the app language (%s), asks for no larger limit, and nothing was paid', (lang, words) => {
    setLanguagePref(lang);
    try {
      const error = asActionError({ code: 'call_hangup_above_message_max', message: 'host words in English' });
      expect(error).toEqual({ code: 'call_hangup_above_message_max', message: words });
      expect(provenUnpaid(error.code)).toBe(true);
    } finally {
      setLanguagePref('en');
    }
  });

  it.each([
    ['en', 'This permission covers messages and calls. Ask the owner to approve this payment separately. Nothing was paid.'],
    ['da', 'Denne tilladelse dækker beskeder og opkald. Bed ejeren om at godkende denne betaling særskilt. Intet blev betalt.'],
  ] as const)('a messaging grant refusing a payment has its own plain words (%s), and nothing was paid', (lang, words) => {
    setLanguagePref(lang);
    try {
      const error = asActionError({ code: 'grant_messaging', message: 'host words' });
      expect(error).toEqual({ code: 'grant_messaging', message: words });
      expect(provenUnpaid(error.code)).toBe(true);
    } finally {
      setLanguagePref('en');
    }
  });

  it('does not mistake an older node without the field for unavailable money', async () => {
    const source = sampleSource();
    expect(nodePill({ ready: true, error: null, overview: await source.nodeOverview(), link: 'open', nowMs: Date.now() }).text).toBe('Connected to your node');
  });
});

describe('shared money guard', () => {
  it.each(['retry', 'send', 'pay', 'keysend', 'fileSend', 'invoiceCreate', 'firstContactQuote', 'firstContactRequest', 'sponsorOffer', 'sponsorCandidate', 'sponsorOwnerApproval', 'sponsorRequest', 'inviteCreate', 'inviteRedeem', 'fundStart', 'fundingAddress', 'callSignal', 'spendRequest', 'relationApprove', 'budgetApprove', 'budgetResume', 'budgetSet', 'porchRead'] as const)('stops %s before reaching the host and permits it after recovery', async (method) => {
    const source = sampleSource();
    const call = vi.fn().mockResolvedValue('host reply');
    Object.assign(source, { [method]: call });
    let blocked = true;
    const guarded = readinessSource(() => source, () => blocked, () => {});
    await expect(Reflect.apply(guarded[method], guarded, [])).rejects.toMatchObject({ code: 'not_ready' });
    expect(call).not.toHaveBeenCalled();
    blocked = false;
    await expect(Reflect.apply(guarded[method], guarded, [])).resolves.toBe('host reply');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps local reads and cancellation usable while money is unavailable', async () => {
    const source = sampleSource();
    const guarded = readinessSource(() => source, () => true, () => {});
    expect(await guarded.peers()).not.toHaveLength(0);
    await expect(guarded.fundState()).resolves.toBeDefined();
    await expect(guarded.firstContactCancel('op')).resolves.toBeUndefined();
  });

  it('turns a racing node refusal into one shared state and never replays the call', async () => {
    const source = sampleSource();
    const refused = vi.fn();
    source.pay = vi.fn().mockRejectedValue({ code: 'not_ready', message: 'offline' });
    const guarded = readinessSource(() => source, () => false, refused);
    await expect(guarded.pay('invoice', 1000, 6000)).rejects.toMatchObject({ code: 'not_ready', message: 'Money is not ready yet. Your node will retry automatically.' });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(source.pay).toHaveBeenCalledTimes(1);
  });
});

// #53 retries retain the paid card through #56 readiness transitions.
describe('paid delivery retry readiness', () => {
  const button = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!;
  const admission = { admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, quoted: true };
  const approval = { id: 'retry-approval', owner_command: 'approve at node', ready: false, expires_at_ms: Date.now() + 600_000,
    request: { client_id: 'c1', grant_op_id: 'ab12', recipient: SAMPLE_PEERS[0].node_id, max_total_msat: 14000, contact_budget_msat: 14000 } };
  async function paidCard() {
    vi.useFakeTimers();
    const result = await start(true, (source) => {
      source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
      source.send = vi.fn().mockRejectedValue({ code: 'payment_settled_undelivered', message: 'Paid, not delivered',
        undelivered: { paid_msat: 2000, retry: true }, pending_id: 'paid-record' });
    });
    const draft = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    draft.value = 'paid message'; draft.dispatchEvent(new Event('input', { bubbles: true }));
    button('[data-send]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mount.querySelector('[data-artifact="undelivered"]')).not.toBeNull();
    return result;
  }
  async function priceCard() {
    const result = await paidCard();
    result.source.retry = vi.fn().mockRejectedValue({ code: 'retry_needs_admission', message: 'Approval needed', admission });
    button('[data-retry-delivery]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button('[data-retry-approve]')).not.toBeNull();
    return result;
  }

  it.each([false, true])('blocks offline retry controls, keeps stop available, and requires a manual recovery action (approval=%s)', async (priced) => {
    const { source, status } = await (priced ? priceCard() : paidCard());
    const retry = source.retry = vi.fn().mockResolvedValue({ message_id: 'recovered', recipient: SAMPLE_PEERS[0].node_id, is_room: false, delivered: true, amount_msat: 0, sent_at_ms: Date.now() });
    source.firstContactRequest = vi.fn().mockResolvedValue(null);
    status.money_ready = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const selector = priced ? '[data-retry-approve]' : '[data-retry-delivery]';
    expect(button(selector).disabled).toBe(true);
    expect(button('[data-stop-retrying]').disabled).toBe(false);
    button(selector).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).not.toHaveBeenCalled();
    expect(source.firstContactRequest).not.toHaveBeenCalled();
    status.money_ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(button(selector).disabled).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    button(selector).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(mount.querySelector('[data-artifact="undelivered"]')).toBeNull();
  });

  it.each(['retry', 'firstContactRequest'] as const)('shows the shared notice on a racing %s refusal and retains the paid card', async (method) => {
    const { source } = await (method === 'retry' ? paidCard() : priceCard());
    source[method] = vi.fn().mockRejectedValue({ code: 'not_ready', message: 'offline' });
    button(method === 'retry' ? '[data-retry-delivery]' : '[data-retry-approve]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mount.querySelectorAll('[data-money-notice]')).toHaveLength(1);
    expect(mount.querySelector('[data-artifact="undelivered"]')?.getAttribute('data-paid-msat')).toBe('2000');
    expect(mount.querySelector('[data-retry-note]')).toBeNull();
    expect(button('[data-stop-retrying]').disabled).toBe(false);
  });

  it.each(['pending', 'request', 'status'] as const)('cancels %s retry approval across offline/recovery without replay', async (phase) => {
    const { source, status } = await priceCard();
    let complete!: (value: typeof approval) => void;
    source.firstContactCancel = vi.fn().mockResolvedValue(undefined);
    source.firstContactRequest = vi.fn().mockImplementation(() => phase === 'request'
      ? new Promise<typeof approval>((resolve) => { complete = resolve; }) : Promise.resolve(approval));
    source.firstContactStatus = vi.fn().mockImplementation(() => new Promise<typeof approval>((resolve) => { complete = resolve; }));
    button('[data-retry-approve]').click();
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'status') {
      button('[data-retry-approve]').click();
      await vi.advanceTimersByTimeAsync(0);
    }
    status.money_ready = false;
    await vi.advanceTimersByTimeAsync(10_000);
    status.money_ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    if (phase !== 'pending') complete({ ...approval, ready: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.firstContactCancel).toHaveBeenCalledWith('retry-approval');
    expect(mount.querySelector('[data-retry-owner]')).toBeNull();
    expect(mount.querySelector('[data-artifact="undelivered"]')).not.toBeNull();
    expect(source.retry).toHaveBeenCalledTimes(1); // Only the earlier zero-cap probe.
    source.firstContactRequest = vi.fn().mockResolvedValue(null);
    source.retry = vi.fn().mockResolvedValue({ message_id: 'manual', recipient: SAMPLE_PEERS[0].node_id, is_room: false, delivered: true, amount_msat: 4000, sent_at_ms: Date.now() });
    button('[data-retry-approve]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.firstContactRequest).toHaveBeenCalledTimes(1);
    expect(source.retry).toHaveBeenCalledWith(SAMPLE_PEERS[0].node_id, 'paid message', 14000);
    expect(mount.querySelector('[data-artifact="undelivered"]')).toBeNull();
  });
});
