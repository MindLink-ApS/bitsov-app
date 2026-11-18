import { t as tr } from '../i18n';
import { Show } from 'solid-js';
import { amount } from './format';

export function SettledPayment(props: { direction: 'sent' | 'received'; msat: number | null }) {
  const known = () => props.msat !== null && Number.isSafeInteger(props.msat) && props.msat! >= 0;
  return <div class="wallet-settled" data-wallet-settled role="status">
    <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="24" cy="24" r="21" class="settled-ring" />
      <path d="m14 24 7 7 14-15" pathLength="1" class="settled-check" />
    </svg>
    <span>{props.direction === 'sent' ? tr('extraPaid') : tr('extraReceived')} <strong class="settled-amount" data-settled-msat={known() ? String(props.msat) : undefined}><Show when={known()} fallback={tr('caAmountUnknown')}>{amount(props.msat!)}</Show></strong></span>
  </div>;
}
