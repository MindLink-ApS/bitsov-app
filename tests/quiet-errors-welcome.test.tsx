import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import App from '../src/App';
import { DelayedSpinner } from '../src/control/DelayedSpinner';
import { SoftError } from '../src/control/SoftError';
import { softenError } from '../src/control/userFacing';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
const start = (view: () => ReturnType<typeof App>) => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(view, mount);
};
const button = (label: string) => [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!;
afterEach(() => { dispose?.(); mount?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('quiet errors', () => {
  it.each([
    'Error: /introduction failed (409): internal_state_invalid',
    '{"code":"unexpected_response","status":502}',
    'unknown_failure: backend_state_bad',
    'Error: request failed\n    at invoke (bridge.ts:32:7)',
  ])('keeps diagnostics behind a closed native disclosure: %s', raw => {
    start(() => <SoftError message={raw} />);
    expect(mount.querySelector('[data-soft-summary]')!.textContent).not.toMatch(/409|502|internal_state|backend_state|bridge.ts|Error:|unexpected_response/);
    const detail = mount.querySelector<HTMLDetailsElement>('details')!;
    expect(detail).not.toBeNull();
    expect(detail.open).toBe(false);
    expect(detail.querySelector('summary')!.textContent).toBe('Details');
    expect(detail.textContent).toContain(raw);
  });

  it.each(['balance', 'budget', 'invoice'])('quiets a failed %s read without mistaking it for a money outcome', subject => {
    const raw = `Error: /payments/${subject} failed (503): connection refused`;
    start(() => <SoftError message={raw} onReconnect={() => {}} />);
    expect(mount.querySelector('[data-soft-summary]')!.textContent).not.toContain(raw);
    expect(mount.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(button('Reconnect')).toBeDefined();
  });

  it('never replaces a money warning with a generic summary or a reconnect action', () => {
    start(() => <SoftError message="spend_unknown: connection refused" summary="Your node is unavailable." onReconnect={() => {}} />);
    expect(mount.querySelector('[data-soft-summary]')!.textContent).toMatch(/spend.*unknown/i);
    expect(mount.querySelector('details')).toBeNull();
    expect(mount.querySelector('button')).toBeNull();
  });

  it.each(['budget_exhausted', 'budget_exhausted: connection refused', 'ceiling_exhausted', 'ceiling_exhausted: connection refused'])('keeps the full budget stop visible: %s', raw => {
    expect(softenError(raw)).toEqual({ summary: raw, detail: null, money: true });
    start(() => <SoftError message={raw} summary="Your node is unavailable." onReconnect={() => {}} />);
    expect(mount.querySelector('[data-soft-summary]')!.textContent).toBe(raw);
    expect(mount.querySelector('details')).toBeNull();
    expect(mount.querySelector('button')).toBeNull();
  });

  it.each([
    ['payment_refused: admission not settled', /payment.*refused/i],
    ['spend_unknown: connection refused', /spend.*unknown/i],
    ['payment_unknown: transport_error', /payment.*unknown/i],
    ['payment_settled_undelivered: advertised_addr missing', /paid|settled/i],
  ])('keeps the money outcome explicit ahead of other error mappings: %s', (raw, expected) => {
    expect(softenError(raw).summary).toMatch(expected);
  });

  it('offers one reconnect for pairing failure, with diagnostic detail collapsed', async () => {
    let recovered = false;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
      if (cmd === 'node_status') return { ready: false, node_id: null, error: null };
      if (cmd === 'pairing_retry') recovered = true;
      if (cmd === 'pairing_status' || cmd === 'pairing_retry') return { state: recovered ? 'paired' : 'failed', reason: 'Error: /pair/confirm (401): invalid_proof', scopes: [], short_code: null, code_from_node: false, remote: false, bootstrap: null };
      return null;
    } });
    start(() => <App />);
    await vi.waitFor(() => expect(mount.querySelector('[data-pairing="failed"]')).not.toBeNull());
    const box = mount.querySelector('[data-pairing="failed"]')!;
    expect(box.querySelectorAll('button')).toHaveLength(1);
    expect(box.querySelector('button')!.textContent).toBe('Reconnect');
    expect(box.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    button('Reconnect').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-pairing="paired"]')).not.toBeNull());
  });

  it('waits 600 ms before the startup spinner and cancels it when startup ends', async () => {
    vi.useFakeTimers();
    let failed = false;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
      if (cmd === 'node_status') return { ready: false, node_id: null, error: null };
      if (cmd === 'pairing_status') return { state: failed ? 'failed' : 'starting', reason: 'connection_refused', scopes: [], short_code: null, code_from_node: false, remote: false, bootstrap: null };
      return null;
    } });
    start(() => <App />);
    await vi.advanceTimersByTimeAsync(599);
    expect(mount.querySelector('.spinner')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(mount.querySelector('.spinner')).not.toBeNull();
    failed = true;
    await vi.advanceTimersByTimeAsync(900);
    expect(mount.querySelector('.spinner')).toBeNull();
  });
});

