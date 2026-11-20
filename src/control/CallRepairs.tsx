import { t as tr } from '../i18n';
import { createEffect, createSignal, For, Show } from 'solid-js';
import type { Source } from './source';
import type { UnresolvedCall } from './types';
import { closeOutcome } from './call';
import { amount as fmtAmount } from './format';
import { asActionError } from './state';

/** The host owns both repair evidence and closure; acknowledgement grants neither. */
export function CallRepairs(props: { source: Source; refreshKey: string | null; blocked: boolean; onEnded: () => void }) {
  const [rows, setRows] = createSignal<UnresolvedCall[]>([]);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<string | null>(null);
  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    try {
      const list = await props.source.opList();
      if (current === generation) setRows(list.unresolved_calls ?? []);
    } catch { /* A failed read never dismisses an unresolved entry. */ }
  };
  createEffect(() => { props.refreshKey; void refresh(); });
  const repair = async (row: UnresolvedCall) => {
    const index = row.index_id;
    if (busy() || props.blocked) return;
    setBusy(index);
    setResult(null);
    try {
      const callId = await props.source.opRepairCallIndex(index);
      if (callId === null) {
        setResult(tr('caAcknowledgedTheHostCannotYetVerifyThisAdmissionCalls'));
      } else if (row.hangup_cap_msat == null) {
        setResult(tr('caCallRecordRepairedReviewTheSavedLimitBeforeEnding'));
      } else {
        const outcome = await props.source.opEndCall(callId, row.hangup_cap_msat)
          .then(value => closeOutcome({ ok: true, value }), error => closeOutcome({ ok: false, error: asActionError(error) }));
        setResult(outcome.status === 'closed' ? tr('caTheRepairedCallIsEndedYouCanCallAgain') : outcome.message);
        if (outcome.status === 'closed') await props.source.opRepairCallIndex(index);
        props.onEnded();
      }
      await refresh();
    } catch (error) { setResult(tr('caCouldnTRepairTheCall', asActionError(error).message)); }
    finally { setBusy(null); }
  };
  return <Show when={rows().length || result()}>
    <section class="call-repairs" data-call-repairs aria-label={tr('caUnresolvedCalls')}>
      <Show when={rows().length}>
        <strong>{tr('caUnresolvedCallRecord')}</strong>
        <p class="hint">{tr('caASavedCallRecordNeedsReviewBeforeCallsCan')}</p>
        <For each={rows()}>{row => <div class="call-actions">
          <span class="hint">{tr('caRecord')}{' '}{row.index_id.slice(0, 12)}{row.acknowledged ? tr('caAcknowledged') : ''}</span>
          <button type="button" class="soft money" data-call-repair disabled={props.blocked || busy() !== null} onClick={() => void repair(row)}>
            {busy() === row.index_id ? tr('caChecking') : row.hangup_cap_msat != null ? tr('caRepairAndEndUpTo', fmtAmount(row.hangup_cap_msat, 'up')) : row.acknowledged ? tr('caCheckRepairAgain') : tr('caCheckRepairAcknowledge')}
          </button>
        </div>}</For>
      </Show>
      <Show when={result()}><p class="hint" role="status" data-call-repair-result>{result()}</p></Show>
    </section>
  </Show>;
}
