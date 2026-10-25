import { t } from '../i18n';
import { isMobilePlatform } from '../platform';
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { qrSvg } from '../qr';
import { PairWords } from './PairWords';
import { PairSteps } from './PairSteps';
import { usePairingActivity } from '../pairingActivity';
import { ClaimCodeSheet, type ClaimCodeView } from './ClaimCodeSheet';

export type AddInput = {action:'status'|'mint'|'poll'|'cancel'|'claim_code'} | {action:'approve'|'reject'; op_id:string};
export type PendingDevice = {op_id:string; name:string; words:string[]; expires_at:number; can_approve?:boolean};
export type AddView = {state:'unsupported'; owner?:boolean} | {state:'ready'; owner:boolean; second_device?:boolean} | {state:'ticket'; second_device?:boolean; uri:string; expires_at:number; pending:PendingDevice[]} | {state:'done'|'rejected'} | {state:'claim_code'; claim:ClaimCodeView};
export type JoinInput = {action:'status'|'poll'|'cancel'} | {action:'start'; claim_code:string} | {action:'start_second'};
export type JoinView = {state:'idle'|'done'; second_device?:boolean} | {state:'waiting'; second_device?:boolean; words:string[]; expires_at:number};
function errorText(error: unknown): string {
  const message = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message
    : '';
  if ((error && typeof error === 'object' && 'kind' in error && error.kind === 'claim_mismatch')
    || message.startsWith('The comparison could not be verified.')) return t('obClaimMismatch');
  if (/18-character claim code|claim-code checksum/.test(message)) return t('obClaimCodeInvalid');
  // Older hosts can still return CLI recovery instructions. Keep those out of
  // the device setup UI as well as the normal entry and ticket states.
  if (/\bkonsensus\s/i.test(message)) return t('obDeviceSetupHelp');
  return message || t('obNodeUnreachable');
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
  const [secondDevice, setSecondDevice] = createSignal(false);
  const [showCode, setShowCode] = createSignal(false);
  const [now, setNow] = createSignal(Date.now()/1000);
  let alive = true;
  const ticket = () => { const v = view(); return v?.state === 'ticket' ? v : undefined; };
  const owner = () => { const v = view(); return v?.state === 'ticket' || ((v?.state === 'ready' || v?.state === 'unsupported') && v.owner); };
  const qr = createMemo(() => {
    const v = ticket();
    if (!v || !v.uri || v.expires_at <= now() || v.pending.length) return null;
    try { return qrSvg(v.uri); } catch { return null; }
  });
  usePairingActivity(() => busy() || !!ticket() || showCode());
  const run = async (input: AddInput) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { const next = await props.api(input); if (alive) { if (next.state === 'ready' || next.state === 'ticket') setSecondDevice(!!next.second_device); setView(next); } }
    catch (e) { if (alive) setError(errorText(e)); }
    finally { if (alive) setBusy(false); }
  };
  onMount(() => {
    void run({action:'status'});
    const timer = setInterval(() => {
      setNow(Date.now()/1000);
      if ((ticket() || (view()?.state === 'ready' && (view() as {second_device?:boolean}).second_device)) && !error()) void run({action:'poll'});
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => { alive = false; });
  return <section class="panel add-device" data-add-device>
    <h2>{t('obDevices')}</h2>
    <Switch>
      <Match when={!view() && !error()}><p role="status">{t('obChecking')}</p></Match>
      <Match when={view()?.state === 'unsupported'}>
        <Show when={props.local} fallback={<p data-add-device-unsupported="node">{t('obDevicesUnsupported')}</p>}>
          <p data-add-device-unsupported="local">{t('obLocalDevicesOnly')}</p>
        </Show>
      </Match>
      <Match when={view()?.state === 'ready'}>
        <Show when={(view() as {owner:boolean}).owner} fallback={<p>{t('obUseOwnerDevice')}</p>}>
          <p>{t('obAddDeviceHint')}</p>
          <button class="primary" disabled={busy()} onClick={() => void run({action:'mint'})}>{busy() ? t('obCreatingTicket') : t('obAddDevice')}</button>
        </Show>
      </Match>
      <Match when={ticket()}><>
        {/* Owner side: the new device scans the ticket (step 1), then both compare the words (step 3). */}
        {/* An expired or used ticket with nobody comparing: no step is current (the panel below says why). */}
        <PairSteps secondDevice={ticket()!.second_device} current={ticket()!.pending.length > 0 ? 2 : ticket()!.uri && ticket()!.expires_at > now() ? 0 : null} />
        <Show when={ticket()!.pending.length === 0}>
          <Show when={ticket()!.uri && ticket()!.expires_at > now()} fallback={<p role="status">{ticket()!.expires_at <= now()
            ? t('obTicketExpired')
            : t('obTicketUsed')}</p>}>
            <p data-ticket-where>{t('obTicketWhere')}</p>
            <Show when={!ticket()!.second_device}><p class="hint" data-ticket-claim-warning>{t('obClaimWarning')}</p></Show>
            <Show when={qr()} fallback={<p class="hint">{t('obTicketTooLarge')}</p>}>{q => <svg class="qr" viewBox={`0 0 ${q().extent} ${q().extent}`} shape-rendering="crispEdges" role="img" aria-label={t('obTicketQr')}>
              <rect width={q().extent} height={q().extent} fill="#fff" /><path d={q().path} fill="#000" />
            </svg>}</Show>
            <label class="ticket-label">{t('obPairingTicket')}<textarea readOnly value={ticket()!.uri} aria-label={t('obPairingTicket')} spellcheck={false} /></label>
            <p role="status">{t('obWaitingDevice')}</p>
          </Show>
        </Show>
        <For each={ticket()!.pending}>{p => <div class="device-comparison">
          <h3>{t('obCompareWith')}{' '}<bdi>{p.name || t('obNewDevice')}</bdi></h3>
          <p>{t('obCompareOrder')}</p>
          <PairWords words={p.words} />
          <div class="form-actions">
            <button class="primary" disabled={busy() || p.expires_at <= now() || p.can_approve === false || !!error()} onClick={() => void run({action:'approve',op_id:p.op_id})}>{t('obApproveWith')}{' '}{(props.mobile ?? isMobilePlatform()) ? t('obBiometrics') : 'Touch ID'}</button>
            <button class="quiet" disabled={busy()} onClick={() => void run(ticket()!.second_device ? {action:'reject',op_id:p.op_id} : {action:'cancel'})}>{t('obWordsDiffer')}</button>
          </div>
          <Show when={p.can_approve === false}><p class="hint">{t('obApproveQrDevice')}</p></Show>
          <Show when={!ticket()!.second_device}><p class="hint">{t('obCancelBothDevices')}</p></Show>
        </div>}</For>
        <button class="quiet" disabled={busy()} onClick={() => void run({action:'cancel'})}>{t('obCloseTicket')}</button>
      </></Match>
      <Match when={view()?.state === 'rejected'}><p role="status">{t('obNothingAdded')}</p></Match>
      <Match when={view()?.state === 'done'}><PairSteps secondDevice={secondDevice()} current={3} /><p class="ok-note" role="status">{t('obDeviceAddedKeepOwner')}</p></Match>
    </Switch>
    <Show when={owner()}>
      <button type="button" class="quiet" disabled={busy()} onClick={() => setShowCode(true)}>{t('obShowClaimCode')}</button>
    </Show>
    <Show when={showCode()}><ClaimCodeSheet load={async () => {
      const response = await props.api({action:'claim_code'});
      if (response.state !== 'claim_code') throw new Error('Claim code unavailable');
      return response.claim;
    }} onClose={() => setShowCode(false)} /></Show>
    <Show when={error()}><p class="err-note" role="alert">{error()}</p><button disabled={busy()} onClick={() => void run({action:ticket() ? 'poll' : 'status'})}>{t('obTryAgain')}</button></Show>
  </section>;
}

export function JoinDevice(props:{api:(input:JoinInput)=>Promise<JoinView>; mobile?:boolean}) {
  const [view, setView] = createSignal<JoinView>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [secondDevice, setSecondDevice] = createSignal(false);
  let claim!: HTMLInputElement;
  let alive = true;
  const waiting = () => { const v = view(); return v?.state === 'waiting' ? v : undefined; };
  usePairingActivity(() => busy() || !!waiting());
  const run = async (input:JoinInput) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { const next = await props.api(input); if(alive) { if (next.second_device !== undefined) setSecondDevice(next.second_device); setView(next); } }
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
    <h2>{t('obAddThisDevice')}</h2>
    <Switch>
      <Match when={!view() && !error()}><p role="status">{t('obChecking')}</p></Match>
      <Match when={view()?.state === 'idle'}>
        <Show when={(view() as {second_device?:boolean}).second_device} fallback={<>
        {/* New device: the ticket was scanned or pasted to get here; next the claim code. */}
        <PairSteps secondDevice={secondDevice()} current={1} />
        <p>{t('obClaimEntry')}</p>
        <form onSubmit={event => { event.preventDefault(); const value = claim.value; claim.value = ''; void run({action:'start',claim_code:value}); }}>
          <label>{t('obClaimCode')}<input ref={claim} name="claim_code" type="password" autocomplete="off" spellcheck={false} required disabled={busy()} /></label>
          <button class="primary" disabled={busy()}>{busy() ? t('obPreparingComparison') : t('obShowComparison')}</button>
        </form>
        </>}>
          <p>{t('obKeepOwnerNearby')}</p>
          <button class="primary" disabled={busy()} onClick={() => void run({action:'start_second'})}>{busy() ? t('obPreparingComparison') : t('obShowComparison')}</button>
        </Show>
      </Match>
      <Match when={waiting()}>{v => <>
        <PairSteps secondDevice={secondDevice()} current={2} />
        <PairWords words={v().words} />
        <p role="status"><Show when={secondDevice()} fallback={<>{t('obCompareConsoleBefore')}{' '}{(props.mobile ?? isMobilePlatform()) ? t('obBiometrics') : 'Touch ID'}.</>}>{t('obApproveOtherDevice')}</Show></p>
        <button class="quiet" disabled={busy()} onClick={() => void run({action:'cancel'})}>{t('obWordsDifferCancel')}</button>
      </>}</Match>
      <Match when={view()?.state === 'done'}><PairSteps secondDevice={secondDevice()} current={3} /><p class="ok-note" role="status">{t('obDeviceAddedNoPassword')}</p></Match>
    </Switch>
    <Show when={error()}><p class="err-note" role="alert">{error()}</p><button disabled={busy()} onClick={() => void run({action:'status'})}>{t('obCheckAgain')}</button><Show when={!waiting()}><button disabled={busy()} onClick={() => void run({action:'cancel'})}>{t('obCancelPendingSetup')}</button></Show></Show>
  </section>;
}
