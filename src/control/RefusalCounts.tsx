import { t as tr } from '../i18n';
import { For, Show } from 'solid-js';
import { ago } from './format';
import { freshness } from './state';
import type { PrePaymentReason, PrePaymentRefusals, RefusalCount } from './types';

const REASON_WORDS: Record<PrePaymentReason, string> = {
  get session_before_payment() { return tr('caSessionSetup'); },
  get delivery_before_payment() { return tr('caDeliveryReplies'); },
  get price_before_payment() { return tr('caPriceRequestsAndReplies'); },
  get peer_exchange_before_payment() { return tr('caPeerExchange'); },
  get lightning_info_before_payment() { return tr('caLightningInformation'); },
  get gossip_before_payment() { return tr('caGossip'); },
  get invoice_error_before_payment() { return tr('caInvoiceErrorReplies'); },
  get admission_required() { return tr('caAdmissionPaymentRequired'); },
};

// Group decimal text without ever rounding through a JavaScript number.
const countWords = (value: RefusalCount) =>
  `${value.at_least ? tr('caAtLeast') : ''}${value.count.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

export function RefusalCounts(props: {
  counts?: PrePaymentRefusals | null;
  readAt?: number | null;
  error?: string;
  now: number;
  down: boolean;
}) {
  const fresh = () => {
    const at = props.readAt ?? null;
    const f = freshness(at, props.now);
    return {
      label: props.error && at !== null ? tr('caCouldNotReReadLast', ago(at, props.now)) : f.label,
      stale: f.stale || props.down || !!props.error,
    };
  };
  return (
    <section data-pre-payment-refusals>
      <p class="organ-line"><strong>{tr('caRefusedKnocksBeforePayment')}</strong></p>
      <Show when={props.counts} fallback={
        <p class="organ-line muted" data-refusals-unavailable>
          {tr('caUnavailable')}{' '}{props.error ? tr('caCouldNotReadYourNodeSPrePaymentCounts') : tr('caYourNodeHasNotReportedPrePaymentCounts')}
        </p>
      }>
        {(counts) => <>
          <p class="organ-note" classList={{ stale: fresh().stale }} data-refusals-fresh={fresh().stale ? 'stale' : 'fresh'}>{fresh().label}</p>
          <table class="refusal-counts" aria-label={tr('caRefusedKnocksBeforePaymentByReason')}>
            <thead><tr><th scope="col">{tr('caReason')}</th><th scope="col">{tr('caLast1H')}</th><th scope="col">{tr('caLast24H')}</th></tr></thead>
            <tbody><For each={counts().rows}>{(row) =>
              <tr data-refusal-reason={row.reason}>
                <th scope="row">{REASON_WORDS[row.reason]}</th>
                <td data-refusals-hour>{row.hour === null ? tr('caUnavailable487') : countWords(row.hour)}</td>
                <td data-refusals-day>{countWords(row.day)}</td>
              </tr>
            }</For></tbody>
          </table>
          <p class="organ-note">
            {tr('caUTCHoursLast1HIsTheCurrentHour')}{' '}<Show when={counts().hour_start_ms !== null} fallback={
              <>{tr('caCurrentHourUnavailableYourNodeDoesNotReportIts')}</>
            }>
              {tr('caThisReadingSHourStarts')}{' '}{counts().hour_start_ms === null ? '' : new Date(counts().hour_start_ms!).toISOString().slice(0, 16).replace('T', ' ')}{' '}{tr('caUTC')}</Show>
          </p>
        </>}
      </Show>
      <p class="organ-src">
        {tr('caFromYourNodeSPrePaymentCountersCountsRefused')}{' '}{tr('caSeparateFromMessageGateRefusalsMemoryOnlyResetsWhen')}</p>
    </section>
  );
}
