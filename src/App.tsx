import { isMobilePlatform } from './platform';
import { pollWatchBatch, statusWatchSamples, watchPoller, type WatchSamples, type WatchUpdates } from './control/watches';
import type { AssistantId } from './control/assistants';
import { LockedNode, RememberUnlock } from './onboarding/LockedNode';
import { RemoteOwnerCeremony } from './onboarding/RemoteOwnerCeremony';
import { LocalOwnerCeremony } from './onboarding/LocalOwnerCeremony';
import { InitializationRepair } from './onboarding/InitializationRepair';
import { OfflineNode } from './control/OfflineNode';
import { softenError } from './control/userFacing';
import { SoftError } from './control/SoftError';
import { DelayedSpinner } from './control/DelayedSpinner';
import { isMoneyNotReady } from './control/readiness';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type ParentProps } from 'solid-js';
import { qrSvg } from './qr';
import { Onboarding, type NodeTarget } from './onboarding/Onboarding';
import { INITIAL_PAIRING, type NodeStatus, type PairingView } from './onboarding/pairing';
import { amount as fmtAmount } from './control/format';
import { ControlCenter } from './control/Shell';
import { hostSource, inHost, sampleRequest, type SampleStart, type Source } from './control/source';
import { sampleSource } from './control/sample';
import type { DeviceView, FundingAddress, FundState } from './control/types';
import { androidQrScannerAvailable, scanPairingLink } from './pairingScanner';
import { cameraQrScannerAvailable, scanPairingLinkWithCamera } from './cameraQrScanner';
import { PairingActivityProvider, usePairingActivity, usePairingBlocked } from './pairingActivity';
import { watchPairingLinks } from './pairingDeepLink';

// The control center. First run (Start node → Pair this app → Create/restore
// identity → Fund) is the shell's first state, shown in the centre track until
// the node is ready and the Gate G6 disclosure is accepted; then the rail,
// tracks and the Node/Wallet panel open. The Rust host bundles + supervises the
// node, pairs with it (or, on a node without pairing routes, mints via
// /auth/local), and exposes every node call as a Tauri command. This renderer
// only reflects that state: it never talks to the node directly, never touches a
// non-loopback host (Gate G2), and never holds a JWT or private key. The gated
// LocalOwnerCeremony displays a new phrase once. Restore accepts a recovery
// phrase as a write-only input: masked on entry, passed
// straight to the host, and cleared the moment it is submitted.

const DEFAULT_FUNDING_SATS = 50_000;
// The Wallet panel shows the node balance; this block is deposit-only.
const short = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export default function App() {
  return <PairingActivityProvider><AppScreen /></PairingActivityProvider>;
}

