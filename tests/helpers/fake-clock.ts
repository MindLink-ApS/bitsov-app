import { vi } from 'vitest';

/** Poll real app state in virtual time, including async IPC/microtask work.
 * Vitest's vi.waitFor uses real wall-clock intervals even with fake timers.
 * Keep the same 50-ms interval and default 1-second deadline, but advance the
 * app clock explicitly. Throw the assertion on expiry; never skip a poll.
 */
export async function waitFor<T>(assertion: () => T, options: { timeout?: number } = {}): Promise<T> {
  // FileReader cases retain real time because Happy DOM owns that timer queue.
  if (!vi.isFakeTimers()) return vi.waitFor(assertion, options);
  const timeout = options.timeout ?? 1000;
  for (let elapsed = 0; ; elapsed += 50) {
    try {
      return assertion();
    } catch (error) {
      if (elapsed >= timeout) throw error;
    }
    await vi.advanceTimersByTimeAsync(Math.min(50, timeout - elapsed));
  }
}
