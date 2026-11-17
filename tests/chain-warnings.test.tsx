import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { readinessSource } from '../src/control/readiness';
import { asActionError } from '../src/control/state';
import { setLanguagePref } from '../src/i18n';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); });

async function open(source: ReturnType<typeof sampleSource>) {
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect(mount.querySelector('[data-composer] textarea')).not.toBeNull());
}

it.each([
  ['en', 'Your box reads the chain from a public service.', 'See how to use your own', 'Bitcoin Core or Electrum'],
  ['da', 'Din boks læser kæden fra en offentlig tjeneste.', 'Se, hvordan du bruger din egen', 'Bitcoin Core eller Electrum'],
] as const)('shows the default public source and accessible guidance (%s)', async (lang, notice, action, guidance) => {
  setLanguagePref(lang);
  const source = sampleSource({ firstLiveMs: 1e9 });
  const base = await source.nodeOverview();
  source.nodeOverview = async () => ({ ...base, chain_view: { explorer_default: true, trust_level: 'third_party' } });
  await open(source);
  await vi.waitFor(() => expect(mount.querySelector('[data-chain-notice]')?.textContent).toContain(notice));
  expect(mount.querySelector('[data-chain-notice] [role="status"]')?.textContent).toBe(notice);
  const summary = mount.querySelector<HTMLElement>('[data-chain-notice] summary')!;
  expect(summary.textContent).toBe(action);
  summary.click();
  expect(mount.querySelector('[data-chain-notice] details')?.hasAttribute('open')).toBe(true);
  expect(mount.querySelector('[data-chain-notice] details')?.textContent).toContain(guidance);
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
});

it.each([undefined, { trust_level: 'third_party' }, { explorer_default: false, trust_level: 'third_party' }, { explorer_default: true, trust_level: 'full' }])('does not infer an unchosen explorer from %j', async (chain_view) => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const base = await source.nodeOverview();
  source.nodeOverview = async () => ({ ...base, chain_view });
  await open(source);
  expect(mount.querySelector('[data-chain-notice]')).toBeNull();
});

it.each([
  ['en', "Your box can't see the Bitcoin chain right now; nothing was paid; try again later."],
  ['da', 'Din boks kan ikke se Bitcoin-kæden lige nu; intet blev betalt; prøv igen senere.'],
] as const)('keeps a refused paid send and shows its chain reason (%s)', async (lang, words) => {
  setLanguagePref(lang);
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.send = vi.fn(async () => { throw { code: 'not_ready', reason: 'chain_unavailable', message: 'upstream detail' }; });
  await open(source);
  const input = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
  input.value = 'hello'; input.dispatchEvent(new Event('input', { bubbles: true }));
  const send = mount.querySelector<HTMLButtonElement>('[data-send]')!;
  await vi.waitFor(() => expect(send.disabled).toBe(false));
  send.click();
  await vi.waitFor(() => expect(mount.textContent).toContain(words));
  expect(input.value).toBe('hello');
  expect(mount.textContent).not.toContain('upstream detail');
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
  expect(source.send).toHaveBeenCalledTimes(1);
});

it('preserves the typed reason without blocking free sends or local reads', async () => {
  const source = sampleSource();
  source.send = async (recipient, room, text, cap) => {
    if (cap > 0) throw { code: 'not_ready', reason: 'chain_unavailable', message: 'upstream detail' };
    return { message_id: 'free', recipient, is_room: room, delivered: true, amount_msat: 0, sent_at_ms: Date.now() };
  };
  let blocked = false;
  const guarded = readinessSource(() => source, () => blocked, () => { blocked = true; });
  await expect(guarded.send('a'.repeat(64), false, 'paid', 7000)).rejects.toMatchObject({ code: 'not_ready', reason: 'chain_unavailable' });
  await expect(guarded.send('a'.repeat(64), false, 'free', 0)).resolves.toMatchObject({ amount_msat: 0 });
  expect(await guarded.peers()).not.toHaveLength(0);
});

