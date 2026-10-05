import type { Source } from './source';
import type { NodeOverview } from './types';
import { ago } from './format';

export const MONEY_NOT_READY = 'Money is not ready yet. Your node will retry automatically.';

/** Every app operation that can prepare or dispatch money. Reads and cancellation stay usable. */
const moneyMethods = new Set<keyof Source>([
  'retry', 'send', 'pay', 'keysend', 'fileSend', 'invoiceCreate', 'firstContactQuote', 'firstContactRequest',
  'sponsorOffer', 'sponsorCandidate', 'sponsorOwnerApproval', 'sponsorRequest',
  'inviteCreate', 'inviteRedeem', 'fundStart', 'fundingAddress',
  'callSignal', 'spendRequest', 'relationApprove', 'budgetApprove', 'budgetResume', 'budgetSet', 'porchRead',
]);

export function isMoneyNotReady(error: unknown): boolean {
  return error === MONEY_NOT_READY || (error !== null && typeof error === 'object' && 'code' in error && error.code === 'not_ready');
}

export function readinessSource(get: () => Source, blocked: () => boolean, refused: () => void): Source {
  return new Proxy({} as Source, {
    get(_target, key: keyof Source) {
      const value = get()[key];
      if (typeof value !== 'function') return value;
      if (!moneyMethods.has(key)) return value.bind(get());
      return async (...args: unknown[]) => {
        if (moneyMethods.has(key) && blocked()) throw { code: 'not_ready', message: MONEY_NOT_READY };
        try {
          return await Reflect.apply(get()[key] as Function, get(), args);
        } catch (e) {
          if (isMoneyNotReady(e)) {
            refused();
            throw { code: 'not_ready', message: MONEY_NOT_READY };
          }
          throw e;
        }
      };
    },
  });
}

export function readinessLine(node: NodeOverview | null, now: number): string | null {
  if (node?.money_ready == null) return null;
  const reading = `Read ${ago(node.read_at, now)}`;
  if (node.money_ready) return `Local OK · Money ready · ${reading}`;
  const state = node.readiness;
  const event = state?.events[state.events.length - 1];
  const retry = state?.retry_after_secs != null
    ? `Retrying · attempt ${state.retry_attempt} · retry delay ${state.retry_after_secs}s`
    : state?.state === 'retrying' ? `Retrying · attempt ${state.retry_attempt}`
    : state?.state === 'synchronizing' ? 'Synchronizing'
    : state?.state === 'failed' || state?.state === 'stopped' ? 'Retry stopped' : 'Waiting for readiness';
  return `Local OK · Money not ready yet · ${retry}${event ? ` · state changed ${ago(event.timestamp * 1000, now)}` : ''} · ${reading}`;
}
