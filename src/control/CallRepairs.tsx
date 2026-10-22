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
        setResult('Acknowledged. The host cannot yet verify this admission. Calls are still blocked; no payment or reservation was released.');
      } else if (row.hangup_cap_msat == null) {
        setResult('Call record repaired. Review the saved limit before ending the call.');
      } else {
        const outcome = await props.source.opEndCall(callId, row.hangup_cap_msat)
          .then(value => closeOutcome({ ok: true, value }), error => closeOutcome({ ok: false, error: asActionError(error) }));
        setResult(outcome.status === 'closed' ? 'The repaired call is ended. You can call again.' : outcome.message);
        if (outcome.status === 'closed') await props.source.opRepairCallIndex(index);
        props.onEnded();
      }
      await refresh();
    } catch (error) { setResult(`Couldn’t repair the call: ${asActionError(error).message}`); }
    finally { setBusy(null); }
  };
  return <Show when={rows().length || result()}>
    <section class="call-repairs" data-call-repairs aria-label="Unresolved calls">
      <Show when={rows().length}>
        <strong>Unresolved call record</strong>
        <p class="hint">A saved call record needs review before calls can continue. Repair and end uses at most the displayed saved call limit. Without a verified limit, Check repair only reviews the record. Without proof, it only acknowledges the entry and keeps calls blocked.</p>
        <For each={rows()}>{row => <div class="call-actions">
          <span class="hint">Record {row.index_id.slice(0, 12)}{row.acknowledged ? ' · acknowledged' : ''}</span>
          <button type="button" class="soft money" data-call-repair disabled={props.blocked || busy() !== null} onClick={() => void repair(row)}>
            {busy() === row.index_id ? 'Checking…' : row.hangup_cap_msat != null ? `Repair and end · up to ${fmtAmount(row.hangup_cap_msat)}` : row.acknowledged ? 'Check repair again' : 'Check repair / acknowledge'}
          </button>
        </div>}</For>
      </Show>
      <Show when={result()}><p class="hint" role="status" data-call-repair-result>{result()}</p></Show>
    </section>
  </Show>;
}
