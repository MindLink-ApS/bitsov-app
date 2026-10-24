import { afterEach, expect, it, vi } from 'vitest';
import { deliveryPoller } from '../src/control/deliveryPoll';
import type { LiveEvent } from '../src/control/types';
afterEach(() => vi.useRealTimers());
it('bounds fallback reads and never invents delivery after timeout/errors', async () => {
  vi.useFakeTimers(); const read = vi.fn(async () => { throw new Error('offline'); }); const apply = vi.fn();
  const poll = deliveryPoller({ read, apply, connected: () => false, active: () => true });
  poll.watch('op', 'message'); await vi.advanceTimersByTimeAsync(120000);
  expect(read.mock.calls.length).toBeGreaterThan(0); expect(read.mock.calls.length).toBeLessThanOrEqual(12);
  const count = read.mock.calls.length; await vi.advanceTimersByTimeAsync(120000);
  expect(read).toHaveBeenCalledTimes(count); expect(apply).not.toHaveBeenCalled(); poll.stop();
});
it('checks once even with ws open to close the subscribe/receipt race, then waits for events', async () => {
  vi.useFakeTimers(); const read = vi.fn(async () => null); const apply = vi.fn();
  const poll = deliveryPoller({ read, apply, connected: () => true, active: () => true });
  poll.watch('op', 'message'); await vi.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled(); poll.stop();
});
it('ignores a late poll response after ws confirms delivery or the shell stops', async () => {
  vi.useFakeTimers(); let resolve!: (e: LiveEvent | null) => void; const apply = vi.fn();
  const poll = deliveryPoller({ read: () => new Promise(r => { resolve = r; }), apply, connected: () => false, active: () => true });
  poll.watch('op', 'message'); await vi.advanceTimersByTimeAsync(1000);
  poll.confirm('message'); resolve({ type: 'delivery', message_id: 'message', status: 'rejected', reason: 'late' });
  await vi.advanceTimersByTimeAsync(60000); expect(apply).not.toHaveBeenCalled();
  poll.watch('op-2', 'message-2'); await vi.advanceTimersByTimeAsync(1000); poll.stop();
  resolve({ type: 'delivery', message_id: 'message-2', status: 'delivered', reason: null });
  await vi.advanceTimersByTimeAsync(1000); expect(apply).not.toHaveBeenCalled();
});
it('rejects a mismatched message and accepts only terminal delivery events', async () => {
  vi.useFakeTimers(); const apply = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ type: 'delivery', message_id: 'other', status: 'delivered', reason: null })
    .mockResolvedValueOnce({ type: 'delivery', message_id: 'message', status: 'sent', reason: null })
    .mockResolvedValue({ type: 'delivery', message_id: 'message', status: 'delivered', reason: null });
  const poll = deliveryPoller({ read, apply, connected: () => false, active: () => true });
  poll.watch('op', 'message'); await vi.advanceTimersByTimeAsync(20000);
  expect(apply).toHaveBeenCalledTimes(1); expect(apply.mock.calls[0][0].status).toBe('delivered'); poll.stop();
});
it('catches up once after reconnect when the acknowledgement happened during the outage', async () => {
  vi.useFakeTimers(); let connected = false; const apply = vi.fn();
  const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ type: 'delivery', message_id: 'message', status: 'delivered', reason: null });
  const poll = deliveryPoller({ read, apply, connected: () => connected, active: () => true });
  poll.watch('op', 'message'); await vi.advanceTimersByTimeAsync(1000);
  expect(apply).not.toHaveBeenCalled();
  connected = true; poll.catchUp();
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2); poll.stop();
});