describe('read errors and loading lifecycle', () => {
  it('does not flash a spinner for a quick operation, and restarts the delay for the next one', async () => {
    vi.useFakeTimers();
    const [loading, setLoading] = createSignal(true);
    start(() => <Show when={loading()}><DelayedSpinner /></Show>);
    await vi.advanceTimersByTimeAsync(300);
    setLoading(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mount.querySelector('.spinner')).toBeNull();
    setLoading(true);
    await vi.advanceTimersByTimeAsync(599);
    expect(mount.querySelector('.spinner')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(mount.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe('Loading');
    setLoading(false);
    expect(mount.querySelector('.spinner')).toBeNull();
  });

  it('keeps wallet read diagnostics in Details and reconnects the read', async () => {
    const source = sampleSource();
    const wallet = source.wallet;
    let failing = true;
    source.wallet = () => failing ? Promise.reject('Error: /payments/overview (503): backend_unavailable') : wallet();
    start(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>('[data-profile]')!.click();
    mount.querySelector<HTMLButtonElement>('[data-open-wallet]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-soft-error="wallet-read"]')).not.toBeNull());
    const error = mount.querySelector('[data-soft-error="wallet-read"]')!;
    expect(error.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(error.querySelector('[data-soft-summary]')!.textContent).not.toContain('backend_unavailable');
    failing = false;
    error.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-balance-total]')).not.toBeNull());
    expect(mount.querySelector('[data-soft-error="wallet-read"]')).toBeNull();
  });

  it('collapses a failed history read and reconnects without sending anything', async () => {
    const source = sampleSource();
    const send = vi.spyOn(source, 'send');
    const messages = source.messages;
    let failing = true;
    source.messages = peer => failing ? Promise.reject('Error: connection refused /messages (503)') : messages(peer);
    start(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect(mount.querySelector('[data-stream] .soft-error')).not.toBeNull());
    const error = mount.querySelector('[data-stream] .soft-error')!;
    expect(error.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(error.querySelector('[data-soft-summary]')!.textContent).not.toContain('/messages');
    expect(error.querySelectorAll('button')).toHaveLength(1);
    failing = false;
    error.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-stream]')!.textContent).toContain('Morning.'));
    expect(mount.querySelector('[data-stream] .soft-error')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('welcome home', () => {
  const emptySource = (): Source => {
    const source = sampleSource();
    const overview = source.nodeOverview;
    return { ...source, peers: async () => [], rooms: async () => [], nodeOverview: async () => ({ ...await overview(), capabilities: ['front_door_v1'], money_ready: true }) };
  };
  const home = (source: Source) => start(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);

  it('shows three starting cards without identifiers, then opens each shipped destination', async () => {
    const source = emptySource();
    const send = vi.spyOn(source, 'send');
    const pay = vi.spyOn(source, 'pay');
    const invoice = vi.spyOn(source, 'invoiceCreate');
    home(source);
    await vi.waitFor(() => expect(mount.querySelector('[data-welcome]')).not.toBeNull());
    await vi.waitFor(() => expect(button('Share my card / QR').disabled).toBe(false));
    const welcome = mount.querySelector('[data-welcome]')!;
    expect(welcome.querySelectorAll('article')).toHaveLength(3);
    expect(welcome.textContent).not.toMatch(/[a-f0-9]{16}|host:port|node\.example|127\.0\.0\.1/);
    expect(welcome.textContent).toMatch(/camera.*not available/i);
    button('Share my card / QR').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-fd-edit-name]')).not.toBeNull());
    expect(mount.querySelector('[data-settings-open="true"]')).not.toBeNull();
    mount.querySelector<HTMLButtonElement>('[data-settings-close]')?.click();
    button('Add sats').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-wallet-receive]')).not.toBeNull());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    button('Paste a contact’s card').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-discover-paste]')).not.toBeNull());
    expect(send).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(invoice).not.toHaveBeenCalled();
  });

  it('opens invite forms and starter bitcoin from + New with zero peers', async () => {
    home(emptySource());
    await vi.waitFor(() => expect(mount.querySelector('[data-welcome]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-invite-create]')).not.toBeNull());
    expect(mount.querySelector('[data-invite-redeem]')).not.toBeNull();
    await vi.waitFor(() => expect(mount.querySelector('[data-starter-include]')).not.toBeNull());
    expect(mount.querySelector('[data-welcome]')).toBeNull();
  });

  it('disables unsupported actions with associated reasons and updates after recovery', async () => {
    const source = emptySource();
    const overview = await source.nodeOverview();
    const [active, setActive] = createSignal(true);
    source.nodeOverview = async () => ({ ...overview, capabilities: [], money_ready: false, lightning_available: false });
    start(() => <ControlCenter source={source} active={active()} ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    await vi.waitFor(() => expect(mount.querySelector('[data-welcome]')).not.toBeNull());
    await vi.waitFor(() => expect(button('Share my card / QR').disabled).toBe(true));
    for (const label of ['Share my card / QR', 'Add sats']) {
      const b = button(label);
      expect(b.disabled).toBe(true);
      expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent!.length).toBeGreaterThan(10);
    }
    expect(button('Paste a contact’s card').disabled).toBe(false);
    source.nodeOverview = async () => overview;
    setActive(false); setActive(true);
    await vi.waitFor(() => expect(button('Share my card / QR').disabled).toBe(false));
    expect(button('Add sats').disabled).toBe(false);
  });

  it('waits for the contact list before claiming an empty home', async () => {
    const source = emptySource();
    let resolve!: (peers: []) => void;
    source.peers = () => new Promise(done => { resolve = done; });
    home(source);
    expect(mount.querySelector('[data-welcome]')).toBeNull();
    resolve([]);
    await vi.waitFor(() => expect(mount.querySelector('[data-welcome]')).not.toBeNull());
  });

  it('opens an existing conversation after reconnecting a failed initial contact read', async () => {
    const source = sampleSource();
    const peers = source.peers;
    let failing = true;
    source.peers = () => failing ? Promise.reject('connection refused') : peers();
    home(source);
    await vi.waitFor(() => expect(button('Reconnect')).toBeDefined());
    expect(mount.querySelector('[data-welcome]')).toBeNull();
    failing = false;
    button('Reconnect').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    expect(mount.querySelector('[data-welcome]')).toBeNull();
  });

  it('keeps existing conversations as the initial track', async () => {
    home(sampleSource());
    await vi.waitFor(() => expect(mount.querySelector('[data-composer]')).not.toBeNull());
    expect(mount.querySelector('[data-welcome]')).toBeNull();
  });
});

describe('rail names', () => {
  it('+ New is named exactly "New" (the "+" is decoration)', () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    start(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    expect(mount.querySelector('[data-track="new"]')?.getAttribute('aria-label')).toBe('New');
  });
});

describe('onboarding polish', () => {
  it('Reconnect is a real button, and says it is working while it runs', async () => {
    let finish!: () => void;
    start(() => <SoftError message="connection refused" summary="We could not reach your node." onReconnect={() => new Promise<void>((r) => { finish = r; })} />);
    const reconnect = mount.querySelector<HTMLButtonElement>('[data-soft-reconnect]')!;
    expect(reconnect.classList.contains('quiet')).toBe(false);
    expect(reconnect.classList.contains('soft')).toBe(true);
    reconnect.click();
    await vi.waitFor(() => expect(reconnect.textContent).toBe('Reconnecting…'));
    expect(reconnect.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(reconnect.textContent).toBe('Reconnect'));
  });

  it('during setup the rail is marked, so its "after setup" placeholders stay hidden', () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    start(() => <ControlCenter source={source} active={false} ready={false} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />);
    expect(mount.querySelector('.rail')?.classList.contains('rail-setup')).toBe(true);
  });
});
