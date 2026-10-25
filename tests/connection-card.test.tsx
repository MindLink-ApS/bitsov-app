import { createSignal, Show } from 'solid-js';
import { PairingActivityProvider, usePairingBlocked } from '../src/pairingActivity';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionCard, connectionSummary, nextLastCall, type NodeAnswer } from '../src/control/ConnectionCard';
import { IDLE } from '../src/control/call';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const at = new Date(2026, 9, 14, 12, 4, 31).getTime();
const answer: NodeAnswer = { at, ms: 85 };
const base = { remote: true, link: 'open' as const, live: true, answer, stun: 'node' as const, lastCall: { connected: true, route: { local: 'srflx', remote: 'host' } } };

describe('the connection card', () => {
  it('says how this device reaches its node, when the node last answered, and what calls use', () => {
    expect(connectionSummary(base)).toEqual([
      'How this device reaches your node: over the network (a node you run elsewhere)',
      'Live updates: Live',
      // The app asking its own host (usually its cached view of the node): never claimed as a node round trip.
      `Last status check: ${new Date(at).toLocaleTimeString()} · 85 ms (this app ↔ its host)`,
      'Calls · STUN: your own node',
      'Calls · relay (TURN): none yet',
      'Last call: srflx (this device) / host (theirs)',
    ]);
    expect(connectionSummary(base).join('\n')).not.toMatch(/from your node:|round trip/i);
    const local = connectionSummary({ ...base, remote: false, link: 'closed', stun: 'off', lastCall: null });
    expect(local[0]).toBe('How this device reaches your node: on this Mac');
    expect(local[1]).toBe('Live updates: Reconnecting');
    expect(local[3]).toBe('Calls · STUN: off (direct connections only)');
    expect(local[5]).toBe('Last call: no call yet');
    expect(connectionSummary({ ...base, lastCall: { connected: false, route: null } })[5]).toBe('Last call: no route (it didn’t connect)');
    // It went live, but no stats were read: never said as "didn't connect".
    expect(connectionSummary({ ...base, lastCall: { connected: true, route: null } })[5]).toBe('Last call: connected, route unavailable');
    expect(connectionSummary({ ...base, stun: 'checking' })[3]).toBe('Calls · STUN: checking…');
    expect(connectionSummary({ ...base, stun: 'custom' })[3]).toBe('Calls · STUN: a server you chose');
    expect(connectionSummary({ ...base, stun: 'none' })[3]).toBe('Calls · STUN: none (your node does not offer one)');
  });

  it('offline, it says since when the node has not answered', () => {
    expect(connectionSummary({ ...base, live: false })[2]).toBe(`Last status check: your node not answering since ${new Date(at).toLocaleTimeString()}`);
    expect(connectionSummary({ ...base, live: false, answer: null })[2]).toBe('Last status check: no answer yet');
    // Locked is not offline.
    expect(connectionSummary({ ...base, live: false, locked: true })[2]).toBe('Last status check: your node is locked');
    expect(connectionSummary({ ...base, link: null })[1]).toBe('Live updates: Waiting');
  });

  it('Check now runs one read at a time: disabled while it is out, then ready again', async () => {
    let finish!: () => void;
    const onCheck = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    dispose = render(() => <ConnectionCard {...base} onCheck={onCheck} />, document.body);
    const button = () => document.querySelector<HTMLButtonElement>('[data-connection-check]')!;
    button().click();
    button().click();
    await flush();
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Checking…');
    finish();
    await flush();
    expect(button().disabled).toBe(false);
    button().click();
    await flush();
    expect(onCheck).toHaveBeenCalledTimes(2);
  });

  it('a check held outside the card keeps the button disabled after the card is remounted', async () => {
    const onCheck = vi.fn(async () => {});
    dispose = render(() => <ConnectionCard {...base} onCheck={onCheck} checking />, document.body);
    const button = document.querySelector<HTMLButtonElement>('[data-connection-check]')!;
    expect(button.disabled).toBe(true);
    button.click();
    await flush();
    expect(onCheck).not.toHaveBeenCalled();
  });

  it('Copy details copies the same facts as text, and says whether it worked', async () => {
    const copy = vi.fn(async (_text: string) => {});
    dispose = render(() => <ConnectionCard {...base} copy={copy} />, document.body);
    document.querySelector<HTMLButtonElement>('[data-connection-copy]')!.click();
    await flush();
    expect(copy).toHaveBeenCalledWith(['BitSov connection', ...connectionSummary(base)].join('\n'));
    expect(document.querySelector('[data-connection-copied]')!.textContent).toBe('Copied.');
  });

  it('a local refusal is tracked with no id, so a peer-chosen call_id can never claim it', () => {
    const peer = 'a'.repeat(64);
    const refused = nextLastCall(null, { ...IDLE, phase: 'ended', peer, error: 'Their node does not take calls yet. Nothing was paid.' });
    expect(refused).toEqual({ id: null, connected: false, route: null });
    // A peer's incoming call, whatever call_id it picks, does not touch it while it only rings.
    for (const callId of ['refused-1', 'local-1', 'null', '']) {
      const ringing = { ...IDLE, phase: 'incoming' as const, peer, callId, outgoing: false };
      expect(nextLastCall(refused, ringing)).toBe(refused);
    }
    // The next call placed here is the latest call.
    const placed = nextLastCall(refused, { ...IDLE, phase: 'calling', peer, callId: 'f'.repeat(32), outgoing: true });
    expect(placed).toEqual({ id: 'f'.repeat(32), connected: false, route: null });
  });
});

it.each(['resolve', 'reject', 'unmount'] as const)('blocks interruptions during a local connection check and releases on %s', async end => {
  let resolve!: () => void, reject!: () => void;
  const onCheck = () => new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('offline')); });
  const [visible, setVisible] = createSignal(true);
  let blocked!: () => boolean;
  const Observe = () => { blocked = usePairingBlocked(); return null; };
  dispose = render(() => <PairingActivityProvider><Observe /><Show when={visible()}><ConnectionCard {...base} onCheck={onCheck} checking={false} /></Show></PairingActivityProvider>, document.body);
  expect(blocked()).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-connection-check]')!.click();
  expect(blocked()).toBe(true);
  if (end === 'unmount') setVisible(false);
  else if (end === 'reject') reject();
  else resolve();
  await flush();
  expect(blocked()).toBe(false);
  if (end === 'unmount') { resolve(); await flush(); expect(blocked()).toBe(false); }
});
it('registers an externally held connection check as busy', () => {
  const [checking, setChecking] = createSignal(true);
  let blocked!: () => boolean;
  const Observe = () => { blocked = usePairingBlocked(); return null; };
  dispose = render(() => <PairingActivityProvider><Observe /><ConnectionCard {...base} checking={checking()} /></PairingActivityProvider>, document.body);
  expect(blocked()).toBe(true);
  setChecking(false);
  expect(blocked()).toBe(false);
});
