import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionCard, connectionSummary, type NodeAnswer } from '../src/control/ConnectionCard';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const at = new Date(2026, 9, 14, 12, 4, 31).getTime();
const answer: NodeAnswer = { at, ms: 85 };
const base = { remote: true, link: 'open' as const, live: true, answer, stun: 'node' as const, lastCall: { local: 'srflx', remote: 'host' } };

describe('the connection card', () => {
  it('says how this device reaches its node, when the node last answered, and what calls use', () => {
    expect(connectionSummary(base)).toEqual([
      'How this device reaches your node: over the network (a node you run elsewhere)',
      'Live updates: Live',
      `Last answer from your node: ${new Date(at).toLocaleTimeString()} · 85 ms`,
      'Calls · STUN: your node',
      'Calls · relay (TURN): none yet',
      'Last call route: srflx (this device) / host (theirs)',
    ]);
    const local = connectionSummary({ ...base, remote: false, link: 'closed', stun: 'off', lastCall: null });
    expect(local[0]).toBe('How this device reaches your node: on this Mac');
    expect(local[1]).toBe('Live updates: Reconnecting');
    expect(local[3]).toBe('Calls · STUN: off (direct connections only)');
    expect(local[5]).toBe('Last call route: no call yet');
    expect(connectionSummary({ ...base, stun: 'custom' })[3]).toBe('Calls · STUN: a server you chose');
    expect(connectionSummary({ ...base, stun: 'none' })[3]).toBe('Calls · STUN: none (your node does not offer one)');
  });

  it('offline, it says since when the node has not answered', () => {
    expect(connectionSummary({ ...base, live: false })[2]).toBe(`Last answer from your node: not answering since ${new Date(at).toLocaleTimeString()}`);
    expect(connectionSummary({ ...base, live: false, answer: null })[2]).toBe('Last answer from your node: no answer yet');
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

  it('Copy details copies the same facts as text, and says whether it worked', async () => {
    const copy = vi.fn(async (_text: string) => {});
    dispose = render(() => <ConnectionCard {...base} copy={copy} />, document.body);
    document.querySelector<HTMLButtonElement>('[data-connection-copy]')!.click();
    await flush();
    expect(copy).toHaveBeenCalledWith(['BitSov connection', ...connectionSummary(base)].join('\n'));
    expect(document.querySelector('[data-connection-copied]')!.textContent).toBe('Copied.');
  });
});
