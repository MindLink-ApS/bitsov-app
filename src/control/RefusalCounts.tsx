import { For, Show } from 'solid-js';
import { ago } from './format';
import { freshness } from './state';
import type { PrePaymentReason, PrePaymentRefusals, RefusalCount } from './types';

const REASON_WORDS: Record<PrePaymentReason, string> = {
  session_before_payment: 'Session setup',
  delivery_before_payment: 'Delivery replies',
  price_before_payment: 'Price requests and replies',
  peer_exchange_before_payment: 'Peer exchange',
  lightning_info_before_payment: 'Lightning information',
  gossip_before_payment: 'Gossip',
  invoice_error_before_payment: 'Invoice error replies',
  admission_required: 'Admission payment required',
};

// Group decimal text without ever rounding through a JavaScript number.
const countWords = (value: RefusalCount) =>
  `${value.at_least ? 'at least ' : ''}${value.count.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

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
      label: props.error && at !== null ? `could not re-read · last ${ago(at, props.now)}` : f.label,
      stale: f.stale || props.down || !!props.error,
    };
  };
  return (
    <section data-pre-payment-refusals>
      <p class="organ-line"><strong>Refused knocks before payment</strong></p>
      <Show when={props.counts} fallback={
        <p class="organ-line muted" data-refusals-unavailable>
          Unavailable — {props.error ? 'could not read your node’s pre-payment counts.' : 'your node has not reported pre-payment counts.'}
        </p>
      }>
        {(counts) => <>
          <p class="organ-note" classList={{ stale: fresh().stale }} data-refusals-fresh={fresh().stale ? 'stale' : 'fresh'}>{fresh().label}</p>
          <table class="refusal-counts" aria-label="Refused knocks before payment by reason">
            <thead><tr><th scope="col">Reason</th><th scope="col">Last 1 h</th><th scope="col">Last 24 h</th></tr></thead>
            <tbody><For each={counts().rows}>{(row) =>
              <tr data-refusal-reason={row.reason}>
                <th scope="row">{REASON_WORDS[row.reason]}</th>
                <td data-refusals-hour>{countWords(row.hour)}</td>
                <td data-refusals-day>{countWords(row.day)}</td>
              </tr>
            }</For></tbody>
          </table>
          <p class="organ-note">
            UTC hours: last 1 h is the current hour so far; last 24 h includes the preceding 23 hours.
            {' '}This reading’s hour starts {new Date(counts().hour_start_ms).toISOString().slice(0, 16).replace('T', ' ')} UTC.
          </p>
        </>}
      </Show>
      <p class="organ-src">
        From your node’s pre-payment counters. Counts refused control requests, not people or payments.
        {' '}Separate from message-gate refusals. Memory only; resets when the node restarts.
      </p>
    </section>
  );
}
