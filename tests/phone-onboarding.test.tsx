import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { PhoneOnboarding, type PhoneOnboardingProps } from '../src/onboarding/PhoneOnboarding';
import { PhoneTrust } from '../src/onboarding/PhoneTrust';
import { INITIAL_PAIRING, type ConnectionError, type NodeStatus } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent === name)!;
function mount(extra: Partial<PhoneOnboardingProps> = {}) {
  const props: PhoneOnboardingProps = {
    status: () => ({ ready: false, node_id: null, error: null }), pairing: () => INITIAL_PAIRING,
    device: () => null, locale: 'en', scan: vi.fn().mockResolvedValue('bitsov://pair/synthetic'),
    preview: vi.fn().mockResolvedValue({ second_device: true, endpoint: 'box:443', node_id_fingerprint: 'ABCD' }),
    connect: vi.fn().mockResolvedValue({ endpoint: 'box:443', node_id_fingerprint: 'ABCD', restart_required: false }),
    retry: vi.fn().mockResolvedValue(undefined), forget: vi.fn().mockResolvedValue(undefined),
    beginJoin: vi.fn().mockResolvedValue({ state: 'waiting', words: ['alpha', 'beta', 'gamma', 'delta'], expires_at: Date.now()/1000 + 300 }),
    join: vi.fn().mockResolvedValue({ state: 'idle', second_device: true }), openSettings: vi.fn().mockResolvedValue(undefined),
    openTailscale: vi.fn().mockResolvedValue(undefined), onDone: vi.fn(), ...extra,
  };
  dispose = render(() => <PhoneOnboarding {...props} />, document.body);
  return props;
}
it('starts with one action and a collapsed paste route, without a secret input', async () => {
  mount();
  await tick();
  const heading = document.querySelector('h1')!;
  expect(document.activeElement).toBe(heading);
  expect(heading.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(heading.getAttribute('aria-describedby')!)?.textContent).toBe('Other device → Add a device.');
  expect(document.querySelector('[data-phone-face]')?.getAttribute('aria-live')).toBeNull();
  expect(document.querySelectorAll('button.primary')).toHaveLength(1);
  expect(button("Scan your box’s QR")).toBeTruthy();
  expect(document.querySelector('details')?.open).toBe(false);
  expect(button('Paste link')).toBeTruthy();
  expect(document.querySelector('input, textarea')).toBeNull();
  const privacy = document.querySelector<HTMLAnchorElement>('[data-privacy-policy]');
  expect(privacy?.textContent).toBe('Privacy policy');
  expect(privacy?.href).toBe('https://mindlink.tech/bitsov/privacy');
});
it('auto-connects a scan, displays ordered words and only the owner can approve', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ status, pairing, device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  button("Scan your box’s QR").click(); await tick();
  expect(props.connect).toHaveBeenCalledWith('bitsov://pair/synthetic');
  expect(document.body.textContent).not.toContain('bitsov://');
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' });
  setStatus({ ready: true, node_id: 'box', error: null }); await tick();
  expect([...document.querySelectorAll('[data-pair-word]')].map(e => e.textContent)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  expect(document.body.textContent).toContain('Approve on your other device.');
  expect(button('They match')).toBeUndefined();
  expect(props.beginJoin).toHaveBeenCalledWith();
  button("They don't match").click(); await tick();
  expect(props.join).toHaveBeenCalledWith({ action: 'cancel' });
  expect(document.body.textContent).toContain('Stopped. Nothing was added.');
});
it('rejects an unclaimed preview before dialing', async () => {
  const props = mount({ preview: vi.fn().mockResolvedValue({ first_run: true, endpoint: 'box', node_id_fingerprint: '' }) });
  button("Scan your box’s QR").click(); await tick();
  expect(props.connect).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("This box isn't set up yet");
});
it('reads clipboard only on tap and never echoes an invalid value', async () => {
  const readText = vi.fn().mockResolvedValue('private clipboard contents');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const props = mount(); expect(readText).not.toHaveBeenCalled();
  button('Paste link').click(); await tick();
  expect(document.body.textContent).toContain('Nothing to paste.');
  expect(document.body.textContent).not.toContain('private clipboard contents');
  expect(props.connect).not.toHaveBeenCalled();
});
it.each([
  ['unclaimed', "This box isn't set up yet", 'Start over'],
  ['local_network', 'Allow BitSov on your local network', 'Open Settings'],
  ['unreachable', "Can't reach your box", 'Try again'],
  ['tailscale', "Can't reach your box", 'Open Tailscale'],
  ['expired', 'This QR has expired', 'Scan the new QR'],
  ['used', 'This QR has expired', 'Scan the new QR'],
  ['clock', 'This QR has expired', 'Scan the new QR'],
  ['claim_mismatch', 'This phone could not be added', 'Start over'],
  ['busy', 'Your box is busy', 'Try again'],
  ['other', "Can't connect to your box", 'Try again'],
] as const)('maps %s to one actionable error screen', async (kind, title, action) => {
  mount({ status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind, detail: 'diagnostic' } as ConnectionError }) });
  await tick();
  expect(document.querySelector('h1')?.textContent).toBe(title);
  expect(document.querySelectorAll('button.primary')).toHaveLength(1);
  expect(button(action)).toBeTruthy();
  expect(document.querySelector('[data-phone-face]')?.textContent).not.toContain('diagnostic');
});
it('explains a disabled primary and connects its accessible description', async () => {
  mount({ scan: () => new Promise(() => {}) }); button("Scan your box’s QR").click(); await tick();
  const primary = document.querySelector<HTMLButtonElement>('button.primary')!;
  expect(primary.disabled).toBe(true);
  expect(document.getElementById(primary.getAttribute('aria-describedby')!)?.textContent).toBeTruthy();
});
it('ships Danish copy while preserving the protocol words', () => {
  mount({ locale: 'da-DK' });
  expect(document.querySelector('h1')?.textContent).toBe('Forbind til din boks');
  expect(button('Scan boksens QR-kode')).toBeTruthy();
  expect(document.querySelector('summary')?.textContent).toBe('Andre muligheder');
});
it('only reaches Done after the host reports completion', async () => {
  vi.useFakeTimers();
  const join = vi.fn().mockResolvedValueOnce({ state: 'idle', second_device: true }).mockResolvedValue({ state: 'done' });
  const props = mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('words');
  expect(props.onDone).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  button('Open BitSov').click(); expect(props.onDone).toHaveBeenCalledOnce();
});
it('uses a persisted retry on foreground return, without scanning or reimporting', async () => {
  const props = mount({ status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind: 'local_network', detail: '' } }) });
  button('Open Settings').click(); await tick();
  expect(props.openSettings).toHaveBeenCalledOnce();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange')); await tick();
  expect(props.retry).toHaveBeenCalledOnce(); expect(props.scan).not.toHaveBeenCalled(); expect(props.connect).not.toHaveBeenCalled();
});
it('consumes an incoming cold link directly without a review banner', async () => {
  const props = mount({ incoming: { link: 'bitsov://pair/synthetic' }, onConsumeLink: vi.fn() });
  await tick(); expect(props.onConsumeLink).toHaveBeenCalledOnce(); expect(props.connect).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-pairing-link-banner]')).toBeNull();
});
it('never reports a mismatch cancellation as successful if cancellation fails', async () => {
  const join = vi.fn().mockResolvedValueOnce({ state: 'waiting', words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000+300 }).mockRejectedValue({ kind: 'unreachable', detail: '' });
  mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); button("They don't match").click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe("Can't reach your box");
  expect(document.body.textContent).not.toContain('Nothing was added');
});
it('keeps fingerprint confirmation for a host without delegation', async () => {
  const props = mount({ status: () => ({ ready: true, node_id: 'ABCDEF', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: false, delegation_supported: false, state: 'unavailable', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  await tick(); expect(document.querySelector('h1')?.textContent).toBe('Does this match your other screen?');
  expect(props.beginJoin).not.toHaveBeenCalled(); button('They match').click();
  expect(button('Open BitSov')).toBeTruthy();
});
it('shows camera denial as E4 with one settings action', async () => {
  mount({ scan: vi.fn().mockRejectedValue({ kind: 'camera' }) });
  button("Scan your box’s QR").click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe("BitSov can't use the camera");
  expect(button('Open Settings')).toBeTruthy(); expect(document.querySelectorAll('.primary')).toHaveLength(1);
});
it('an expired comparison cannot become Done from a late poll', async () => {
  vi.useFakeTimers();
  let finish!: (v: { state: 'done' }) => void;
  const join = vi.fn().mockResolvedValueOnce({ state: 'waiting', words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000 + 2 }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); await vi.advanceTimersByTimeAsync(1500); await vi.advanceTimersByTimeAsync(1500);
  expect(document.querySelector('h1')?.textContent).toBe('Approval timed out');
  finish({ state: 'done' }); await tick();
  expect(document.querySelector('h1')?.textContent).toBe('Approval timed out');
});
it('a retry that reports the same host error stays actionable', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null, connection_error: { kind: 'unreachable', detail: 'offline' } });
  mount({ status, retry: async () => { setStatus({ ...status(), connection_error: { kind: 'unreachable', detail: 'offline' } }); } });
  button('Try again').click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe("Can't reach your box");
  expect(button('Try again').disabled).toBe(false);
});
it('does not import a delayed clipboard result after unmount', async () => {
  let finish!: (text: string) => void;
  vi.stubGlobal('navigator', { clipboard: { readText: () => new Promise(resolve => { finish = resolve; }) } });
  const props = mount(); button('Paste link').click(); dispose!(); dispose = undefined;
  finish('bitsov://pair/synthetic'); await tick();
  expect(props.preview).not.toHaveBeenCalled(); expect(props.connect).not.toHaveBeenCalled();
});
it('start over after unclaimed preview never cancels a nonexistent enrollment', async () => {
  const props = mount({ preview: vi.fn().mockResolvedValue({ first_run: true, endpoint: 'box', node_id_fingerprint: '' }), join: vi.fn().mockRejectedValue('no remote connection') });
  button("Scan your box’s QR").click(); await tick(); button('Start over').click(); await tick();
  expect(props.join).not.toHaveBeenCalled(); expect(button("Scan your box’s QR")).toBeTruthy();
});
it('waits for native cancellation before enabling another scan', async () => {
  let finish!: () => void;
  const props = mount({ scan: () => new Promise(() => {}), cancelScan: () => new Promise(resolve => { finish = resolve; }) });
  button("Scan your box’s QR").click(); await tick(); button('Cancel').click(); await tick();
  expect(button("Scan your box’s QR").disabled).toBe(true);
  finish(); await tick(); expect(button("Scan your box’s QR").disabled).toBe(false);
  expect(props.connect).not.toHaveBeenCalled();
});
it('discards a clipboard read superseded by scanning and cancelling', async () => {
  let finish!: (text: string) => void;
  vi.stubGlobal('navigator', { clipboard: { readText: () => new Promise(resolve => { finish = resolve; }) } });
  const props = mount({ scan: () => new Promise(() => {}), cancelScan: async () => {} });
  button('Paste link').click(); button("Scan your box’s QR").click(); await tick(); button('Cancel').click(); await tick();
  finish('bitsov://pair/synthetic'); await tick(); expect(props.preview).not.toHaveBeenCalled();
});
it('does not resume a late approval poll after mismatched words are cancelled', async () => {
  vi.useFakeTimers();
  let finish!: (v: { state: 'done' }) => void;
  const join = vi.fn().mockResolvedValueOnce({ state: 'waiting', words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000+300 }).mockImplementation(input => input.action === 'cancel' ? Promise.resolve({ state: 'idle', second_device: true }) : new Promise(resolve => { finish = resolve; }));
  mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); await vi.advanceTimersByTimeAsync(1500);
  button("They don't match").click(); await tick(); finish({ state: 'done' }); await tick();
  expect(document.querySelector('h1')?.textContent).toBe('Stopped. Nothing was added.');
});
it('native cancellation is single-flight even when Cancel is tapped twice', async () => {
  let finish!: () => void;
  const cancelScan = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  mount({ scan: () => new Promise(() => {}), cancelScan });
  button("Scan your box’s QR").click(); await tick(); const cancel = button('Cancel'); cancel.click(); cancel.click();
  expect(cancelScan).toHaveBeenCalledOnce(); finish(); await tick();
});
it('paste cannot replace enrollment after its polling connection fails', async () => {
  vi.useFakeTimers();
  const readText = vi.fn().mockResolvedValue('bitsov://pair/another');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const join = vi.fn().mockResolvedValueOnce({ state: 'waiting', words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000+300 }).mockRejectedValue({ kind: 'unreachable' });
  const props = mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); await vi.advanceTimersByTimeAsync(1500);
  expect(button('Paste link').disabled).toBe(true); button('Paste link').click(); await tick();
  expect(readText).not.toHaveBeenCalled(); expect(props.connect).not.toHaveBeenCalled();
});
it.each([
  ['android', 'refused'], ['android', 'missing'], ['ios', 'refused'], ['ios', 'missing'],
] as const)('%s offers masked manual paste when clipboard access is %s', async (platform, access) => {
  const readText = vi.fn().mockRejectedValue('private failure');
  vi.stubGlobal('navigator', access === 'missing' ? {} : { clipboard: { readText } });
  const props = mount({ platform });
  expect(readText).not.toHaveBeenCalled();
  button('Paste link').click(); await tick();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]');
  expect(input).not.toBeNull();
  expect(input!.type).toBe('password');
  expect(input!.autocomplete).toBe('off');
  expect(document.querySelector<HTMLDetailsElement>('.phone-options')!.open).toBe(true);
  expect(document.body.textContent).not.toContain('private failure');
  input!.value = 'bitsov://pair/synthetic'; input!.dispatchEvent(new Event('input', { bubbles: true }));
  button('Use link').click(); await tick();
  expect(props.connect).toHaveBeenCalledExactlyOnceWith('bitsov://pair/synthetic');
  expect(input!.value).toBe('');
  expect(document.querySelector('input')).toBeNull();
});
it('clears an unfinished manual paste when onboarding unmounts', async () => {
  vi.stubGlobal('navigator', {});
  mount({ platform: 'android' });
  button('Paste link').click(); await tick();
  const input = document.querySelector<HTMLInputElement>('input')!;
  input.value = 'bitsov://pair/private-unsubmitted';
  dispose!(); dispose = undefined;
  expect(input.value).toBe('');
});
it.each(['android', 'ios'] as const)('%s clears an unfinished manual paste on reset and scanner handoff', async platform => {
  vi.stubGlobal('navigator', {});
  const props = mount({ platform, scan: () => new Promise(() => {}) });
  for (const action of ['Forget this box', "Scan your box’s QR"]) {
    button('Paste link').click(); await tick();
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = 'bitsov://pair/private-unsubmitted';
    button(action).click(); await tick();
    expect(input.value).toBe('');
    expect(document.querySelector('input')).toBeNull();
    expect(props.preview).not.toHaveBeenCalled();
    expect(props.connect).not.toHaveBeenCalled();
  }
});
it('uses the Android permission name on the local-network recovery screen', async () => {
  mount({ platform: 'android', status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind: 'local_network', detail: '' } }) });
  await tick();
  expect(document.querySelector('.phone-line')?.textContent).toContain('Nearby devices');
  expect(document.querySelector('.phone-line')?.textContent).not.toContain('Local Network');
});
it('refuses a legacy enrollment instead of repeatedly attempting code-free join', async () => {
  const props = mount({
    status: () => ({ ready: true, node_id: 'box', error: null }),
    pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    join: vi.fn().mockResolvedValue({ state: 'idle', second_device: false }),
  });
  await tick();
  expect(props.beginJoin).not.toHaveBeenCalled();
  expect(button('Scan the new QR')).toBeTruthy();
});
it('offers a new QR after a process restart lost the in-memory comparison', async () => {
  const join = vi.fn().mockRejectedValueOnce({ code: 'enrollment_restart', message: 'sanitized host error' }).mockResolvedValue({ state: 'idle', second_device: true });
  const props = mount({
    status: () => ({ ready: true, node_id: 'box', error: null }),
    pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'pending', fingerprint: null, owner_action: null, expires_at_ms: null }), join,
  });
  await tick();
  expect(button('Scan the new QR')).toBeTruthy();
  button('Scan the new QR').click(); await tick();
  expect(join).toHaveBeenCalledWith({ action: 'cancel' });
  expect(props.scan).toHaveBeenCalledOnce();
});

