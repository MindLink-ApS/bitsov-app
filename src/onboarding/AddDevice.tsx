import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { qrSvg } from '../qr';
import { PairWords } from './PairWords';
import { PairSteps } from './PairSteps';
import { usePairingActivity } from '../pairingActivity';

export type AddInput = {action:'status'|'mint'|'poll'|'cancel'} | {action:'approve'; op_id:string};
export type PendingDevice = {op_id:string; name:string; words:string[]; expires_at:number};
export type AddView = {state:'unsupported'} | {state:'ready'; owner:boolean} | {state:'ticket'; uri:string; expires_at:number; pending:PendingDevice[]} | {state:'done'};
export type JoinInput = {action:'status'|'poll'|'cancel'} | {action:'start'; claim_code:string};
export type JoinView = {state:'idle'|'done'} | {state:'waiting'; words:string[]; expires_at:number};
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Could not reach your node. Check the connection and try again.';
}

/**
 * `local`: this app runs its node on this device (not connected to a remote
 * node). The host never offers Add a device then, and that is said as it is:
 * a node only this Mac can use, not a missing update.
 */
export function AddDevice(props: { api:(input:AddInput)=>Promise<AddView>; mobile?:boolean; local?:boolean }) {
  const [view, setView] = createSignal<AddView>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [now, setNow] = createSignal(Date.now()/1000);
  let alive = true;
  const ticket = () => { const v = view(); return v?.state === 'ticket' ? v : undefined; };
  const qr = createMemo(() => {
    const v = ticket();
    if (!v || !v.uri || v.expires_at <= now() || v.pending.length) return null;
    try { return qrSvg(v.uri); } catch { return null; }
  });
  usePairingActivity(() => busy() || !!ticket());
  const run = async (input: AddInput) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { const next = await props.api(input); if (alive) setView(next); }
    catch (e) { if (alive) setError(errorText(e)); }
    finally { if (alive) setBusy(false); }
  };
  onMount(() => {
    void run({action:'status'});
    const timer = setInterval(() => {
      setNow(Date.now()/1000);
      if (ticket() && !error()) void run({action:'poll'});
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => { alive = false; });
  return <section class="panel add-device" data-add-device>
    <h2>Devices</h2>
    <Switch>
      <Match when={view()?.state === 'unsupported'}>
        <Show when={props.local} fallback={<p data-add-device-unsupported="node">Your node does not offer adding devices yet. A newer version of your node adds it.</p>}>
          <p data-add-device-unsupported="local">This Mac runs its own node, and only this Mac can use it. To use BitSov on your phone as well, run your node on a computer or server that stays on (or one someone runs for you), and connect this Mac and your phone to it.</p>
        </Show>
      </Match>
      <Match when={view()?.state === 'ready'}>
        <Show when={(view() as {owner:boolean}).owner} fallback={<p>Use an enrolled owner device to add another device. An ordinary pairing cannot approve it.</p>}>
          <p>Add another device to your home node. Keep this owner device available while you compare the words.</p>
          <button class="primary" disabled={busy()} onClick={() => void run({action:'mint'})}>{busy() ? 'Creating ticket…' : 'Add a device'}</button>
        </Show>
      </Match>
      <Match when={ticket()}><>
        {/* Owner side: the new device scans the ticket (step 1), then both compare the words (step 3). */}
        {/* An expired or used ticket with nobody comparing: no step is current (the panel below says why). */}
        <PairSteps current={ticket()!.pending.length > 0 ? 2 : ticket()!.uri && ticket()!.expires_at > now() ? 0 : null} />
        <Show when={ticket()!.pending.length === 0}>
          <Show when={ticket()!.uri && ticket()!.expires_at > now()} fallback={<p role="status">{ticket()!.expires_at <= now()
            ? 'This ticket expired. If it was already scanned, finish enrollment on the new device. Otherwise close this ticket and create a new one.'
            : 'This ticket was used. Check whether the new device was added or its request ended. Close this ticket before starting again.'}</p>}>
            <p data-ticket-where>On the new device, open BitSov and choose to connect to your node (on a computer: open “Advanced: use a node you already run at home”), then scan or paste this ticket. It works once and expires in five minutes.</p>
            <p class="hint" data-ticket-claim-warning>The new device then asks for your node’s 18-character claim code. Have it ready: it is shown at your node’s owner console with <code>konsensus claim-code --show</code>, and a BitSov box also has it on its sticker.</p>
            <Show when={qr()} fallback={<p class="hint">This ticket is too large for a QR code. Copy and paste the pairing ticket below on the new device.</p>}>{q => <svg class="qr" viewBox={`0 0 ${q().extent} ${q().extent}`} shape-rendering="crispEdges" role="img" aria-label="Add a device pairing ticket">
              <rect width={q().extent} height={q().extent} fill="#fff" /><path d={q().path} fill="#000" />
            </svg>}</Show>
            <label class="ticket-label">Pairing ticket<textarea readOnly value={ticket()!.uri} aria-label="Pairing ticket" spellcheck={false} /></label>
            <p role="status">Waiting for the new device…</p>
          </Show>
        </Show>
        <For each={ticket()!.pending}>{p => <div class="device-comparison">
          <h3>Compare with <bdi>{p.name || 'the new device'}</bdi></h3>
          <p>Place both devices next to each other. All four words must match in this order.</p>
          <PairWords words={p.words} />
          <div class="form-actions">
            <button class="primary" disabled={busy() || p.expires_at <= now() || !!error()} onClick={() => void run({action:'approve',op_id:p.op_id})}>Approve with {props.mobile ? 'biometrics' : 'Touch ID'}</button>
            <button class="quiet" disabled={busy()} onClick={() => void run({action:'cancel'})}>Words differ</button>
          </div>
          <p class="hint">If they differ, cancel on the new device too. Do not approve.</p>
        </div>}</For>
        <button class="quiet" disabled={busy()} onClick={() => void run({action:'cancel'})}>Close ticket</button>
      </></Match>
      <Match when={view()?.state === 'done'}><PairSteps current={3} /><p class="ok-note" role="status">Device added. Keep another owner device available. Enrollment does not transfer your node’s unlock password.</p></Match>
    </Switch>
    <Show when={error()}><p class="err-note" role="alert">{error()}</p><button disabled={busy()} onClick={() => void run({action:ticket() ? 'poll' : 'status'})}>Try again</button></Show>
  </section>;
}

export function JoinDevice(props:{api:(input:JoinInput)=>Promise<JoinView>; mobile?:boolean}) {
  const [view, setView] = createSignal<JoinView>({state:'idle'});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let claim!: HTMLInputElement;
  let alive = true;
  const waiting = () => { const v = view(); return v.state === 'waiting' ? v : undefined; };
  usePairingActivity(() => busy() || !!waiting());
  const run = async (input:JoinInput) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { const next = await props.api(input); if(alive) setView(next); }
    catch(e) { if(alive) setError(errorText(e)); }
    finally { if(input.action === 'start') input.claim_code = ''; if(alive) setBusy(false); }
  };
  onMount(() => {
    void run({action:'status'});
    const timer = setInterval(() => { if(waiting() && !error()) void run({action:'poll'}); }, 2000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => { alive = false; if(claim) claim.value = ''; });
  return <section class="panel add-device" data-join-device>
    <h2>Add this device</h2>
    <Switch>
      <Match when={view().state === 'idle'}>
        {/* New device: the ticket was scanned or pasted to get here; next the claim code. */}
        <PairSteps current={1} />
        <p>After scanning or pasting the ticket, enter your node’s 18-character claim code: it is shown at your node’s owner console with <code>konsensus claim-code --show</code>, and a BitSov box also has it on its sticker. Keep an enrolled owner device nearby. Keep a Mac or another non-phone owner device enrolled as well.</p>
        <form onSubmit={event => { event.preventDefault(); const value = claim.value; claim.value = ''; void run({action:'start',claim_code:value}); }}>
          <label>Claim code<input ref={claim} name="claim_code" type="password" autocomplete="off" spellcheck={false} required disabled={busy()} /></label>
          <button class="primary" disabled={busy()}>{busy() ? 'Preparing comparison…' : 'Show comparison words'}</button>
        </form>
      </Match>
      <Match when={waiting()}>{v => <>
        <PairSteps current={2} />
        <PairWords words={v().words} />
        <p role="status">Compare these words with your owner device, then approve there with {props.mobile ? 'biometrics or Touch ID' : 'Touch ID'}.</p>
        <button class="quiet" disabled={busy()} onClick={() => void run({action:'cancel'})}>Words differ · Cancel</button>
      </>}</Match>
      <Match when={view().state === 'done'}><PairSteps current={3} /><p class="ok-note" role="status">Device added. Your node’s unlock password was not transferred. Keep your other owner device.</p></Match>
    </Switch>
    <Show when={error()}><p class="err-note" role="alert">{error()}</p><button disabled={busy()} onClick={() => void run({action:'status'})}>Check again</button><Show when={!waiting()}><button disabled={busy()} onClick={() => void run({action:'cancel'})}>Cancel pending setup</button></Show></Show>
  </section>;
}
