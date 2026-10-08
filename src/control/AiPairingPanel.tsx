import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';

export type AiPairingRequest = { action: 'status' | 'create' } | { action: 'request_grant'; payees: string[] };
export interface AiPairingView {
  state: 'none' | 'paired' | 'pending' | 'active' | 'paused' | 'unsafe' | 'revoked';
  client_id: string | null;
  grant: { budget_msat: number; remaining_msat: number; per_call_max_msat: number; expires_at_ms: number; payees: string[]; paused: boolean } | null;
  pending: { owner_action: string; expires_at_ms: number } | null;
  grant_revoke: string | null;
  pair_revoke: string | null;
  pair_window: string | null;
}
export function AiPairingPanel(props: { request: (request: AiPairingRequest) => Promise<AiPairingView> }) {
  const [view, setView] = createSignal<AiPairingView | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [payees, setPayees] = createSignal('');
  const [copied, setCopied] = createSignal('');
  let disposed = false;
  const parsed = () => payees().split(/[\s,]+/).filter(Boolean);
  const valid = () => parsed().length > 0 && parsed().length <= 256 && parsed().every(p => /^(?:[\da-f]{64}|[\da-f]{66})$/i.test(p));
  async function run(request: AiPairingRequest) {
    if (busy()) return;
    setBusy(true);
    try { const next = await props.request(request); if (!disposed) { setView(next); setError(''); } }
    catch (e) { if (!disposed) { setView(null); setError(String(e)); } }
    finally { if (!disposed) setBusy(false); }
  }
  onMount(() => { void run({action:'status'}); const timer = setInterval(() => void run({action:'status'}), 5000); onCleanup(() => { disposed = true; clearInterval(timer); }); });
  async function copy(command: string) {
    try { await navigator.clipboard.writeText(command); setCopied(command); }
    catch { setCopied(''); setError('Could not copy. Select and copy the command below.'); }
  }
  return <section class="panel" data-ai-pairing>
    <h3>AI pairing</h3>
    <p class="hint">A separate identity for assistants. Assistants cannot execute payments in this version.</p>
    <p>55 sats all-in per call · 1,000 sats per grant, up to 24 hours · payee allowlist required.</p>
    <p class="hint">Node breakers: 10 payments/minute, 60/hour, pause after 5 failures, 1,000 sats/10 minutes. Grants do not refill automatically.</p>
    <Show when={error()}><p role="alert">Status unavailable — {error()}</p></Show>
    <Show when={view()} fallback={<button type="button" disabled={busy()} onClick={() => void run({action:'status'})}>Check AI status</button>}>
      {v => <>
        <p data-ai-state={v().state}>AI: {{none:'Not paired', paired:'Paired · no live grant', pending:'Waiting for owner approval', active:'Grant approved · payments unavailable', paused:'Grant paused by node breakers', unsafe:'Grant outside AI policy · unavailable', revoked:'Pairing revoked'}[v().state]}</p>
        <Show when={v().client_id}><p>AI client id: <code>{v().client_id}</code></p></Show>
        <Show when={v().state === 'none' || v().state === 'revoked'}><p>First open a five-minute pairing window on your node’s owner console using the command below, then request the AI pairing.</p><button type="button" data-ai-create disabled={busy()} onClick={() => void run({action:'create'})}>Request AI pairing</button></Show>
        <Show when={v().grant}>{g => <p data-ai-grant>AI book: {g().remaining_msat / 1000} of {g().budget_msat / 1000} sats remaining · {g().per_call_max_msat / 1000} sats per call · ends {new Date(g().expires_at_ms).toLocaleString()}.<br />Payees: {g().payees.join(', ')}</p>}</Show>
        <Show when={v().state === 'paired'}>
          <label>Allowed AI payees (full node IDs or Lightning public keys)<textarea value={payees()} onInput={e => setPayees(e.currentTarget.value)} /></label>
          <button type="button" data-ai-grant-request disabled={busy() || !valid()} onClick={() => void run({action:'request_grant', payees:parsed()})}>Request AI grant</button>
        </Show>
        <Show when={v().pending}><p>Approve this AI client on your node’s owner console. Check the payees and limits before entering the console code.</p></Show>
        <For each={[
          {label:'Open AI pairing window', command:(v().state === 'none' || v().state === 'revoked') ? v().pair_window : null},
          {label:'Approve AI grant', command:v().pending?.owner_action},
          {label:'Revoke AI grant', command:v().grant_revoke},
          {label:'Revoke AI pairing', command:v().pair_revoke},
        ].filter(row => row.command)}>{row => <div><p>{row.label}</p><code style={{'overflow-wrap':'anywhere'}}>{row.command}</code> <button type="button" onClick={() => void copy(row.command!)}>{copied() === row.command ? 'Copied' : `Copy ${row.label.toLowerCase()} command`}</button></div>}</For>
        <Show when={v().client_id}><p class="hint">Run these commands on the node’s owner console. They name only the AI client id. Your main pairing and grant stay unchanged. Status refreshes every five seconds while this panel is open.</p></Show>
      </>}
    </Show>
  </section>;
}
