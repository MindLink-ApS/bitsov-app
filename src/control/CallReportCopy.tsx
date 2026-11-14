/**
 * M6 P3: "Copy call report" on the ended call card. Display only: it copies
 * the app's own record of the call (callReport.ts) and changes nothing.
 */
import { createEffect, createSignal, on, Show } from 'solid-js';
import { t as tr } from '../i18n';
import type { CallView } from './call';
import { callReport } from './callReport';

export function CallReportCopy(props: {
  view: CallView;
  routed: boolean;
  copy?: (text: string) => Promise<void>;
  now?: () => number;
}) {
  const now = () => (props.now ?? Date.now)();
  const [endedAt, setEndedAt] = createSignal<number | null>(null);
  const [copied, setCopied] = createSignal<'yes' | 'no' | null>(null);
  // When this card first showed the call as ended; a new call starts over.
  createEffect(on(() => props.view.callId, () => { setEndedAt(null); setCopied(null); }));
  createEffect(() => { if (props.view.phase === 'ended' && endedAt() === null) setEndedAt(now()); });
  const copy = async () => {
    const write = props.copy ?? ((text: string) => navigator.clipboard.writeText(text));
    try {
      await write(callReport({ view: props.view, routed: props.routed, endedAt: endedAt() }));
      setCopied('yes');
    } catch { setCopied('no'); }
  };
  return (
    <Show when={props.view.phase === 'ended' && props.view.callId !== null}>
      <div class="row" style={{ gap: 'var(--s-2)' }} data-call-report>
        <button type="button" class="link" data-call-report-copy onClick={() => void copy()}>{tr('uiCopyCallReport')}</button>
        <Show when={copied()}>{(c) => <span class="hint" role="status" data-call-report-copied>{c() === 'yes' ? tr('caCopied') : tr('caCouldNotCopy')}</span>}</Show>
      </div>
    </Show>
  );
}
