import { t as tr } from '../i18n';
import { Show } from 'solid-js';
import { amount, exactAmount, wholeSats, type Rounding } from './format';
import { denom } from './prefs';

/**
 * A whole-sat amount; when rounding changed it, the exact amount is one tap
 * (or Enter) away in a native disclosure, so it stays readable and reachable.
 */
export function AmountWithExact(props: { msat: number; round: Rounding; prefix?: string; nowrap?: boolean }) {
  const text = () => `${props.prefix ?? ''}${amount(props.msat, props.round, props.nowrap)}`;
  const rounded = () => denom() === 'sats' && Number.isSafeInteger(props.msat) && wholeSats(props.msat, props.round).rounded;
  return (
    <Show when={rounded()} fallback={text()}>
      <details class="exact-amount" data-exact-amount>
        <summary>{text()}</summary>
        <span data-exact-amount-value>{tr('amountExactly', exactAmount(props.msat))}</span>
      </details>
    </Show>
  );
}
