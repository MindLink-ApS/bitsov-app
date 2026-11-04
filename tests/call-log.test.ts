import { createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE, type CallView } from '../src/control/call';
import { callLogEntry, createCallLog } from '../src/control/callLog';

const peer = 'AB'.repeat(16);
const live = (over: Partial<CallView>): CallView => ({ ...IDLE, peer, callId: 'c1', outgoing: true, phase: 'ringing', ...over });
const ended = (over: Partial<CallView>): CallView => ({ ...live({}), phase: 'ended', ...over });

describe('what an ended call adds to the chat', () => {
  it.each([
    ['timeout', 'no_answer'], ['declined', 'declined'], ['busy', 'busy'], ['hangup', 'ended_early'], ['failed', 'failed'],
  ] as const)('an outgoing call that ends with %s logs %s', (reason, outcome) => {
    expect(callLogEntry(live({}), ended({ reason }), 1000)).toMatchObject({ outcome, direction: 'out', peer: peer.toLowerCase(), at: 1000 });
  });
  it('a call that connected logs how long it lasted, whatever ended it', () => {
    expect(callLogEntry(live({ phase: 'live', liveAt: 1000 }), ended({ reason: 'failed' }), 66_000)).toMatchObject({ outcome: 'connected', durationMs: 65_000 });
  });
  it('a refused call logs that it did not go through, before and after the call existed', () => {
    expect(callLogEntry(IDLE, { ...IDLE, phase: 'ended', peer, error: 'No.' }, 5)).toMatchObject({ outcome: 'not_through', direction: 'out', callId: null });
    expect(callLogEntry(live({ phase: 'calling' }), ended({ reason: null, error: 'No.' }), 5)).toMatchObject({ outcome: 'not_through' });
  });
  it('the same refusal on an open ended card adds nothing; a different one does', () => {
    const first: CallView = { ...IDLE, phase: 'ended', peer, error: 'No.' };
    expect(callLogEntry(first, { ...first }, 5)).toBeNull();
    expect(callLogEntry(first, { ...first, error: 'Other.' }, 5)).toMatchObject({ outcome: 'not_through' });
  });
  it('an incoming call logs only your own decline: a missed one has its own record', () => {
    const ringing = live({ outgoing: false, phase: 'incoming' });
    expect(callLogEntry(ringing, ended({ outgoing: false, reason: 'declined' }), 5)).toMatchObject({ outcome: 'you_declined', direction: 'in' });
    expect(callLogEntry(ringing, ended({ outgoing: false, reason: 'timeout' }), 5)).toBeNull();
  });
  it('a later update to an ended call adds nothing, and no entry names an amount', () => {
    const done = ended({ reason: 'timeout', paidMsat: 5000 });
    expect(callLogEntry(done, { ...done, pendingCount: 0 }, 5)).toBeNull();
    const entry = callLogEntry(live({ paidMsat: 5000 }), done, 5)!;
    expect(JSON.stringify(entry)).not.toMatch(/msat|sats|paid/i);
  });
});

describe('the local call log', () => {
  afterEach(() => localStorage.clear());
  const entry = { callId: 'c1', peer: 'ab', at: 1, media: 'audio', direction: 'out', outcome: 'no_answer' } as const;
  it('keeps one record per call, per node, across a restart, and drops damaged rows', async () => {
    await createRoot(async dispose => {
      const [owner] = createSignal('Node1');
      const log = createCallLog(owner);
      await Promise.resolve();
      log.add(entry); log.add(entry);
      expect(log.records()).toHaveLength(1);
      const stored = JSON.parse(localStorage.getItem('bitsov.call-log.node1')!);
      localStorage.setItem('bitsov.call-log.node1', JSON.stringify([...stored, { type: 'call-log', id: 'x', outcome: 'nonsense' }]));
      const again = createCallLog(owner);
      await Promise.resolve();
      expect(again.records().map(r => r.outcome)).toEqual(['no_answer']);
      dispose();
    });
  });
});
