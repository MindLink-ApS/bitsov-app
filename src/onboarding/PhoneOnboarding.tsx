import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { appPlatform, type AppPlatform } from '../platform';
import type { DeviceView } from '../control/types';
import type { RemoteImportView, RemotePreviewView } from '../control/source';
import { usePairingActivity } from '../pairingActivity';
import type { JoinView } from './AddDevice';
import { normalizePairingLink, type ConnectionError, type NodeStatus, type PairingView } from './pairing';
import { PrimaryAction } from './PrimaryAction';
import { phoneCopy } from './phoneCopy';
import './phoneOnboarding.css';

export type PhoneOnboardingProps = {
  status: () => NodeStatus; pairing: () => PairingView; device: () => DeviceView | null;
  platform?: AppPlatform; locale?: string; scan?: () => Promise<string>; cancelScan?: () => Promise<void>;
  preview: (link: string) => Promise<RemotePreviewView>; connect: (link: string) => Promise<RemoteImportView>;
  retry: () => Promise<unknown>; forget: () => Promise<unknown>;
  /** No secret input: this must use an owner-approved second-device contract. */
  beginJoin: () => Promise<JoinView>;
  join: (input: { action: 'status' | 'poll' | 'cancel' }) => Promise<JoinView>;
  openSettings: () => Promise<void>; openTailscale: () => Promise<void>;
  incoming?: { link: string } | null; onConsumeLink?: () => void; onDone: () => void;
};
type Screen = 'start' | 'scanner' | 'connecting' | 'words' | 'fingerprint' | 'done' | 'error';
type Failure = ConnectionError['kind'] | 'camera' | 'mismatch' | 'approval_expired' | 'unsupported';
const kinds = new Set<Failure>(['unclaimed', 'local_network', 'unreachable', 'busy', 'expired', 'clock', 'used', 'tailscale', 'claim_mismatch', 'other', 'camera', 'mismatch', 'approval_expired', 'unsupported']);
function failure(error: unknown): { kind: Failure; detail: string } {
  const outer = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (outer.code === 'enrollment_restart') return { kind: 'approval_expired', detail: '' };
  const e = outer.connection_error && typeof outer.connection_error === 'object' ? outer.connection_error as Record<string, unknown> : outer;
  // Only structured, sanitized host diagnostics are accepted. Never echo scanner/clipboard errors.
  return { kind: kinds.has(e.kind as Failure) ? e.kind as Failure : 'other', detail: typeof e.detail === 'string' ? e.detail.replace(/bitsov:\/\/pair\/[^\s]+/g, '[redacted]') : '' };
}