function AppScreen() {
  // Dev mode: sample data with no node (a plain browser tab, or `?sample`).
  const sample = sampleRequest(window.location.search, inHost(), import.meta.env.DEV);
  const canScanPairingQr = androidQrScannerAvailable();
  // Android or iOS: the first run has no "This Mac" (the scanner gate above stays Android-only).
  const onPhone = isMobilePlatform();
  // A desktop (macOS) webview scans with the camera; jsQR loads only on Scan.
  const desktopScan = !canScanPairingQr && cameraQrScannerAvailable();
  const [pairingRequest, setPairingRequest] = createSignal<{ link: string } | null>(null);
  const [queuedPairing, setQueuedPairing] = createSignal<{ link: string } | null>(null);
  const [pairingBusy, setPairingBusy] = createSignal(false);
  const activityBlocked = usePairingBlocked();
  const pairingBlocked = () => pairingRequest() !== null || activityBlocked();
  const closePairing = () => { if (!pairingBusy()) setPairingRequest(null); };
  const reviewPairing = () => {
    if (pairingBlocked()) return;
    const queued = queuedPairing();
    if (!queued) return;
    setPairingRequest(queued);
    setQueuedPairing(null);
  };
  let stopPairingLinks: (() => void) | undefined;
  onMount(() => {
    if (canScanPairingQr) stopPairingLinks = watchPairingLinks(link => setQueuedPairing({ link }));
  });
  onCleanup(() => stopPairingLinks?.());
  // `?sample&organism=v2` shows the organism view against a node with N1/N2.
  const organism = new URLSearchParams(window.location.search).get('organism') === 'v2' ? 'v2' : 'v1';
  const noPeers = new URLSearchParams(window.location.search).get('peers') === '0';
  const [source, setSource] = createSignal<Source>(sample ? sampleSource({ organism, noPeers }) : hostSource);
  const [status, setStatus] = createSignal<NodeStatus>({ ready: false, node_id: null, error: null });
  // Gate G6: the funds UI stays behind an explicit trust disclosure.
  const [sessionTrust, setSessionTrust] = createSignal<string | null>(null);
  const trustKey = () => status().node_id ? `bitsov.trust.v1.${pairing().remote ? 'remote' : 'local'}.${status().node_id!.toLowerCase()}` : null;
  const trustAck = () => {
    if (source().mode === 'sample') return sessionTrust() === 'sample' || sample === 'shell';
    if (pairing().state === 'failed' || pairing().bootstrap) return false;
    const key = trustKey();
    // A transient missing identity does not close a warm shell. A different
    // identity or connection mode is a new trust boundary.
    if (sessionTrust()) return !key || sessionTrust() === key;
    if (!status().ready || !['paired', 'fallback'].includes(pairing().state) || !key) return false;
    return pairing().trust_acknowledged_node_id?.toLowerCase() === status().node_id?.toLowerCase();
  };
  const acceptTrust = async () => {
    const key = source().mode === 'sample' ? 'sample' : trustKey();
    if (!key) return;
    if (key !== 'sample') {
      const accepted = await source().trustAcknowledge(status().node_id!, pairing().remote, false);
      if (!accepted) throw new Error('Could not save trust acknowledgement.');
      // An IPC response for the previous node must never accept its replacement.
      if (trustKey() !== key) return;
    }
    setSessionTrust(key);
  };
  const [restoring, setRestoring] = createSignal(false);
  // Lifted so IdentityGate can stay mounted when ready is false (restart_node
  // clears ready). Restore retry/error must not be gated on ready: IdentityGate
  // must still show restore errors if ready is false.
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  const [pairing, setPairing] = createSignal<PairingView>(INITIAL_PAIRING);
  // A ready node can arrive before its pairing reply. Startup snapshots do not
  // establish the final mode, so wait for authentication before offering trust.
  const showIdentityGate = () =>
    ((status().ready || pairing().bootstrap === 'bootstrap') && (pairing().state === 'paired' || pairing().state === 'fallback')) ||
    restoring() || restoreError() !== null;
  createEffect(() => {
    if (source().mode === 'node' && trustAck() && trustKey()) setSessionTrust(trustKey());
  });
  let migratingTrust = false;
  let migrationBoundary: string | null = null;
  createEffect(() => {
    const key = trustKey();
    if (source().mode !== 'node' || sessionTrust() || !status().ready ||
        !['paired', 'fallback'].includes(pairing().state) || pairing().bootstrap || !key) return;
    // Only the first authenticated boundary may import a legacy flag this run.
    migrationBoundary ??= key;
    if (migrationBoundary !== key || migratingTrust) return;
    try { if (localStorage.getItem(key) !== 'accepted') return; }
    catch { return; }
    migratingTrust = true;
    void source().trustAcknowledge(status().node_id!, pairing().remote, true).then(accepted => {
      try { localStorage.removeItem(key); } catch { /* the host also makes migration idempotent */ }
      if (accepted && trustKey() === key) setSessionTrust(key);
    }).catch(() => {
      // Keep the legacy flag for a later retry; failed persistence is not consent.
    }).finally(() => { migratingTrust = false; });
  });
  // Readiness describes this connection attempt. Opening the shell records that
  // setup completed for this trust boundary; a cooldown is not a new first run.
  const shellOpen = createMemo<boolean>((wasOpen) => {
    if (!trustAck()) return false;
    return status().ready || wasOpen;
  }, false);
  const live = () => shellOpen() && !status().locked && status().ready && !status().retry_after_secs;
  // A phone (Android or iOS) has no node of its own: its first run is "connect to your node".
  const [selectedTarget, setSelectedTarget] = createSignal<NodeTarget>(
    onPhone ? 'network' : 'local',
  );
  const remote = createMemo(() => pairing().remote);
  createEffect(() => setSelectedTarget(remote() || onPhone ? 'network' : 'local'));
  const [device, setDevice] = createSignal<DeviceView | null>(null);
  // The node accepted a typed password; the host holds it for one yes/no.
  const [rememberOffer, setRememberOffer] = createSignal(false);
  const [rememberChoosing, setRememberChoosing] = createSignal(false);
  const [rememberSaved, setRememberSaved] = createSignal(false);
  const showRemember = () => rememberOffer() || rememberChoosing() || rememberSaved();
  // Once pairing has an outcome, the start spinner no longer describes the state.
  usePairingActivity(() => showRemember() || restoring() ||
    (!!status().initialization_repair && status().initialization_repair !== 'none'));
  const starting = () => pairing().state === 'starting' || pairing().state === 'pending';

  let readWatchSamples: (() => WatchSamples) | null = null;
  const watchRevisions: Partial<Record<AssistantId, string>> = {};
  const [watchUpdates, setWatchUpdates] = createSignal<WatchUpdates>({});
  const [watchError, setWatchError] = createSignal<string | null>(null);
  const watchesAllowed = () => {
    if (shellOpen()) return true;
    // An accepted node may start locked/offline. Preserve the first-run trust
    // gate without requiring a fresh ready state to observe its status.
    if (pairing().bootstrap || !['paired', 'fallback'].includes(pairing().state)) return false;
    const key = trustKey();
    try { return key !== null && localStorage.getItem(key) === 'accepted'; }
    catch { return false; }
  };
  const watches = watchPoller(samples => pollWatchBatch(source(), samples, watchRevisions), result => {
    setWatchUpdates(old => ({ ...old, ...result.updates }));
    setWatchError(result.failed ? 'Some watch notices could not be saved. The next status poll will retry.' : null);
  });
  onCleanup(watches.close);
  const [lastSeen, setLastSeen] = createSignal<{ nodeId: string; at: number } | null>(null);
  const offline = () => !status().locked && (!!status().retry_after_secs ||
    (!status().ready && !!status().error && !softenError(status().error).money &&
      /connection[ _](refused|lost|closed)|ECONN|network[ _]error|failed to fetch|timed?[ _]out|unreachable|remote unavailable|remote handshake limit or endpoint unavailable|remote_handshake_unavailable/i.test(status().error!)));
  const offlineScreen = (level: () => 1 | 2 = () => 2) => <Show when={offline()}><OfflineNode remote={pairing().remote} level={level()}
    lastSeen={!status().node_id || status().node_id === lastSeen()?.nodeId ? lastSeen()?.at : null}
    retryAfterSecs={status().retry_after_secs} onRetry={retryPairing} /></Show>;
  let timer: number | undefined;
  const poll = async () => {
    try {
      const next = await source().nodeStatus();
      setStatus(next);
      if (next.ready && !next.retry_after_secs && next.node_id) setLastSeen({ nodeId: next.node_id, at: Date.now() });
      setRememberOffer(!!next.remember_offer);
    } catch (e) {
      setStatus({ ready: false, node_id: null, error: String(e) });
    }
    void watches.tick(watchesAllowed(), statusWatchSamples(status().ready, status().locked === true, readWatchSamples?.() ?? {}));
    try {
      setPairing(await source().pairingStatus());
    } catch {
      /* keep the last known pairing state; node_status carries host errors */
    }
    // This command reads /pair/device-keys remotely. Once setup is complete,
    // the shell owns its paced refresh; the status poll must not duplicate it.
    if (status().locked || shellOpen() || status().retry_after_secs) return;
    try {
      setDevice(await source().deviceKeyStatus());
    } catch {
      /* keep last known or null */
    }
  };
  const retryPairing = async () => {
    const remote = pairing().remote;
    setPairing({ ...INITIAL_PAIRING, remote, state: 'pending' });
    try {
      setPairing(await source().pairingRetry());
    } catch (e) {
      setPairing({ ...INITIAL_PAIRING, remote, state: 'failed', reason: String(e) });
    } finally {
      await poll();
    }
  };
  const useSample = (start: SampleStart) => {
    setSource(sampleSource({ organism, noPeers }));
    setSessionTrust(start === 'shell' ? 'sample' : null);
    void poll();
  };

  onMount(() => {
    void poll();
    timer = window.setInterval(() => void poll(), 1500);
  });
  onCleanup(() => {
    if (timer) window.clearInterval(timer);
  });

  // Offline, the setup steps below would read as progress: they wait behind
  // one quiet choice, for an owner who wants to point the app elsewhere.
  // They are only HIDDEN, never unmounted: an owner ceremony in progress
  // (for example across the box's restart after setup) keeps its state and
  // its polling, and continues when the box is back. A repair prompt is never hidden.
  const [changeNode, setChangeNode] = createSignal(false);
  createEffect(() => { if (!offline()) setChangeNode(false); });
  const repairing = () => !!status().initialization_repair && status().initialization_repair !== 'none';
  const setupHidden = () => offline() && !changeNode() && !repairing();
  const firstRun = (
    <div class="first-run" data-first-run>
      {/* While the setup steps are hidden, the offline card is the page: its title is the page's h1. */}
      {offlineScreen(() => (setupHidden() ? 1 : 2))}
      <Show when={setupHidden()}>
        <button type="button" class="quiet offline-change" data-offline-change onClick={() => setChangeNode(true)}>Use a different node</button>
      </Show>
      <div class="setup-steps" data-setup-steps hidden={setupHidden()}>

      <Show
        when={status().initialization_repair && status().initialization_repair !== 'none'}
        fallback={<>
          <Onboarding
            status={status}
            pairing={pairing}
            selectedTarget={selectedTarget()}
            onTargetChange={setSelectedTarget}
            trustAck={trustAck}
            onRetry={() => void retryPairing()}
            device={device}
            joinDevice={input => source().joinDevice(input)}
            onForgetRemote={() => source().remoteAccessForget()}
            onPreviewRemote={(link) => source().remoteAccessPreview(link)}
            onImportRemote={(link) => source().remoteAccessImport(link)}
            onScanRemote={canScanPairingQr ? scanPairingLink : desktopScan ? scanPairingLinkWithCamera : undefined}
            mobile={canScanPairingQr}
            phone={onPhone}
            onRegisterDevice={async () => setDevice(await source().deviceKeyRegister())}
            onCancelDevice={async () => setDevice(await source().deviceKeyCancel())}
          />

          <Show
            when={showIdentityGate()}
            fallback={
              <Show
                when={status().error && pairing().state !== 'failed' && !offline()}
                fallback={
                  <Show when={starting()}>
                    <div class="state">
                      <DelayedSpinner />
                      {pairing().remote ? 'Connecting to your node…' : 'Starting your node…'}
                    </div>
                  </Show>
                }
              >
                <div class="state error">
                  <SoftError message={status().error!} summary="Your node is unavailable." onReconnect={retryPairing} />
                  <Show when={import.meta.env.DEV && source().mode === 'node'}>
                    <button class="quiet" data-use-sample onClick={() => useSample('shell')}>
                      Explore with sample data
                    </button>
                  </Show>
                </div>
              </Show>
            }
          >
            <Show when={!trustAck()}>
              <Show when={pairing().remote && pairing().bootstrap === 'bootstrap'} fallback={
                <Show when={status().local_owner && pairing().bootstrap === 'bootstrap' && !pairing().remote}
                  fallback={<IdentityGate
                  source={source()}
                  nodeId={() => status().node_id}
                  remote={pairing().remote}
                  canRestore={!pairing().bootstrap || (!pairing().remote && pairing().bootstrap === 'bootstrap')}
                  bootstrap={!!pairing().bootstrap}
                  onContinue={acceptTrust}
                  onRestoring={setRestoring}
                  restoreError={restoreError}
                  setRestoreError={setRestoreError}
                />}>
                  <LocalOwnerCeremony onComplete={() => void poll()} />
                </Show>
              }>
                <RemoteOwnerCeremony onComplete={() => void poll()} />
              </Show>
            </Show>
          </Show>
        </>}
      >
        <Show keyed when={status().initialization_repair?.startsWith('price_floor') ? 'price' : 'marker'}>{(kind) =>
          <InitializationRepair
            priceFloor={kind === 'price'}
            repairing={status().initialization_repair === 'repairing' || status().initialization_repair === 'price_floor_repairing'}
            onConfirm={async () => {
              try {
                if (kind === 'price') await source().nodeRepairPriceFloor(true);
                else await source().nodeRepairInitialized(true);
              } finally { await poll(); }
            }}
          />
        }</Show>
      </Show>
      </div>
    </div>
  );

  // The shell reads the node only once it is running AND the trust
  // disclosure is accepted; before that it may call node_status and
  // pairing_status, nothing else.
  return (
    <>
    <div class="pairing-link-layer" classList={{ reviewing: pairingRequest() !== null }}>
    <Show when={queuedPairing()}>
      <aside class="panel pairing-link-banner" data-pairing-link-banner role="status">
        <p>{pairingBlocked() ? 'New pairing link queued. Finish or close the current pairing review or ceremony first. Only the newest incoming link is kept.' : 'A pairing link is waiting. Review it when you are ready.'}</p>
        <button type="button" data-review-pairing disabled={pairingBlocked()} onClick={reviewPairing}>Review incoming link</button>
        <button type="button" class="quiet" onClick={() => setQueuedPairing(null)}>Dismiss link</button>
      </aside>
    </Show>
    <Show when={pairingRequest()}>{request => (
      <PairingLinkOverlay onClose={closePairing}>
        <h1>Pair this phone with your node</h1>
        <p>Review the endpoint and node fingerprint before choosing Use remote node. Opening a link does not pair this phone.</p>
        <Onboarding status={() => ({ ready: false, node_id: null, error: null })}
          pairing={() => INITIAL_PAIRING} trustAck={() => false} onRetry={() => {}}
          selectedTarget="network" initialPairingLink={request().link} pairingInputId="incoming-pairing-link"
          onPreviewRemote={link => source().remoteAccessPreview(link)}
          onImportRemote={link => source().remoteAccessImport(link)}
          onBusyChange={setPairingBusy}
          onScanRemote={scanPairingLink} mobile phone />
        <button type="button" class="quiet" data-close-pairing disabled={pairingBusy()} onClick={closePairing}>Close pairing</button>
      </PairingLinkOverlay>
    )}</Show>
    </div>
    <div data-app-screen inert={pairingRequest() !== null} style={{ display: 'contents' }}>
    <Show when={status().local_owner && status().owner_warning}>
      <aside role="alert" class="panel" data-owner-warning>{status().owner_warning}</aside>
    </Show>
    <Show when={showRemember()}>
      <RememberUnlock mobile={canScanPairingQr} onChoose={async (remember) => {
        // The host consumes the offer during storage. Keep this dialog mounted
        // across polls so a slow save retains its busy state and any refusal.
        setRememberChoosing(true);
        try {
          await source().nodeUnlockRemember(remember);
          if (remember) setRememberSaved(true);
        } finally {
          await poll();
          setRememberChoosing(false);
        }
      }} onDone={() => { setRememberOffer(false); setRememberSaved(false); }} />
    </Show>
    <Show when={!status().locked} fallback={<LockedNode
      mobile={canScanPairingQr}
      typedUnlockSupported={status().typed_unlock_supported}
      state={status().unlock_state}
      pending={status().pending_device}
      attemptsLeft={status().attempts_left}
      onCancel={async () => { await source().deviceKeyCancel(); await poll(); }}
      hostError={status().error}
      onUnlock={async () => { try { await source().nodeUnlock(); } finally { await poll(); } }}
      onUnlockWithPassword={status().typed_unlock_supported ? async (password) => {
        try { await source().nodeUnlockPassword(password); } finally { await poll(); }
      } : undefined}
    />}>
    <Show
      when={trustAck()}
      fallback={
        <ControlCenter remote={pairing().remote} retryAfterSecs={status().retry_after_secs} onReconnect={retryPairing} source={source()} active={false} ready={status().ready} error={status().error} ownId={status().node_id} firstRun={firstRun} />
      }
    >
      <ControlCenter
        remote={pairing().remote}
        offline={offlineScreen()}
        retryAfterSecs={status().retry_after_secs}
        onReconnect={retryPairing}
        source={source()}
        active={shellOpen()}
        onWatchSamples={read => { readWatchSamples = read; }}
        watchUpdates={watchUpdates()}
        watchError={watchError()}
        live={live()}
        ready={status().ready}
        error={status().error}
        ownId={status().node_id}
        firstRun={firstRun}
        fund={(guarded, blocked) => <Fund source={guarded} moneyBlocked={blocked} ready={live} />}
      />
    </Show>
    </Show>
    </div>
    </>
  );
}

