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
it('starts with one primary action and Paste beside it, without a secret input', async () => {
  mount();
  await tick();
  const heading = document.querySelector('h1')!;
  expect(document.activeElement).toBe(heading);
  expect(heading.getAttribute('aria-describedby')).toBeTruthy();
  // Says where the QR comes from, in the computer's own words, instead of a cryptic arrow.
  expect(document.getElementById(heading.getAttribute('aria-describedby')!)?.textContent).toBe('On your computer: open BitSov → Settings → Devices → Add a device. A square code appears. Tap the button below and hold your phone up to it.');
  expect(document.querySelector('[data-phone-face]')?.getAttribute('aria-live')).toBeNull();
  expect(document.querySelectorAll('button.primary')).toHaveLength(1);
  expect(button("Scan the code with the camera")).toBeTruthy();
  expect(document.querySelector('details')?.open).toBe(false);
  expect(button('Paste link')).toBeTruthy();
  // Paste is a first-class second way in on the face, not hidden under Other options.
  expect(button('Paste link').closest('[data-phone-face]')).not.toBeNull();
  expect(button('Paste link').closest('details')).toBeNull();
  expect(button('Paste link').classList.contains('primary')).toBe(false);
  expect(document.querySelector('input, textarea')).toBeNull();
});
it('auto-connects a scan, displays ordered words and only the owner can approve', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ status, pairing, device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  button("Scan the code with the camera").click(); await tick();
  expect(props.connect).toHaveBeenCalledWith('bitsov://pair/synthetic');
  expect(document.body.textContent).not.toContain('bitsov://');
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' });
  setStatus({ ready: true, node_id: 'box', error: null }); await tick();
  expect([...document.querySelectorAll('[data-pair-word]')].map(e => e.textContent)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  expect(document.body.textContent).toContain('If they are, approve on your computer.');
  expect(button('They match')).toBeUndefined();
  expect(props.beginJoin).toHaveBeenCalledWith();
  button("They don't match").click(); await tick();
  expect(props.join).toHaveBeenCalledWith({ action: 'cancel' });
  expect(document.body.textContent).toContain('Stopped. Nothing was added.');
});
it('rejects an unclaimed preview before dialing', async () => {
  const props = mount({ preview: vi.fn().mockResolvedValue({ first_run: true, endpoint: 'box', node_id_fingerprint: '' }) });
  button("Scan the code with the camera").click(); await tick();
  expect(props.connect).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("This box isn't set up yet");
});
it('reads clipboard only on tap and never echoes an invalid value', async () => {
  const readText = vi.fn().mockResolvedValue('private clipboard contents');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const props = mount(); expect(readText).not.toHaveBeenCalled();
  button('Paste link').click(); await tick();
  // Text was there, it just isn't a link: say that, without echoing it.
  expect(document.body.textContent).toContain('What you copied is not a BitSov link.');
  expect(document.body.textContent).not.toContain('private clipboard contents');
  expect(props.connect).not.toHaveBeenCalled();
});
it.each([
  ['unclaimed', "This box isn't set up yet", 'I’ve set it up – scan again'],
  ['local_network', 'Allow BitSov on your local network', 'Open Settings'],
  ['unreachable', "Can't reach your box", 'Try again'],
  ['tailscale', "Can't reach your box", 'Open Tailscale'],
  ['expired', 'This link no longer works', 'Paste new link'],
  ['used', 'This link no longer works', 'Paste new link'],
  ['clock', 'This code has expired', 'Scan the new code'],
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
  mount({ scan: () => new Promise(() => {}) }); button("Scan the code with the camera").click(); await tick();
  const primary = document.querySelector<HTMLButtonElement>('button.primary')!;
  expect(primary.disabled).toBe(true);
  expect(document.getElementById(primary.getAttribute('aria-describedby')!)?.textContent).toBeTruthy();
});
it('ships Danish copy while preserving the protocol words', () => {
  mount({ locale: 'da-DK' });
  expect(document.querySelector('h1')?.textContent).toBe('Forbind til din boks');
  expect(button('Scan koden med kameraet')).toBeTruthy();
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
  await tick(); expect(document.querySelector('h1')?.textContent).toBe('Is the same code where you got the link?');
  expect(props.beginJoin).not.toHaveBeenCalled(); button('They match').click();
  expect(button('Open BitSov')).toBeTruthy();
});
it('shows camera denial as E4 with one settings action', async () => {
  mount({ scan: vi.fn().mockRejectedValue({ kind: 'camera' }) });
  button("Scan the code with the camera").click(); await tick();
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
it('an unclaimed box says what to do on the computer, then scans again; it never cancels a nonexistent enrollment', async () => {
  const preview = vi.fn().mockResolvedValueOnce({ first_run: true, endpoint: 'box', node_id_fingerprint: '' })
    .mockResolvedValue({ second_device: true, endpoint: 'box:443', node_id_fingerprint: 'ABCD' });
  const props = mount({ preview, join: vi.fn().mockRejectedValue('no remote connection') });
  button("Scan the code with the camera").click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe("This box isn't set up yet");
  expect(document.body.textContent).toContain('Open BitSov on your computer and set up your box there. Then come back and scan again.');
  expect(button('Start over')).toBeUndefined();
  button('I’ve set it up – scan again').click(); await tick();
  expect(props.scan).toHaveBeenCalledTimes(2);
  expect(props.join).not.toHaveBeenCalled();
  // The box is set up now: the second scan connects.
  expect(props.connect).toHaveBeenCalledWith('bitsov://pair/synthetic');
});
it('waits for native cancellation before enabling another scan', async () => {
  let finish!: () => void;
  const props = mount({ scan: () => new Promise(() => {}), cancelScan: () => new Promise(resolve => { finish = resolve; }) });
  button("Scan the code with the camera").click(); await tick(); button('Cancel').click(); await tick();
  expect(button("Scan the code with the camera").disabled).toBe(true);
  finish(); await tick(); expect(button("Scan the code with the camera").disabled).toBe(false);
  expect(props.connect).not.toHaveBeenCalled();
});
it('keeps Scan out of reach while the paste bubble is up, and says where to tap', async () => {
  let finish!: (text: string) => void;
  vi.stubGlobal('navigator', { clipboard: { readText: () => new Promise(resolve => { finish = resolve; }) } });
  const props = mount({ scan: vi.fn(() => new Promise<string>(() => {})) });
  button('Paste link').click(); await tick();
  expect(document.querySelector('[data-phone-paste-hint]')?.textContent).toBe('Tap the small bubble that appears to paste.');
  // A near miss on Scan (the bubble sits over it) does nothing.
  expect(button('Scan the code with the camera').disabled).toBe(true);
  button('Scan the code with the camera').click(); await tick();
  expect(props.scan).not.toHaveBeenCalled();
  finish(''); await tick();
  expect(document.querySelector('[data-phone-paste-hint]')).toBeNull();
  expect(button('Scan the code with the camera').disabled).toBe(false);
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
  button("Scan the code with the camera").click(); await tick(); const cancel = button('Cancel'); cancel.click(); cancel.click();
  expect(cancelScan).toHaveBeenCalledOnce(); finish(); await tick();
});
it('paste cannot replace enrollment after its polling connection fails', async () => {
  vi.useFakeTimers();
  const readText = vi.fn().mockResolvedValue('bitsov://pair/another');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const join = vi.fn().mockResolvedValueOnce({ state: 'waiting', words: ['one', 'two', 'three', 'four'], expires_at: Date.now()/1000+300 }).mockRejectedValue({ kind: 'unreachable' });
  const props = mount({ status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }), device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }), join });
  await tick(); await vi.advanceTimersByTimeAsync(1500);
  // Paste is offered only before a link is in use; during enrollment there is nothing to tap.
  expect(document.querySelector('[data-phone-paste]')).toBeNull();
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
  // The fallback field opens on the face, under Paste, not inside Other options.
  expect(input!.closest('[data-phone-face]')).not.toBeNull();
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
  // A box is known (so Forget is offered) but no saved pairing is resuming.
  const props = mount({ platform, scan: () => new Promise(() => {}), status: () => ({ ready: false, node_id: 'box', error: null }) });
  for (const action of ['Forget this box', "Scan the code with the camera"]) {
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
it('finishes an already-paired legacy phone instead of attempting a code-free join or a dead end', async () => {
  const props = mount({
    status: () => ({ ready: true, node_id: 'box', error: null }),
    pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    join: vi.fn().mockResolvedValue({ state: 'idle', second_device: false }),
  });
  await tick();
  expect(props.beginJoin).not.toHaveBeenCalled();
  // A saved pairing with nothing to enrol is done; "ask for a new QR" was a dead end that needed a relaunch.
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('done');
  expect(button('Scan the new code')).toBeUndefined();
});
it('still refuses a fresh second-device link the box cannot enrol', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({
    status, pairing,
    connect: vi.fn(async () => { setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' }); setStatus({ ready: true, node_id: 'box', error: null }); return { endpoint: 'box:443', node_id_fingerprint: 'ABCD', restart_required: false }; }),
    device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    join: vi.fn().mockResolvedValue({ state: 'idle', second_device: false }),
  });
  // A link scanned now that claims second-device enrolment, but the box says it is not: never "done" without enrolling.
  button('Scan the code with the camera').click(); await tick();
  await vi.waitFor(() => expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('error'));
  expect(props.beginJoin).not.toHaveBeenCalled();
});
it('offers Paste new link beside Try again when connecting timed out', async () => {
  vi.useFakeTimers();
  mount({ connect: vi.fn(() => new Promise<never>(() => {})) });
  button('Scan the code with the camera').click(); await tick();
  await vi.advanceTimersByTimeAsync(30_500);
  expect([...document.querySelectorAll('button.primary')].map(b => b.textContent)).toEqual(['Try again']);
  expect(document.querySelector('[data-phone-face] [data-phone-paste]')?.textContent).toBe('Paste new link');
});
it('offers a new QR after a process restart lost the in-memory comparison', async () => {
  const join = vi.fn().mockRejectedValueOnce({ code: 'enrollment_restart', message: 'sanitized host error' }).mockResolvedValue({ state: 'idle', second_device: true });
  const props = mount({
    status: () => ({ ready: true, node_id: 'box', error: null }),
    pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'pending', fingerprint: null, owner_action: null, expires_at_ms: null }), join,
  });
  await tick();
  expect(button('Scan the new code')).toBeTruthy();
  button('Scan the new code').click(); await tick();
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
  if (route !== 'incoming') button(route === 'scan' ? "Scan the code with the camera" : 'Paste link').click();
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
  button("Scan the code with the camera").click(); await tick();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(0);
  button('Cancel').click(); await tick();
  expect(button("Scan the code with the camera")).toBeTruthy();
  expect(document.querySelector('.phone-fingerprint')).toBeNull();
  expect(vi.mocked(props.connect).mock.calls.length).toBe(0);
  expect(props.join).not.toHaveBeenCalled();
});
it.each(['en', 'da'])('rejects a legacy comparison through a visible quiet button (%s)', async locale => {
  const props = mount({ locale,
    preview: vi.fn().mockResolvedValue({ second_device: false, endpoint: 'box', node_id_fingerprint: 'ABCD' }),
  });
  const scanLabel = locale === 'da' ? 'Scan koden med kameraet' : "Scan the code with the camera";
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
  // A progress indicator, not something that looks like a text field (and not the shell's status strip class).
  expect(document.querySelector('[role="status"] .phone-spinner')?.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('.phone-status')).toBeNull();
  expect(document.body.textContent).toContain('This usually takes less than half a minute.');
  expect(document.body.textContent).not.toContain('Keep your other device nearby');
});