it.each(['incoming', 'scan', 'paste'] as const)('compares a legacy %s preview before committing it', async route => {
  vi.stubGlobal('navigator', { clipboard: { readText: async () => 'bitsov://pair/synthetic' } });
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ status, pairing,
    incoming: route === 'incoming' ? { link: 'bitsov://pair/synthetic' } : undefined,
    preview: vi.fn().mockResolvedValue({ second_device: false, endpoint: 'box', node_id_fingerprint: 'ABCD' }),
    device: () => ({ available: false, delegation_supported: false, state: 'unavailable', fingerprint: null, owner_action: null, expires_at_ms: null }),
  });
  if (route !== 'incoming') button(route === 'scan' ? "Scan your box’s QR" : 'Paste link').click();
  await tick();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(0);
  expect(document.querySelector('.phone-fingerprint')?.textContent).toBe('ABCD');
  button('They match').click(); button('They match')?.click(); await tick();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(1);
  expect(button('Open BitSov')).toBeUndefined();
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' });
  setStatus({ ready: true, node_id: 'box', error: null }); await tick();
  expect(button('Open BitSov')).toBeTruthy();
  expect(props.beginJoin).not.toHaveBeenCalled();
});
it('cancels a legacy preview without committing and discards its pending link', async () => {
  const props = mount({
    preview: vi.fn().mockResolvedValue({ endpoint: 'box', node_id_fingerprint: 'ABCD' }),
  });
  button("Scan your box’s QR").click(); await tick();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(0);
  button('Cancel').click(); await tick();
  expect(button("Scan your box’s QR")).toBeTruthy();
  expect(document.querySelector('.phone-fingerprint')).toBeNull();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(0);
  expect(props.join).not.toHaveBeenCalled();
});
it.each(['en', 'da'])('rejects a legacy comparison through a visible quiet button (%s)', async locale => {
  const props = mount({ locale,
    preview: vi.fn().mockResolvedValue({ second_device: false, endpoint: 'box', node_id_fingerprint: 'ABCD' }),
  });
  const scanLabel = locale === 'da' ? 'Scan boksens QR-kode' : "Scan your box’s QR";
  button(scanLabel).click(); await tick();
  const confirm = button(locale === 'da' ? 'De er ens' : 'They match');
  const mismatch = button(locale === 'da' ? 'De er ikke ens' : "They don't match");
  expect(mismatch).toBeTruthy();
  expect(mismatch.closest('details')).toBeNull();
  expect(mismatch.classList.contains('quiet')).toBe(true);
  expect(mismatch.disabled).toBe(false);
  expect(document.querySelector('details')?.open).toBe(false);
  expect(document.querySelectorAll('button.primary')).toHaveLength(1);
  mismatch.click(); await tick();
  expect(props.forget).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('start');
  expect(document.querySelector('.phone-fingerprint')).toBeNull();
  expect(document.body.textContent).not.toContain('ABCD');
  confirm.click(); await tick(); // A stale confirmation cannot commit the rejected link.
  expect(props.connect).not.toHaveBeenCalled(); // connect is the import boundary.
  expect(props.beginJoin).not.toHaveBeenCalled();
  expect(props.join).not.toHaveBeenCalled();
  expect(props.onDone).not.toHaveBeenCalled();

  vi.mocked(props.scan!).mockResolvedValueOnce('bitsov://pair/replacement');
  button(scanLabel).click(); await tick();
  expect(props.connect).not.toHaveBeenCalled();
  button(locale === 'da' ? 'De er ens' : 'They match').click(); await tick();
  expect(props.connect).toHaveBeenCalledExactlyOnceWith('bitsov://pair/replacement');
});
it('shows connecting progress without a dummy primary action', async () => {
  mount({ incoming: { link: 'bitsov://pair/synthetic' }, connect: () => new Promise(() => {}) });
  await tick();
  expect(document.querySelectorAll('button.primary')).toHaveLength(0);
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Please wait…');
});