function PairingLinkOverlay(props: ParentProps<{ onClose: () => void }>) {
  let dialog!: HTMLDivElement;
  const previousFocus = document.activeElement as HTMLElement | null;
  onMount(() => dialog.focus());
  onCleanup(() => queueMicrotask(() => {
    if (previousFocus?.isConnected) previousFocus.focus();
  }));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, a[href]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault(); first.focus();
    }
  };
  return <div ref={dialog} class="pairing-link-overlay" role="dialog" aria-modal="true"
    aria-label="Pair this phone with your node" data-pairing-link-screen tabindex="-1" onKeyDown={onKeyDown}>
    {props.children}
  </div>;
}

/**
 * Identity + the Gate G6 trust disclosure, which must be read and accepted
 * before any funding UI is shown. Also the place to restore an existing identity —
 * before there is money on this node, not after.
 */
function IdentityGate(props: {
  source: Source;
  nodeId: () => string | null;
  remote: boolean;
  /** Restore is local; the host checks the node router before submitting. */
  canRestore: boolean;
  bootstrap: boolean;
  onContinue: () => Promise<void>;
  onRestoring: (value: boolean) => void;
  restoreError: () => string | null;
  setRestoreError: (value: string | null) => void;
}) {
  const [showRestore, setShowRestore] = createSignal(false);
  const [phrase, setPhrase] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [savingTrust, setSavingTrust] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [restored, setRestored] = createSignal<string | null>(null);
  usePairingActivity(() => showRestore() || busy() || savingTrust());

  const submitRestore = async (event: Event) => {
    event.preventDefault();
    // Read once, then clear immediately: the phrase lives in this component for the
    // duration of the call and nowhere else. The host forwards it to the node.
    const value = phrase();
    setPhrase('');
    if (!value.trim()) {
      setError('Enter your 12- or 24-word recovery phrase.');
      return;
    }
    setBusy(true);
    setError(null);
    // restoring() first so showIdentityGate stays true while ready is false.
    props.onRestoring(true);
    props.setRestoreError(null);
    try {
      const outcome = await props.source.identityRestore(value);
      setRestored(outcome.node_id);
      setShowRestore(false);
      props.setRestoreError(null);
    } catch (e) {
      const message = String(e);
      setError(message);
      // Keep IdentityGate visible while ready is false so the user can retry.
      props.setRestoreError(message);
    } finally {
      setBusy(false);
      props.onRestoring(false);
    }
  };

  const displayError = () => error() ?? props.restoreError();

  return (
    <div class="state ready">
      <Show when={busy()}>
        <DelayedSpinner />
        <div>Restarting with your restored identity…</div>
      </Show>
      <div class="running">
        <div class="dot ok" />
        <div>Your node is running.</div>
      </div>
      <details class="node-details">
        <summary>Technical node details & address</summary>
        <div class="node-id" title={props.nodeId() ?? ''}>
          {short(props.nodeId() ?? '')}
        </div>
      </details>

      <Show
        when={props.remote}
        fallback={
          <section class="panel disclosure" data-gate="g6-local-trust">
            <h2>Local trust — read this before you deposit</h2>
            <p>Your node is only reachable while this Mac is awake and BitSov is open.</p>
            <p>
              This node trusts every program on this computer. Anything running under your user
              account can ask it for full access over <code>127.0.0.1</code> — enough to spend what
              you deposit and read your history. Only fund a node on a machine you control.
            </p>
            <p>
              Your keys stay in the node. BitSov never shows you your recovery phrase and never
              copies it anywhere.
            </p>
          </section>
        }
      >
        <section class="panel disclosure" data-gate="g6-remote-trust">
          <h2>Remote trust — read this before you deposit</h2>
          <p>
            This node’s keys live on the remote machine. Anyone with access —
            whoever can log in to that computer — can spend what you deposit. Only fund a node whose host you trust.
          </p>
          <p>
            Your keys stay in the node. BitSov never shows you your recovery phrase and never
            copies it anywhere.
          </p>
        </section>
      </Show>

      <Show when={!props.bootstrap}>
      <button class="primary" disabled={busy() || savingTrust()} onClick={async () => {
        setSavingTrust(true);
        setError(null);
        try { await props.onContinue(); }
        catch (e) { setError(String(e)); }
        finally { setSavingTrust(false); }
      }}>
        I understand — continue to funding
      </button>
      </Show>

      <Show when={restored()}>
        <p class="ok-note">Identity restored. Your node now runs as {short(restored()!)}.</p>
      </Show>

      <Show when={props.canRestore}>
      <Show
        when={showRestore()}
        fallback={
          <button class="link" data-restore-open onClick={() => setShowRestore(true)}>
            Restore an existing identity
          </button>
        }
      >
        <form class="panel restore" onSubmit={submitRestore}>
          <label for="restore-phrase">Recovery phrase (12 or 24 words)</label>
          <input
            id="restore-phrase"
            type="password"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            disabled={busy()}
            value={phrase()}
            onInput={(e) => setPhrase(e.currentTarget.value)}
          />
          <p class="hint">
            Replaces this node’s identity with the one your phrase derives, then restarts the
            node. Do this before you deposit anything.
          </p>
          <div class="row">
            <button type="submit" class="primary" disabled={busy()}>
              {busy() ? 'Restoring…' : 'Restore'}
            </button>
            <button
              type="button"
              class="link"
              disabled={busy()}
              onClick={() => {
                setPhrase('');
                setShowRestore(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Show>
      </Show>

      <Show when={displayError()}>
        <SoftError message={displayError()!} />
      </Show>
    </div>
  );
}

/**
 * First-run funding: start the tier-`full` onboarding for an amount, show the deposit
 * address as text + QR, and poll `/onboarding/state` until the node reports it has
 * seen the funds.
 */
function Fund(props: { source: Source; ready: () => boolean; moneyBlocked?: () => boolean }) {
  const [fund, setFund] = createSignal<FundState | null | undefined>(undefined);
  const [address, setAddress] = createSignal<FundingAddress | null>(null);
  // Why the payments endpoint gave no address, so the owner is not left waiting.
  const [addressError, setAddressError] = createSignal<string | null>(null);
  const [amount, setAmount] = createSignal(String(DEFAULT_FUNDING_SATS));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    if (!props.ready()) return;
    try {
      const state = await props.source.fundState();
      setFund(state);
      setError(null);
      // The onboarding record carries the address once started; fall back to the
      // payments endpoint if the node did not include one.
      if (state && !state.funding_address && !address() && !props.moneyBlocked?.()) {
        try {
          setAddress(await props.source.fundingAddress());
          setAddressError(null);
        } catch (e) {
          // The wallet backend may not expose one (only embedded LDK does); the
          // state address is primary, but say so instead of waiting forever.
          setAddressError(isMoneyNotReady(e) ? null : String(e));
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  let timer: number | undefined;
  onMount(() => {
    void refresh();
    timer = window.setInterval(() => {
      if (!fund()?.funded) void refresh();
    }, 3000);
  });
  onCleanup(() => {
    if (timer) window.clearInterval(timer);
  });

  const start = async (event: Event) => {
    event.preventDefault();
    if (props.moneyBlocked?.()) return;
    const value = Number(amount());
    if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
      setError('Enter a whole number of sats.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setFund(await props.source.fundStart(value));
      await refresh();
    } catch (e) {
      setError(isMoneyNotReady(e) ? null : String(e));
    } finally {
      setBusy(false);
    }
  };

  const depositAddress = () => fund()?.funding_address ?? address()?.address ?? null;
  const qr = createMemo(() => {
    const value = depositAddress();
    if (!value) return null;
    try {
      return qrSvg(value);
    } catch {
      return null; // never let the QR break the screen; the text address is the source of truth
    }
  });
  const required = () => fund()?.funding_amount_sats_required ?? 0;
  const received = () => fund()?.funding_amount_sats_received ?? 0;
  const progress = () => (required() > 0 ? Math.min(100, (received() / required()) * 100) : 0);

  return (
    <div class="state ready fund">
      <Show when={fund() !== undefined} fallback={<Show when={!error()}><DelayedSpinner /></Show>}>
        <Show
          when={fund()}
          fallback={
            <form class="panel" onSubmit={start}>
              <h2>Fund your node</h2>
              <p class="hint">
                Choose how much on-chain bitcoin to deposit. Your node watches its own wallet
                and tells you when the deposit arrives.
              </p>
              <label for="amount">Amount</label>
              <div class="row">
                <input
                  id="amount"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  disabled={busy()}
                  value={amount()}
                  onInput={(e) => setAmount(e.currentTarget.value)}
                />
                <span class="unit">sats</span>
              </div>
              <button type="submit" class="primary money" data-fund-start disabled={busy() || props.moneyBlocked?.()}>
                {busy() ? 'Starting…' : 'Get a deposit address'}
              </button>
            </form>
          }
        >
          <Show
            when={!fund()!.funded}
            fallback={
              <div class="panel funded">
                <h2>Funding seen</h2>
                <p class="hint">
                  Your node observed {fmtAmount(received() * 1000)}. Opening a Lightning channel and
                  sending your first paid message come next. Channel actions and on-chain fees are outside the app daily all-in limit; check their cost at the owner action.
                </p>
                <Show when={fund()!.funding_evidence}>
                  <p class="evidence">Evidence: {fund()!.funding_evidence}</p>
                </Show>
              </div>
            }
          >
            <div class="panel">
              <h2>Deposit to your node</h2>
              <Show
                when={depositAddress()}
                fallback={
                  <Show
                    when={addressError()}
                    fallback={<p class="hint">Waiting for the node to produce a deposit address…</p>}
                  >
                    <div data-deposit-error><SoftError message={addressError()!} summary="Your node has no deposit address to show." /></div>
                  </Show>
                }
              >
                <Show when={qr()}>
                  <svg
                    class="qr"
                    viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`}
                    shape-rendering="crispEdges"
                    role="img"
                    aria-label="Deposit address as a QR code"
                  >
                    <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                    <path d={qr()!.path} fill="#000000" />
                  </svg>
                </Show>
                <code class="address">{depositAddress()}</code>
                <p class="hint">
                  Send on-chain bitcoin to this address
                  <Show when={address()?.network}>{` (${address()!.network})`}</Show>. It stays
                  valid — scan it or copy the text above.
                </p>
              </Show>

              <div class="progress">
                <div class="bar">
                  <div class="fill" style={{ width: `${progress()}%` }} />
                </div>
                <div class="numbers">
                  <strong>{fmtAmount(received() * 1000)}</strong> of {fmtAmount(required() * 1000)} seen
                </div>
              </div>
              <p class="hint">
                Waiting for your deposit. The node re-checks its wallet every few seconds;
                on-chain confirmation can take a while.
              </p>
            </div>
          </Show>
        </Show>
      </Show>


      <Show when={error()}>
        <SoftError message={error()!} />
      </Show>
    </div>
  );
}