it('labels the three steps and marks the current one', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  mount({ status, pairing, device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  const steps = () => [...document.querySelectorAll('.phone-progress li')].map(li => [li.textContent, li.getAttribute('aria-current')]);
  expect(document.querySelector('.phone-progress')?.getAttribute('aria-label')).toBe('Progress');
  expect(steps()).toEqual([['Scan', 'step'], ['Compare', null], ['Done', null]]);
  button("Scan the code with the camera").click(); await tick();
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' });
  setStatus({ ready: true, node_id: 'box', error: null }); await tick();
  expect(steps()).toEqual([['Scan', null], ['Compare', 'step'], ['Done', null]]);
});

it('Danish copy says where the QR comes from and what to do on an unclaimed box', async () => {
  mount({ locale: 'da-DK', preview: vi.fn().mockResolvedValue({ first_run: true, endpoint: 'box', node_id_fingerprint: '' }) });
  expect(document.body.textContent).toContain('På computeren: åbn BitSov → Indstillinger → Enheder → Tilføj en enhed.');
  expect([...document.querySelectorAll('.phone-progress-label')].map(e => e.textContent)).toEqual(['Scan', 'Sammenlign', 'Færdig']);
  button('Scan koden med kameraet').click(); await tick();
  expect(document.body.textContent).toContain('Åbn BitSov på din computer, og sæt boksen op dér.');
  expect(button('Jeg har sat den op – scan igen')).toBeTruthy();
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
  expect(announcements[1]).toContain('This link no longer works');
  // A different failure with its own instruction; refocus even if already on it.
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
  const scan = button("Scan the code with the camera");
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
it.each([
  ['en', 'Your keys stay in the node. This phone never shows your recovery phrase and keeps no copy of it.'],
  ['da', 'Dine nøgler bliver i noden. Denne telefon viser aldrig din gendannelsessætning og gemmer ingen kopi af den.'],
] as const)('PhoneTrust says only what this phone does with the recovery phrase in %s', async (locale, expected) => {
  dispose = render(() => <PhoneTrust locale={locale} onContinue={async () => {}} />, document.body);
  await tick();
  const options = document.querySelector('.phone-options')!;
  const lines = [...options.querySelectorAll('p')].map(p => p.textContent);
  expect(lines).toContain(expected);
  // The old promise covered all of BitSov, but the Mac shows a new phrase once during setup.
  expect(options.textContent).not.toMatch(/never shows you your recovery phrase|never copies it anywhere|kopierer den aldrig/);
});
it.each([
  ['en', 'Please wait…', 'Could not save. Try again.'],
  ['da', 'Vent et øjeblik…', 'Kunne ikke gemme. Prøv igen.'],
] as const)('PhoneTrust saves once while pending, says a failed save plainly, and retries with a new save in %s', async (locale, waiting, failure) => {
  const saves: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const onContinue = vi.fn(() => new Promise<void>((resolve, reject) => { saves.push({ resolve, reject }); }));
  dispose = render(() => <PhoneTrust locale={locale} onContinue={onContinue} />, document.body);
  await tick();
  const action = () => document.querySelector<HTMLButtonElement>('button.primary')!;
  const reason = () => {
    const id = action().getAttribute('aria-describedby');
    return id ? document.getElementById(id)?.textContent : undefined;
  };
  expect(action().disabled).toBe(false);
  expect(reason()).toBeUndefined();
  action().click(); await tick();
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(action().disabled).toBe(true);
  expect(reason()).toBe(waiting);
  // Repeated activation while the save is pending, including an event that
  // reaches the handler despite the disabled attribute, starts no second save.
  action().click();
  action().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  saves[0].reject(new Error('synthetic host refusal'));
  await tick();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(failure);
  expect(document.body.textContent).not.toContain('synthetic host refusal');
  expect(action().disabled).toBe(false);
  expect(reason()).toBeUndefined();
  action().click(); await tick();
  expect(onContinue).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(action().disabled).toBe(true);
  expect(reason()).toBe(waiting);
  saves[1].resolve(); await tick();
  expect(onContinue).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(action().disabled).toBe(false);
// A failed pairing or a stalled connection ends the wait with one plain action.
const connectingProps = (pairing: () => ReturnType<PhoneOnboardingProps['pairing']>) => ({
  pairing,
  device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) as const,
});
const headingText = () => document.querySelector('[data-phone-face] [tabindex="-1"]')?.textContent;
const primary = () => [...document.querySelectorAll<HTMLButtonElement>('button.primary')];
it.each([
  ['en', "Pairing didn't finish", "This phone and your box couldn't complete pairing.", 'Try again'],
  ['da', 'Parringen blev ikke færdig', 'Telefonen og boksen kunne ikke gøre parringen færdig.', 'Prøv igen'],
])('replaces Connecting with the pairing failure and one action (%s)', async (locale, heading, line, action) => {
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ locale, ...connectingProps(pairing) });
  button(locale === 'en' ? "Scan the code with the camera" : 'Scan koden med kameraet').click(); await tick();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'failed',
    reason: 'the node refused /pair/challenge (403): {"code":"remote_proxy_unauthorized"} bitsov://pair/secretticket' });
  await tick();
  expect(headingText()).toBe(heading);
  expect(document.querySelector('.phone-line')?.textContent).toBe(line);
  expect(document.querySelector('.phone-status')).toBeNull();
  expect(primary()).toHaveLength(1);
  expect(primary()[0].textContent).toBe(action);
  expect((primary()[0] as HTMLButtonElement).disabled).toBe(false);
  expect(document.body.textContent).not.toContain('secretticket');
  primary()[0].click(); await tick();
  expect(props.retry).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
});
it('names an unreachable box when the pairing failed in transport', async () => {
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  mount(connectingProps(pairing));
  button("Scan the code with the camera").click(); await tick();
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'failed', reason: 'remote transport failed: connection refused' });
  await tick();
  expect(headingText()).toBe("Can't reach your box");
  expect(primary().map(b => b.textContent)).toEqual(['Try again']);
});
it.each([
  ['en', 'This is taking too long', 'Your box isn’t answering. Check that it’s on.', 'Try again'],
  ['da', 'Det tager for lang tid', 'Din boks svarer ikke. Tjek, at den er tændt.', 'Prøv igen'],
])('stops waiting after 30 s without progress (%s)', async (locale, heading, line, action) => {
  vi.useFakeTimers();
  const props = mount({ locale, ...connectingProps(() => INITIAL_PAIRING), connect: vi.fn(() => new Promise<never>(() => {})) });
  button(locale === 'en' ? "Scan the code with the camera" : 'Scan koden med kameraet').click(); await tick();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  await vi.advanceTimersByTimeAsync(29_000);
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  await vi.advanceTimersByTimeAsync(1_500);
  expect(headingText()).toBe(heading);
  expect(document.querySelector('.phone-line')?.textContent).toBe(line);
  expect(primary().map(b => b.textContent)).toEqual([action]);
  // The stalled connect no longer holds the action disabled.
  expect((primary()[0] as HTMLButtonElement).disabled).toBe(false);
  primary()[0].click(); await tick();
  expect(props.retry).toHaveBeenCalledTimes(1);
});
it('does not let an earlier failure cut short a new attempt; the timeout still ends it', async () => {
  vi.useFakeTimers();
  // An earlier attempt's outcome, still reported when the new one starts.
  const failed = { ...INITIAL_PAIRING, state: 'failed' as const, reason: 'the node refused /pair/token (403): no' };
  mount(connectingProps(() => failed));
  await tick();
  button("Scan the code with the camera").click(); await tick();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  await vi.advanceTimersByTimeAsync(30_500);
  expect(headingText()).toBe('This is taking too long');
});
it('leaves a connection that progresses alone', async () => {
  vi.useFakeTimers();
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const waiting = { state: 'waiting' as const, words: ['alpha', 'beta', 'gamma', 'delta'], expires_at: Date.now()/1000 + 600 };
  const join = vi.fn().mockResolvedValueOnce({ state: 'idle', second_device: true }).mockResolvedValue(waiting);
  mount({ status, ...connectingProps(pairing), join, beginJoin: vi.fn().mockResolvedValue(waiting) });
  button("Scan the code with the camera").click(); await tick();
  await vi.advanceTimersByTimeAsync(10_000);
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'paired' });
  setStatus({ ready: true, node_id: 'box', error: null });
  await vi.advanceTimersByTimeAsync(1_500);
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('words');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('words');
});
// A stale ticket (expired, used, or a code the box no longer accepts) stops at once and offers a new link.
const USED_TICKET = 'remote node refused pairing: This ticket expired, was already used, or its owner was revoked. Ask an enrolled owner device for a new ticket.';
it.each([
  ['en', 'This link no longer works', 'Make a new code on your computer, then paste the new link here.', 'Paste new link'],
  ['da', 'Linket virker ikke længere', 'Lav en ny kode på computeren, og indsæt så det nye link her.', 'Indsæt nyt link'],
])('forgets a stale ticket the host reports at once and offers one paste action (%s)', async (locale, heading, line, action) => {
  const props = mount({ locale, status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind: 'used', detail: 'x' } }) });
  await tick();
  expect(document.querySelector('h1')?.textContent).toBe(heading);
  expect(document.querySelector('.phone-line')?.textContent).toBe(line);
  expect([...document.querySelectorAll('button.primary')].map(b => b.textContent)).toEqual([action]);
  // Nobody pressed anything: the dead link is already gone, so nothing can replay it.
  expect(props.forget).toHaveBeenCalledOnce();
  expect(props.retry).not.toHaveBeenCalled();
});
it('ends Connecting on the host’s code-mismatch refusal without offering Try again', async () => {
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ pairing, device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  button("Scan the code with the camera").click(); await tick();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'failed', reason: USED_TICKET });
  await tick();
  expect(document.querySelector('h1')?.textContent).toBe('This link no longer works');
  expect(button('Try again')).toBeUndefined();
  expect(props.forget).toHaveBeenCalledOnce();
  expect(props.retry).not.toHaveBeenCalled();
});
it('reads the clipboard in the tap and connects only after the stale link is forgotten', async () => {
  let forgotten!: () => void;
  const forget = vi.fn(() => new Promise<void>(resolve => { forgotten = resolve; }));
  const readText = vi.fn().mockResolvedValue('bitsov://pair/fresh');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const props = mount({ forget, status: () => ({ ready: false, node_id: null, error: null, connection_error: { kind: 'expired', detail: '' } }) });
  await tick();
  button('Paste new link').click();
  // Synchronously inside the tap, so iOS can show its paste prompt.
  expect(readText).toHaveBeenCalledOnce();
  await tick();
  expect(props.connect).not.toHaveBeenCalled();
  forgotten(); await tick();
  expect(props.connect).toHaveBeenCalledExactlyOnceWith('bitsov://pair/fresh');
  expect(forget).toHaveBeenCalledOnce();
});
it('shows the same message when the clipboard still holds the old link', async () => {
  vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('bitsov://pair/old') } });
  const props = mount({ preview: vi.fn().mockRejectedValue({ kind: 'used', detail: '' }) });
  await tick();
  button('Paste link').click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe('This link no longer works');
  expect(props.connect).not.toHaveBeenCalled();
  // Nothing was saved by this attempt, so nothing is forgotten on the phone's behalf.
  expect(props.forget).not.toHaveBeenCalled();
});
it('keeps Try again for a refusal that is not a stale ticket', async () => {
  const [pairing, setPairing] = createSignal(INITIAL_PAIRING);
  const props = mount({ pairing, device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }) });
  button("Scan the code with the camera").click(); await tick();
  setPairing({ ...INITIAL_PAIRING, remote: true, state: 'failed', reason: 'remote node refused pairing: authentication_failed: no' });
  await tick();
  expect(button('Try again')).toBeTruthy();
  expect(props.forget).not.toHaveBeenCalled();
});
it.each(['ios', 'android'] as const)('explains a Face ID prompt before Connecting opens the pairing key (%s)', async platform => {
  mount({ platform, connect: vi.fn(() => new Promise<never>(() => {})) });
  button("Scan the code with the camera").click(); await tick();
  expect(document.querySelector('[data-phone-onboarding]')?.getAttribute('data-phone-onboarding')).toBe('connecting');
  const why = document.querySelector('[data-faceid-why]');
  if (platform === 'ios') expect(why?.textContent).toBe('You may be asked for Face ID. It keeps the connection to your box safe.');
  else expect(why).toBeNull();
});
// Run 1 fixes: biometrics said plainly, a confirmed forget, and the compare screen names the computer.
it.each([
  ['ios', 'device_biometry', 'Face ID isn’t turned on', 'Turn on Face ID or a passcode in Settings, then come back here.', 'Open Settings'],
  ['android', 'device_unavailable', 'Fingerprint isn’t turned on', 'Turn on a fingerprint or a screen lock in Settings, then come back here.', 'Open Settings'],
  ['ios', 'device_cancelled', 'Face ID was cancelled', 'Nothing was added. Try again when you’re ready.', 'Try again'],
] as const)('%s says %s plainly instead of a connection error', async (platform, code, heading, line, action) => {
  const props = mount({ platform, status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    join: vi.fn().mockResolvedValue({ state: 'idle', second_device: true }),
    beginJoin: vi.fn().mockRejectedValue({ code, message: 'Approve at the node instead, with the konsensus grant command.' }) });
  await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe(heading));
  expect(document.querySelector('.phone-line')?.textContent).toBe(line);
  expect([...document.querySelectorAll('button.primary')].map(b => b.textContent)).toEqual([action]);
  expect(document.body.textContent).not.toMatch(/konsensus|node/);
  if (code === 'device_biometry') { button('Open Settings').click(); await tick(); expect(props.openSettings).toHaveBeenCalledOnce(); }
});
it('asks once before forgetting the box, and Keep it changes nothing', async () => {
  const props = mount({ pairing: () => ({ ...INITIAL_PAIRING, remote: true }) });
  await tick();
  button('Forget this box').click(); await tick();
  expect(document.querySelector('[data-phone-forget-confirm]')?.textContent).toContain('Forget this box? This phone stops using it.');
  expect(props.forget).not.toHaveBeenCalled();
  button('Keep it').click(); await tick();
  expect(document.querySelector('[data-phone-forget-confirm]')).toBeNull();
  expect(props.forget).not.toHaveBeenCalled();
  button('Forget this box').click(); await tick();
  button('Yes, forget it').click(); await tick();
  expect(props.forget).toHaveBeenCalledOnce();
});
it('keeps Forget this box outside the help sections', async () => {
  mount({ pairing: () => ({ ...INITIAL_PAIRING, remote: true }) }); await tick();
  const forget = button('Forget this box');
  expect(forget.parentElement?.matches('.phone-options')).toBe(true);
});
it('names the computer on the Danish compare screen', async () => {
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  mount({ locale: 'da', status: () => ({ ready: true, node_id: 'box', error: null }), pairing: () => ({ ...INITIAL_PAIRING, remote: true, state: 'paired' }),
    device: () => ({ available: true, delegation_supported: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null }),
    beginJoin: vi.fn().mockResolvedValue({ state: 'waiting', words, expires_at: Date.now()/1000 + 300 }) });
  await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Står de samme 4 ord på din computer?'));
  expect([...document.querySelectorAll('[data-pair-word]')].map(w => w.textContent)).toEqual(words);
});
it('opens the paste field when the paste prompt comes back empty, instead of a dead end', async () => {
  vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('') } });
  const props = mount({ locale: 'da' });
  button('Indsæt link').click(); await tick();
  expect(document.querySelector('input[aria-label="Parringslink"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Der er intet link at indsætte');
  expect(props.connect).not.toHaveBeenCalled();
});
it('hides a loopback address and says host diagnostics in Danish', async () => {
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  mount({ locale: 'da', status, preview: vi.fn().mockResolvedValue({ second_device: false, endpoint: '127.0.0.1:14740', node_id_fingerprint: 'abcd1234…ef567890' }) });
  await tick();
  // A real preview with a loopback address (the fallback code path), then the host's English diagnostic.
  button('Scan koden med kameraet').click(); await tick();
  expect(document.querySelector('.phone-fingerprint')?.textContent).toBe('abcd1234…ef567890');
  const details = [...document.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Tekniske oplysninger (til support)')!;
  expect(details).toBeTruthy();
  expect(document.body.textContent).not.toContain('127.0.0.1');
  setStatus({ ready: false, node_id: null, error: null, connection_error: { kind: 'unreachable', detail: 'The remote node could not be reached.' } }); await tick();
  expect(details.textContent).not.toContain('The remote node could not be reached.');
  expect(details.textContent).toContain('Tjek, at din boks er tændt.');
  expect(document.body.textContent).not.toContain('127.0.0.1');
});
// Run 3 (simulator) fixes.
it.each([
  ['en', 'invalid remote pairing link: ticket is not valid base64', 'This link doesn’t work', 'Paste new link'],
  ['da', 'invalid remote pairing link: ticket is not valid base64', 'Linket virker ikke', 'Indsæt nyt link'],
])('a malformed link says the link is broken, never "check the connection" (%s)', async (locale, hostText, heading, action) => {
  const props = mount({ locale, preview: vi.fn().mockRejectedValue(hostText) });
  button(locale === 'en' ? 'Scan the code with the camera' : 'Scan koden med kameraet').click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe(heading);
  expect([...document.querySelectorAll('button.primary')].map(b => b.textContent)).toEqual([action]);
  expect(button(locale === 'en' ? 'Try again' : 'Prøv igen')).toBeUndefined();
  // The plain host text reaches the support details (any link redacted).
  expect(document.querySelector('.phone-options')?.textContent).toContain('invalid remote pairing link');
  expect(props.forget).not.toHaveBeenCalled();
});
it('a refused camera still offers a way in: paste a link instead', async () => {
  const readText = vi.fn().mockResolvedValue('bitsov://pair/synthetic');
  vi.stubGlobal('navigator', { clipboard: { readText } });
  const props = mount({ scan: vi.fn().mockRejectedValue({ kind: 'camera' }) });
  button('Scan the code with the camera').click(); await tick();
  expect(document.querySelector('h1')?.textContent).toBe("BitSov can't use the camera");
  button('Paste a link instead').click(); await tick();
  expect(readText).toHaveBeenCalledOnce();
  expect(props.preview).toHaveBeenCalledWith('bitsov://pair/synthetic');
});
it('offers no Forget when there is no box to forget', async () => {
  mount(); await tick();
  expect(document.querySelector('[data-phone-forget]')).toBeNull();
});
it('makes keeping the box the strong choice and marks forgetting', async () => {
  mount({ pairing: () => ({ ...INITIAL_PAIRING, remote: true }) }); await tick();
  button('Forget this box').click(); await tick();
  const confirm = document.querySelector('[data-phone-forget-confirm]')!;
  const [first, second] = [...confirm.querySelectorAll('button')];
  expect([first.textContent, first.className]).toEqual(['Keep it', 'phone-primary-plain']);
  expect([second.textContent, second.className]).toEqual(['Yes, forget it', 'phone-danger']);
});
