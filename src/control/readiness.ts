import { t } from '../i18n';
import type { Source } from './source';
import type { NodeOverview } from './types';
import { ago } from './format';

export const MONEY_NOT_READY = 'Money is not ready yet. Your node will retry automatically.';

/** Every app operation that can prepare or dispatch money. Reads and cancellation stay usable. */
const moneyMethods = new Set<keyof Source>([
  'retry', 'send', 'pay', 'keysend', 'fileSend', 'invoiceCreate', 'firstContactQuote', 'firstContactRequest',
  'sponsorOffer', 'sponsorCandidate', 'sponsorOwnerApproval', 'sponsorRequest',
  'inviteCreate', 'inviteRedeem', 'fundStart', 'fundingAddress',
  'callSignal', 'callBlock', 'callHold', 'spendRequest', 'relationApprove', 'budgetApprove', 'budgetResume', 'budgetSet', 'porchRead',
]);

export function isMoneyNotReady(error: unknown): boolean {
  return error === MONEY_NOT_READY || (error !== null && typeof error === 'object' && 'code' in error && error.code === 'not_ready');
}

export function isChainUnavailable(error: unknown): boolean {
  return error === 'not_ready:chain_unavailable' || (error !== null && typeof error === 'object' && 'code' in error && error.code === 'not_ready'
    && 'reason' in error && error.reason === 'chain_unavailable');
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
          if (isChainUnavailable(e)) throw e;
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
  const reading = t('extraRead', ago(node.read_at, now));
  if (node.money_ready) return t('extraLocalOKMoneyReady', reading);
  const state = node.readiness;
  const event = state?.events[state.events.length - 1];
  const retry = state?.retry_after_secs != null
    ? t('extraRetryingAttemptRetryDelayS', state.retry_attempt, state.retry_after_secs)
    : state?.state === 'retrying' ? t('extraRetryingAttempt', state.retry_attempt)
    : state?.state === 'synchronizing' ? t('extraSynchronizing')
    : state?.state === 'failed' || state?.state === 'stopped' ? t('extraRetryStopped') : t('extraWaitingForReadiness');
  return t('extraLocalOKMoneyNotReadyYet', retry, event ? t('extraStateChanged', ago(event.timestamp * 1000, now)) : '', reading);
}