it('focuses each changed error once, including recovery-only changes, without a live duplicate', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  mount({ status });
  await tick();
  const heading = document.querySelector('h1')!;
  const announcements: string[] = [];
  heading.addEventListener('focus', () => announcements.push(`${heading.textContent} ${document.getElementById(heading.getAttribute('aria-describedby')!)?.textContent}`));
  const change = async (kind: ConnectionError['kind'], detail = '') => {
    setStatus({ ready: false, node_id: null, error: null, connection_error: { kind, detail } });
    await tick();
  };
  const options = document.querySelector('summary')!;
  options.focus();
  await change('unreachable');
  expect(document.activeElement).toBe(heading);
  expect(announcements).toHaveLength(1);
  expect(announcements[0]).toContain("Can't reach your box");
  options.focus();
  await change('expired');
  expect(document.activeElement).toBe(heading);
  expect(announcements).toHaveLength(2);
  expect(announcements[1]).toContain('This QR has expired');
  // Same heading, different recovery instruction; refocus even if already on it.
  await change('clock');
  expect(document.activeElement).toBe(heading);
  expect(announcements).toHaveLength(3);
  expect(announcements[2]).not.toBe(announcements[1]);
  options.focus();
  await change('clock');
  expect(announcements).toHaveLength(3);
  expect(document.activeElement).toBe(options);
  await change('clock', 'Updated diagnostic');
  expect(document.activeElement).toBe(heading);
  expect(announcements).toHaveLength(4);
  expect(document.querySelector('[data-phone-face] [role="alert"], [data-phone-face] [role="status"], [data-phone-face][aria-live], [data-phone-face] [aria-live]')).toBeNull();
});
it('announces an error present at mount only once', async () => {
  const focused = vi.fn((event: FocusEvent) => { if ((event.target as Element).tagName === 'H1') announcements++; });
  let announcements = 0;
  document.addEventListener('focusin', focused);
  try {
    mount({ status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind: 'expired', detail: '' } }) });
    await tick();
    expect(announcements).toBe(1);
  } finally { document.removeEventListener('focusin', focused); }
});
it('moves focus from a disappearing action to the new step and its current description', async () => {
  mount({ preview: async () => ({ second_device: false, endpoint: 'box', node_id_fingerprint: 'ABCD' }) });
  await tick();
  const scan = button("Scan your box’s QR");
  scan.focus(); scan.click(); await tick();
  expect(scan.isConnected).toBe(false);
  const heading = document.querySelector('h1')!;
  expect(document.activeElement).toBe(heading);
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('fingerprint');
  expect(heading.tabIndex).toBe(-1);
  expect(document.getElementById(heading.getAttribute('aria-describedby')!)?.textContent).toBe(document.querySelector('.phone-line')?.textContent);
  expect(document.querySelector('.phone-line')?.textContent).not.toBe('Other device → Add a device.');
});
it.each(['en', 'da'])('focuses the PhoneTrust heading with its deposit disclosure in %s', async locale => {
  dispose = render(() => <PhoneTrust locale={locale} onContinue={async () => {}} />, document.body);
  await tick();
  const heading = document.querySelector('h1')!;
  expect(document.activeElement).toBe(heading);
  expect(heading.tabIndex).toBe(-1);
  expect(document.getElementById(heading.getAttribute('aria-describedby')!)?.textContent).toBe(locale === 'en' ? 'The host can spend your deposits.' : 'Værten kan bruge dine indskud.');
  expect(heading.closest('[aria-live], [role="alert"], [role="status"]')).toBeNull();
});