it('uses the chain wording only for the typed readiness reason', () => {
  expect(asActionError({ code: 'not_ready', reason: 'chain_unavailable', message: 'upstream detail' })).toEqual({
    code: 'not_ready', reason: 'chain_unavailable', message: "Your box can't see the Bitcoin chain right now; nothing was paid; try again later.",
  });
  for (const reason of [undefined, 'unknown', 'chain_unavailable later']) {
    expect(asActionError({ code: 'not_ready', reason, message: 'chain_unavailable' }).message).toBe('Money is not ready yet. Your node will retry automatically.');
  }
  expect(asActionError({ code: 'node', reason: 'chain_unavailable', message: 'Unresolved result' }).message).toBe('Unresolved result');
});

it.each(['peer', 'first-contact'] as const)('shows the chain refusal from a legacy %s quote without locking the shell', async kind => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  if (kind === 'peer') source.priceQuote = async () => { throw 'not_ready:chain_unavailable'; };
  else {
    const read = source.budgetStatus;
    source.budgetStatus = async () => ({ ...await read(), autopay: { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 100000, ceiling_msat: 500000 }, rows: [] });
    source.firstContactQuote = async () => { throw 'not_ready:chain_unavailable'; };
  }
  await open(source);
  await vi.waitFor(() => expect(mount.textContent).toContain("Your box can't see the Bitcoin chain right now; nothing was paid; try again later."));
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
});

it('localizes the canonical string refusal without treating arbitrary text as unpaid', () => {
  setLanguagePref('da');
  expect(asActionError('not_ready:chain_unavailable')).toEqual({ code: 'not_ready', reason: 'chain_unavailable',
    message: 'Din boks kan ikke se Bitcoin-kæden lige nu; intet blev betalt; prøv igen senere.' });
  expect(asActionError('not_ready:chain_unavailable later').code).toBe('node');
});

it.each([
  ['en', "Your box can't see the Bitcoin chain right now; nothing was paid; try again later."],
  ['da', 'Din boks kan ikke se Bitcoin-kæden lige nu; intet blev betalt; prøv igen senere.'],
] as const)('translates a chain refusal embedded in a conversation quote (%s)', async (language, words) => {
  setLanguagePref(language);
  const source = sampleSource({ firstLiveMs: 1e9 });
  const quote = await source.priceQuote('a'.repeat(64));
  source.priceQuote = async () => ({ ...quote, send_unavailable: 'not_ready:chain_unavailable' });
  await open(source);
  await vi.waitFor(() => expect(mount.textContent).toContain(words));
  expect(mount.textContent).not.toContain('not_ready:chain_unavailable');
});

it.each([
  ['en', "Your box can't see the Bitcoin chain right now; nothing new was paid; try again later."],
  ['da', 'Din boks kan ikke se Bitcoin-kæden lige nu; intet nyt blev betalt; prøv igen senere.'],
] as const)('keeps the earlier payment visible when only its delivery retry is refused (%s)', async (language, words) => {
  setLanguagePref(language);
  const source = sampleSource({ firstLiveMs: 1e9 });
  source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 });
  source.send = async () => { throw { code: 'payment_settled_undelivered', message: 'Paid, not delivered',
    undelivered: { paid_msat: 2000, retry: true }, pending_id: 'paid-record' }; };
  source.retry = async () => { throw { code: 'not_ready', reason: 'chain_unavailable', message: 'upstream detail' }; };
  await open(source);
  const input = mount.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
  input.value = 'paid message'; input.dispatchEvent(new Event('input', { bubbles: true }));
  mount.querySelector<HTMLButtonElement>('[data-send]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-artifact="undelivered"]')).not.toBeNull());
  mount.querySelector<HTMLButtonElement>('[data-retry-delivery]')!.click();
  await vi.waitFor(() => expect(mount.querySelector('[data-retry-note]')?.textContent).toContain(words));
  expect(mount.querySelector('[data-artifact="undelivered"]')?.getAttribute('data-paid-msat')).toBe('2000');
  expect(mount.querySelector('[data-money-notice]')).toBeNull();
});