export function PhoneOnboarding(props: PhoneOnboardingProps) {
  const c = () => phoneCopy[(props.locale ?? navigator.language).toLowerCase().startsWith('da') ? 'da' : 'en'];
  const [screen, setScreen] = createSignal<Screen>('start');
  const [error, setError] = createSignal<{ kind: Failure; detail: string }>();
  const [busy, setBusy] = createSignal(false);
  const [cancellingScan, setCancellingScan] = createSignal(false);
  const [manualPaste, setManualPaste] = createSignal(false);
  let pasteInput: HTMLInputElement | undefined;
  const [toast, setToast] = createSignal('');
  const [preview, setPreview] = createSignal<RemotePreviewView>();
  const [waiting, setWaiting] = createSignal<Extract<JoinView, { state: 'waiting' }>>();
  const [options, setOptions] = createSignal(false);
  let alive = true, generation = 0, joinGeneration = 0, joining = false, joinStarted = false;
  // Keep an uncommitted link only in memory until comparison or cancellation.
  let pendingLink = '', compared = false;
  let resumeSaved = true;
  let resume: 'camera' | 'connection' | undefined;
  let previousHostError: ConnectionError | null | undefined;
  usePairingActivity(() => busy() || ['scanner', 'connecting', 'words', 'fingerprint'].includes(screen()));
  onCleanup(() => { alive = false; generation++; pendingLink = ''; if (screen() === 'scanner') void props.cancelScan?.().catch(() => {}); });
  const fail = (e: unknown) => { joinGeneration++; setError(failure(e)); setScreen('error'); };
  const receive = (v: JoinView) => {
    if (v.state === 'waiting') { setWaiting(v); setScreen('words'); }
    if (v.state === 'done') { setWaiting(undefined); setScreen('done'); }
  };
  const progressJoin = async () => {
    if (joining || busy() || !['connecting', 'words'].includes(screen()) || !props.status().ready || props.pairing().state !== 'paired') return;
    const d = props.device();
    if (!d) return;
    if (d.delegation_supported === false) { setScreen(compared ? 'done' : 'fingerprint'); return; }
    if (!d.available || !d.delegation_supported) { fail({ kind: 'other', detail: c().unsupported }); return; }
    joining = true;
    const turn = generation, joinTurn = joinGeneration;
    try {
      const v = await props.join({ action: screen() === 'words' ? 'poll' : 'status' });
      if (!alive || turn !== generation || joinTurn !== joinGeneration) return;
      receive(v);
      if (v.state === 'idle' && (joinStarted || screen() === 'words')) { fail({ kind: 'approval_expired' }); return; }
      if (v.state === 'idle' && !joinStarted) {
        if (v.second_device !== true) { fail({ kind: 'unsupported' }); return; }
        joinStarted = true;
        const next = await props.beginJoin();
        if (alive && turn === generation && joinTurn === joinGeneration) {
          if (next.state === 'idle') fail({ kind: 'other' }); else receive(next);
        }
      }
    } catch (e) { if (alive && turn === generation && joinTurn === joinGeneration) fail(e); }
    finally { joining = false; }
  };
  const connect = async (input: string) => {
    if (!alive || busy() || waiting() || joinStarted || ['words', 'fingerprint', 'connecting'].includes(screen())) return;
    let link: string;
    try { link = normalizePairingLink(input); } catch { setToast(c().empty); return; }
    resumeSaved = false; pendingLink = ''; compared = false;
    setManualPaste(false);
    setBusy(true); setToast(''); setError(undefined); setOptions(false); setScreen('connecting');
    const turn = ++generation;
    joinStarted = false;
    try {
      const view = await props.preview(link);
      if (!alive || turn !== generation) return;
      if (view.first_run) { fail({ kind: 'unclaimed' }); return; }
      setPreview(view);
      if (view.second_device !== true) {
        pendingLink = link;
        setScreen('fingerprint');
        return;
      }
      await props.connect(link);
    } catch (e) { if (alive && turn === generation) fail(e); }
    finally { link = ''; if (alive && turn === generation) { setBusy(false); void progressJoin(); } }
  };
  const confirmComparison = async () => {
    if (!alive || busy() || screen() !== 'fingerprint') return;
    if (!pendingLink) { setScreen('done'); return; } // A previously saved legacy pairing.
    let link = pendingLink; pendingLink = ''; compared = true;
    const turn = generation;
    setBusy(true); setScreen('connecting');
    try { await props.connect(link); }
    catch (e) { if (alive && turn === generation) fail(e); }
    finally { link = ''; if (alive && turn === generation) { setBusy(false); void progressJoin(); } }
  };
  const scan = async () => {
    if (!alive || busy() || !props.scan) return;
    setBusy(true); setOptions(false); setToast(''); setScreen('scanner');
    const turn = ++generation;
    try {
      const link = await props.scan();
      if (!alive || turn !== generation) return;
      setBusy(false); setScreen('start');
      await connect(link);
    } catch (e) {
      if (alive && turn === generation) {
        if (failure(e).kind === 'camera') fail({ kind: 'camera' });
        else setScreen('start'); // Native cancellation/errors never reach the page.
      }
    } finally { if (alive && turn === generation) setBusy(false); }
  };
  const paste = async () => {
    if (!alive || busy() || waiting() || joinStarted) return;
    const turn = generation;
    try {
      const link = await navigator.clipboard.readText();
      if (alive && turn === generation) await connect(link);
    }
    catch { if (alive && turn === generation) { setManualPaste(true); setOptions(true); setToast(''); } }
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    try { await action(); } catch (e) { if (alive) fail(e); }
    finally { if (alive) setBusy(false); }
  };
  const reset = async () => {
    generation++; resumeSaved = false; pendingLink = ''; compared = false;
    if (joinStarted || waiting() || props.device()?.state === 'pending') await props.join({ action: 'cancel' });
    await props.forget();
    if (!alive) return;
    generation++; joinStarted = false; setWaiting(undefined); setPreview(undefined); setError(undefined); setScreen('start'); setOptions(false);
  };
  const retry = async () => {
    await props.retry();
    if (alive) {
      if (props.status().connection_error) fail(props.status().connection_error);
      else { setError(undefined); setScreen('connecting'); joinStarted = false; }
    }
  };
  const recover = async () => {
    const kind = error()?.kind;
    if (kind === 'camera' || kind === 'local_network') {
      resume = kind === 'camera' ? 'camera' : 'connection';
      await props.openSettings();
    } else if (kind === 'tailscale') {
      resume = 'connection'; await props.openTailscale();
    } else if (['expired', 'used', 'clock', 'approval_expired', 'unsupported'].includes(kind ?? '')) {
      await reset(); setBusy(false); await scan();
    } else if (['unclaimed', 'mismatch', 'claim_mismatch'].includes(kind ?? '')) await reset();
    else await retry();
  };
  createEffect(() => {
    const e = props.status().connection_error;
    if (e && (e.kind !== previousHostError?.kind || e.detail !== previousHostError?.detail)) fail(e);
    previousHostError = e;
    if (resumeSaved && screen() === 'start' && props.pairing().remote && !e) { resumeSaved = false; setScreen('connecting'); }
    void progressJoin();
  });
  createEffect(() => {
    const incoming = props.incoming;
    if (incoming && !busy() && !waiting() && !joinStarted && ['start', 'error'].includes(screen())) {
      props.onConsumeLink?.(); void connect(incoming.link);
    }
  });
  onMount(() => {
    const timer = window.setInterval(() => {
      if (screen() === 'words' && waiting() && waiting()!.expires_at <= Date.now()/1000) fail({ kind: 'approval_expired' });
      else void progressJoin();
    }, 1500);
    const foreground = () => {
      if (document.visibilityState !== 'visible' || busy()) return;
      const action = resume; resume = undefined;
      if (action === 'camera') void scan();
      else if (action === 'connection' || ['connecting', 'words'].includes(screen())) void run(retry);
    };
    document.addEventListener('visibilitychange', foreground);
    onCleanup(() => { window.clearInterval(timer); document.removeEventListener('visibilitychange', foreground); });
  });
  const errorCopy = () => {
    const t = c();
    switch (error()?.kind) {
      case 'unsupported': return [t.update, t.updateLine, t.newQr];
      case 'unclaimed': return [t.unclaimed, t.unclaimedLine, t.restart];
      case 'local_network': return [t.localNetwork, (props.platform ?? appPlatform()) === 'android' ? t.nearbyLine : t.localNetworkLine, t.settings];
      case 'tailscale': return [t.unreachable, t.tailscaleLine, t.tailscale];
      case 'unreachable': return [t.unreachable, t.unreachableLine, t.retry];
      case 'approval_expired': return [t.approvalExpired, t.expiredLine, t.newQr];
      case 'expired': case 'used': return [t.expired, t.expiredLine, t.newQr];
      case 'clock': return [t.expired, t.clockLine, t.newQr];
      case 'camera': return [t.camera, (props.platform ?? appPlatform()) === 'android' ? t.androidCameraLine : t.cameraLine, t.settings];
      case 'mismatch': return [t.stopped, t.stoppedLine, t.restart];
      case 'claim_mismatch': return [t.claimMismatch, t.claimMismatchLine, t.restart];
      case 'busy': return [t.busy, t.busyLine, t.retry];
      default: return [t.other, t.otherLine, t.retry];
    }
  };
  const face = () => {
    const t = c();
    switch (screen()) {
      case 'scanner': return [t.scanning, t.scanLine];
      case 'connecting': return [t.connecting, t.connectingLine];
      case 'words': return [t.words, t.wordsLine];
      case 'fingerprint': return [t.legacy, t.legacyLine];
      case 'done': return [t.done, t.doneLine];
      case 'error': return errorCopy();
      default: return [t.start, t.startLine];
    }
  };
  return <main class="phone-onboarding" data-phone-onboarding={screen()} lang={c() === phoneCopy.da ? 'da' : 'en'}>
    <div class="phone-progress" aria-hidden="true"><For each={[0, 1, 2]}>{n => <span classList={{ filled: n === 0 || n === 1 && ['words', 'fingerprint', 'done'].includes(screen()) || n === 2 && screen() === 'done' }} />}</For></div>
    <section data-phone-face aria-live="polite">
      <h1>{face()[0]}</h1><p class="phone-line">{face()[1]}</p>
      <Show when={screen() === 'words'}><ol class="phone-words" aria-label={c().words}><For each={waiting()?.words}>{word => <li data-pair-word>{word}</li>}</For></ol>
        <button type="button" class="quiet" disabled={busy()} onClick={() => void run(async () => { generation++; await props.join({ action: 'cancel' }); setWaiting(undefined); fail({ kind: 'mismatch' }); })}>{c().mismatch}</button>
      </Show>
      <Show when={screen() === 'fingerprint'}><code class="phone-fingerprint">{preview()?.node_id_fingerprint ?? props.status().node_id}</code>
        <PrimaryAction disabledReason={!preview()?.node_id_fingerprint && !props.status().node_id ? c().working : undefined} onClick={() => void confirmComparison()}>{c().match}</PrimaryAction>
      </Show>
      <Show when={screen() === 'start' || screen() === 'scanner'}><PrimaryAction disabledReason={busy() ? c().working : !props.scan ? c().unavailable : undefined} onClick={() => void scan()}>{c().scan}</PrimaryAction></Show>
      <Show when={screen() === 'connecting'}><p class="phone-status" role="status">{c().working}</p></Show>
      <Show when={screen() === 'done'}><PrimaryAction onClick={props.onDone}>{c().open}</PrimaryAction></Show>
      <Show when={screen() === 'error'}><PrimaryAction disabledReason={busy() ? c().working : undefined} onClick={() => void run(recover)}>{errorCopy()[2]}</PrimaryAction></Show>
    </section>
    <details class="phone-options" open={options()} onToggle={e => setOptions(e.currentTarget.open)}>
      <summary>{c().options}</summary>
      <button type="button" disabled={busy() || !!waiting() || joinStarted || ['words', 'connecting', 'fingerprint'].includes(screen())} onClick={() => void paste()}>{c().paste}</button>
      <Show when={manualPaste()}><form onSubmit={e => {
        e.preventDefault();
        const link = pasteInput?.value ?? '';
        if (pasteInput) pasteInput.value = '';
        void connect(link);
      }}>
        <label>{c().manualPaste}<input ref={pasteInput} aria-label={c().link} type="password" autocomplete="off" autocapitalize="none" spellcheck={false} /></label>
        <button type="submit" disabled={busy()}>{c().useLink}</button>
      </form></Show>
      <Show when={screen() === 'scanner'}><button type="button" disabled={cancellingScan()} onClick={() => {
        if (cancellingScan()) return;
        setCancellingScan(true);
        const turn = ++generation;
        void (async () => {
          try { await props.cancelScan?.(); } catch { /* Native diagnostics stay private. */ }
          finally { if (alive && turn === generation) { setCancellingScan(false); setBusy(false); setScreen('start'); } }
        })();
      }}>{c().cancel}</button></Show>
      <details><summary>{c().assisted}</summary><p>{c().assistedLine}</p></details>
      <details><summary>{c().help}</summary><p>{c().helpLine}</p></details>
      <details><summary>{c().details}</summary><dl>
        <dt>{c().fingerprint}</dt><dd>{preview()?.node_id_fingerprint ?? props.status().node_id ?? '—'}</dd>
        <dt>{c().endpoint}</dt><dd>{preview()?.endpoint ?? '—'}</dd>
        <dt>{c().hosted}</dt><dd>{preview()?.hosted_by ?? props.pairing().hosted_by ?? '—'}</dd>
      </dl><Show when={error()?.detail}><p>{error()?.detail}</p></Show>
        <button type="button" disabled={busy()} onClick={() => void run(reset)}>{c().forget}</button>
      </details>
      <Show when={['connecting', 'words', 'fingerprint'].includes(screen())}><button type="button" disabled={busy()} onClick={() => void run(reset)}>{c().cancel}</button></Show>
    </details>
    <Show when={toast()}><p class="phone-toast" role="status">{toast()}</p></Show>
  </main>;
}
