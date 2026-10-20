import type { JoinInput, JoinView } from './AddDevice';
import { BoxIllustration } from './BoxIllustration';
import { LocalNodeSwitch } from './LocalNodeSwitch';
import { DeviceApprovals } from './DeviceApprovals';
import { SoftError } from '../control/SoftError';
import { createEffect, createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { normalizePairingLink, onboardingSteps, scopeList, type NodeStatus, type PairingView } from './pairing';
import type { DeviceView } from '../control/types';
import type { RemoteImportView, RemotePreviewView } from '../control/source';
import { usePairingActivity } from '../pairingActivity';

// Claim discipline (BitSov-bitsov docs/security/pairing.md): less exposure, not solved
// local security. The short code is a tripwire, never described as what protects the
// pairing — in the sidecar deployment this app reads the node's stdout by construction.

const STATUS_TEXT = {
  todo: '',
  active: 'now',
  done: 'done',
  failed: 'failed',
  skipped: 'not available on this node',
  blocked: 'not available here',
} as const;

export type NodeTarget = 'local' | 'network' | 'cloud';

/** Three stages the owner sees; the four host steps map onto them. */
export type Stage = 'node' | 'identity' | 'fund';
const STEP_LABEL = { node: 'Your node', pair: 'Pair this app', identity: 'Your identity', fund: 'Add sats' } as const;

export function onboardingStage(steps: { id: string; status: string }[]): Stage {
  const by = (id: string) => steps.find((s) => s.id === id)?.status;
  const settled = (st?: string) => st === 'done' || st === 'skipped';
  if (!settled(by('node')) || !settled(by('pair'))) return 'node';
  return by('identity') === 'done' ? 'fund' : 'identity';
}

export function Onboarding(props: {
  status: () => NodeStatus;
  pairing: () => PairingView;
  trustAck: () => boolean;
  onRetry: () => void;
  selectedTarget?: NodeTarget;
  onTargetChange?: (target: NodeTarget) => void;
  device?: () => DeviceView | null;
  joinDevice?: (input: JoinInput) => Promise<JoinView>;
  onForgetRemote?: () => Promise<void>;
  onPreviewRemote?: (link: string) => Promise<RemotePreviewView>;
  onBusyChange?: (busy: boolean) => void;
  onImportRemote?: (link: string) => Promise<RemoteImportView>;
  onScanRemote?: () => Promise<string>;
  /** A phone (biometric approvals). Defaults to “has a scanner” for older callers. */
  mobile?: boolean;
  /** A phone or tablet build (Android or iOS). Defaults to `mobile` (Android). */
  phone?: boolean;
  /** Touch ID approvals setup, offered once the app is paired (Settings → Node has the same). */
  onRegisterDevice?: () => Promise<unknown>;
  onCancelDevice?: () => Promise<unknown>;
  initialPairingLink?: string;
  pairingInputId?: string;
  /** Only the ticket form (Settings → Node → Pair another node). */
  formOnly?: boolean;
  /** Asked after review, before anything is saved; false leaves everything as it was. */
  confirmImport?: (view: RemotePreviewView) => Promise<boolean>;
}) {
  // Runtime, opt-in only. This changes presentation, never node authority.
  const testNodes = (() => {
    try { return localStorage.getItem('bitsov.test-nodes') === '1'; } catch { return false; }
  })();
  const steps = () => onboardingSteps(props.status(), props.pairing(), props.trustAck());
  const stage = () => onboardingStage(steps());
  // On a phone the only target is your node (there is no "This Mac").
  const [internalTarget, setInternalTarget] = createSignal<NodeTarget>((props.phone ?? props.mobile === true) ? 'network' : 'local');
  const target = () => props.selectedTarget ?? internalTarget();
  const setTarget = (t: NodeTarget) => {
    setInternalTarget(t);
    props.onTargetChange?.(t);
  };
  const isEnrolled = () => props.device?.()?.state === 'registered';
  const mobileBiometrics = () => props.mobile ?? props.onScanRemote !== undefined;
  /** Running on a phone or tablet (Android or iOS, from isMobilePlatform): there is no "This Mac" to choose. */
  const phone = () => props.phone ?? props.mobile === true;
  const [approvalsSkipped, setApprovalsSkipped] = createSignal(false);
  const [remoteLink, setRemoteLink] = createSignal('');
  const [previewing, setPreviewing] = createSignal(false);
  const [preview, setPreview] = createSignal<{ link: string; view: RemotePreviewView } | null>(null);
  const [importing, setImporting] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [forgetting, setForgetting] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [remoteRevision, setRemoteRevision] = createSignal(0);
  const [remoteChoiceEdited, setRemoteChoiceEdited] = createSignal(false);
  const [importResult, setImportResult] = createSignal<RemoteImportView | null>(null);
  const [importError, setImportError] = createSignal<string | null>(null);
  const busy = () => importing() || previewing() || scanning() || forgetting() || confirming();
  usePairingActivity(() => busy() || remoteLink().length > 0 || preview() !== null || importResult() !== null);
  createEffect(() => props.onBusyChange?.(busy()));
  const editLink = (link: string) => {
    if (busy()) return;
    setPreview(null);
    setImportResult(null);
    setRemoteLink(link);
  };
  const prefill = (link: string) => {
    setPreview(null);
    setImportResult(null);
    setRemoteLink('');
    setImportError(null);
    try { setRemoteLink(normalizePairingLink(link)); }
    catch (error) { setImportError(String(error)); }
  };
  onMount(() => {
    if (props.initialPairingLink !== undefined) prefill(props.initialPairingLink);
  });
  // A link saved this session wins over the running node's; forgetting reverts.
  const [savedHostedBy, setSavedHostedBy] = createSignal<string | null | undefined>(undefined);
  const hostedBy = () => {
    const saved = savedHostedBy();
    return saved !== undefined ? saved : props.pairing().hosted_by ?? null;
  };

  const importRemote = async (event: Event) => {
    event.preventDefault();
    if (busy()) return;
    const reviewed = preview();
    setImportError(null);
    setImportResult(null);
    if (!reviewed || reviewed.link !== remoteLink()) {
      setPreview(null);
      setPreviewing(true);
      try {
        const link = normalizePairingLink(remoteLink());
        if (!props.onPreviewRemote) throw new Error('Pairing preview is unavailable. Nothing was saved.');
        const view = await props.onPreviewRemote(link);
        // Keep the normalized, parsed ticket as the sole confirmation authority.
        setRemoteLink(link);
        setPreview({ link, view });
      } catch (error) {
        setRemoteLink('');
        setImportError(String(error));
      } finally { setPreviewing(false); }
      return;
    }
    if (props.confirmImport) {
      setConfirming(true);
      let confirmed = false;
      try { confirmed = await props.confirmImport(reviewed.view); }
      catch { confirmed = false; }
      finally { setConfirming(false); }
      // Cancel, or a link edited meanwhile, saves nothing.
      if (!confirmed || preview() !== reviewed || remoteLink() !== reviewed.link) return;
    }
    setImporting(true);
    setRemoteLink('');
    setPreview(null);
    try {
      if (!props.onImportRemote) throw new Error('Remote access import is unavailable.');
      const result = await props.onImportRemote(reviewed.link);
      setRemoteRevision(n => n + 1);
      setRemoteChoiceEdited(true);
      setSavedHostedBy(result.hosted_by ?? null);
      setImportResult(result);
    } catch (error) {
      setImportError(String(error));
    } finally { setImporting(false); }
  };

  const scanRemote = async () => {
    if (busy() || !props.onScanRemote) return;
    setPreview(null);
    setScanning(true);
    setRemoteLink('');
    setImportResult(null);
    setImportError(null);
    try { prefill(await props.onScanRemote()); }
    catch {
      // Native errors may contain scanner input. Never display or log them.
      setImportError('Scanning did not complete. Allow camera access to scan a pairing QR code, or paste the link instead.');
    } finally { setScanning(false); }
  };

  const forgetRemote = async () => {
    if (busy()) return;
    setPreview(null);
    setRemoteLink('');
    setForgetting(true);
    try {
      await props.onForgetRemote!();
      setRemoteChoiceEdited(true);
      setSavedHostedBy(undefined);
      setImportResult(null);
      setImportError(null);
    } finally { setForgetting(false); }
  };

  return (
    <section class="onboarding" aria-label={props.formOnly ? 'Pair another node' : 'First-run setup'} data-stage={stage()}>
      <Show when={!props.formOnly}>
      <ol class="steps stepper" aria-label="Setup progress">
        <For each={steps()}>
          {(step) => (
            <li class={`step ${step.status}`} classList={{ joined: step.id === 'pair' }} data-step={step.id} data-status={step.status}>
              <span class="pip" aria-hidden="true" />
              {/* Node and pair read as one stage: two pips, one label after both. */}
              <span class="step-label" classList={{ 'sr-only': step.id === 'node' }}>
                <Show when={step.id === 'pair'}><span class="sr-only">{STEP_LABEL.pair}: </span></Show>
                {step.id === 'pair' ? STEP_LABEL.node : step.id === 'node' ? 'Start node' : STEP_LABEL[step.id]}
                <Show when={step.id === 'fund'}><span class="step-optional"> (optional)</span></Show>
              </span>
              <Show when={STATUS_TEXT[step.status]}>
                {/* Progress pips say now/done; waiting and failure are said in words. */}
                <span class="step-status" classList={{ 'sr-only': !['failed', 'blocked', 'skipped'].includes(step.status) }}>{STATUS_TEXT[step.status]}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>

      <Show
        when={stage() === 'node'}
        fallback={
          <header class="ob-head" data-ob-head="trust">
            {/* Named like its step: the stepper above says "Your identity". */}
            <h1>Your identity</h1>
            <Show
              when={!props.pairing().bootstrap}
              fallback={<Show when={props.status().local_owner && !props.pairing().remote} fallback={<p class="lede">Your node has no identity yet. {props.pairing().remote ? "Restore it at your node before adding sats." : "Restore your existing identity on this Mac before adding sats."} Creating a new identity from this screen is not available yet.</p>}><p class="lede">Create your identity below, write down its recovery phrase, and confirm this Mac with Touch ID before adding sats.</p></Show>}
            >
              <p class="lede">Read how your node is trusted. If you already have a BitSov identity, restore it now, before any sats arrive.</p>
            </Show>
          </header>
        }
      >
        <header class="ob-head" data-ob-head="node">
          <Show when={target() !== 'local'}><BoxIllustration /></Show>
          <h1>{phone() ? 'Connect this phone to your node' : 'Where should your node run?'}</h1>
          <p class="lede">{phone()
            ? 'Every message you send is a small bitcoin payment to the person you are writing to. Your node makes those payments; this phone connects to it.'
            : 'Every message you send is a small bitcoin payment to the person you are writing to. Your node makes those payments, so it needs a home first.'}</p>
        </header>
      </Show>

      {/* Node location: this Mac first; compact once the node is up */}
      <div class="node-target-section" classList={{ compact: stage() !== 'node' }}>
        <h2 class="node-target-title" classList={{ 'sr-only': stage() === 'node' }}>Where your node runs</h2>
        <div class="node-target-grid" role="radiogroup" aria-label="Choose node location">
          {/* Option 1: This computer (local node). A phone has no node of its own to run. */}
          <Show when={!phone()}>
          <button
            type="button"
            class="node-target-card"
            classList={{ selected: target() === 'local' }}
            role="radio"
            aria-checked={target() === 'local'}
            onClick={() => setTarget('local')}
            data-target="local"
          >
            <div class="target-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div class="target-info">
              <div class="target-head">
                <strong>This Mac</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge ok">Keys on this Mac</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>BitSov runs your node on this Mac. Your keys stay here. To receive messages and payments, this Mac must stay awake and BitSov must stay open.</p>
              <p class="hint" data-local-only>Only this Mac can use it. To use BitSov on your phone too, choose a node you run on a computer or server that stays on.</p>
            </div>
          </button>
          </Show>

          {/* Joining from another owner device is a first-run path of its own: not hidden behind Advanced. */}
          <Show when={!phone() && stage() === 'node' && target() === 'local'}>
            <p class="hint" data-join-from-device>
              Joining from another device?{' '}
              <button type="button" class="link" data-join-open onClick={() => setTarget('network')}>Scan or paste its ticket</button>
            </p>
          </Show>
          {/* Once the node is up the choice is compact: both locations show as pills, no fold. */}
          <details class="node-target-advanced" open={phone() || target() !== 'local' || stage() !== 'node'}>
            <Show when={!phone()}><summary>Advanced: use a node you already run at home</summary></Show>
          {/* A home node uses a remote pairing link. */}
          <button
            type="button"
            class="node-target-card"
            classList={{ selected: target() === 'network' }}
            role="radio"
            aria-checked={target() === 'network'}
            onClick={() => setTarget('network')}
            data-target="network"
          >
            <div class="target-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="2" y="2" width="20" height="8" rx="2" />
                <rect x="2" y="14" width="20" height="8" rx="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" />
                <line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </div>
            <div class="target-info">
              <div class="target-head">
                <strong>{phone() ? 'Your node' : 'Your computer at home'}</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <Show when={hostedBy()} fallback={<span class="target-badge">Pairing link</span>}>
                    {(label) => (
                      <span class="target-badge hosted-by" data-hosted-by title={`Hosted by ${label()}`}>
                        Hosted by <bdi>{label()}</bdi>
                      </span>
                    )}
                  </Show>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>{phone()
                ? 'A computer or server that stays on runs your node; its keys live there. Scan or paste its pairing link to connect this phone.'
                : 'A computer you keep running at home can receive while this Mac is off. Its keys live on that computer. Paste its pairing link; it is saved for the next start.'}</p>
            </div>
          </button>

          </details>

          <Show when={testNodes}>
          {/* Internal testing only; not a product path. */}
          <button
            type="button"
            class="node-target-card"
            classList={{ selected: target() === 'cloud' }}
            role="radio"
            aria-checked={target() === 'cloud'}
            onClick={() => setTarget('cloud')}
            data-target="cloud"
          >
            <div class="target-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
              </svg>
            </div>
            <div class="target-info">
              <div class="target-head">
                <strong>Test node someone else runs (internal)</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge">Pairing link</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>Not your keys. Whoever runs this machine can spend its bitcoin and read its messages. For internal testing only.</p>
            </div>
          </button>
          </Show>
        </div>
        <p class="hint connect-line">
          {props.pairing().remote ? 'This app connects to your remote node.' : phone() ? 'This phone is not connected to a node yet.' : 'This app connects to the node on this Mac.'}
          <Show when={!props.pairing().remote && target() !== 'local'}> A saved pairing link takes effect at the next start.</Show>
          <Show when={isEnrolled()}>
            {mobileBiometrics()
              ? ' Biometrics on this phone can approve a contact or budget.'
              : ' Touch ID on this Mac can approve a contact or budget.'}
          </Show>
        </p>
      </div>

      {/* "Use this Mac instead" means nothing on a phone. */}
      <Show when={!phone() && props.onForgetRemote && (props.pairing().remote || target() !== 'local' || remoteChoiceEdited())}>
        <LocalNodeSwitch onForget={forgetRemote} disabled={busy()} remoteRevision={remoteRevision()} />
      </Show>

      <Switch>
        <Match when={props.pairing().state === 'pending'}>
          <div class="panel pairing" data-pairing="pending">
            <div class="touchid-hero">
              <div class="touchid-badge-pulse">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 12c0-3 2.5-5 5-5" />
                  <path d="M12 12c0 3-2.5 5-5 5" />
                  <path d="M7 12c0-2.8 2.2-5 5-5s5 2.2 5 5-2.2 5-5 5" />
                  <path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5" />
                  <path d="M21.2 15c.5-1 .8-2 .8-3a10 10 0 0 0-10-10" />
                </svg>
              </div>
              <div>
                <h2>{props.pairing().remote ? 'Connecting to your node…' : 'Pairing this app with your node…'}</h2>
                <p>Establishing an authenticated pairing between this app and your node.</p>
                <Show when={isEnrolled()}>
                  <p class="hint">
                    {mobileBiometrics()
                      ? 'Biometric approvals are already set up on this phone; pairing does not create that key.'
                      : 'Touch ID approvals are already set up on this Mac; pairing does not create that key.'}
                  </p>
                </Show>
              </div>
            </div>
            <Show when={!props.pairing().remote} fallback={<p class="hint">Waiting for the encrypted connection to your node.</p>}>
              <p class="hint">
                The app proves it can read your node’s data folder by signing a one-time
                challenge the node wrote there.
              </p>
            </Show>
          </div>
        </Match>

        <Match when={props.pairing().state === 'paired'}>
          <div class="panel pairing" data-pairing="paired">
            <div class="touchid-hero paired">
              <Show when={props.pairing().remote} fallback={
                <div class="touchid-badge ok">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 12c0-3 2.5-5 5-5" />
                    <path d="M12 12c0 3-2.5 5-5 5" />
                    <path d="M7 12c0-2.8 2.2-5 5-5s5 2.2 5 5-2.2 5-5 5" />
                    <path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5" />
                    <path d="M21.2 15c.5-1 .8-2 .8-3a10 10 0 0 0-10-10" />
                  </svg>
                  <span class="touchid-check">✓</span>
                </div>
              }><BoxIllustration paired /></Show>
              <div class="touchid-text">
                <h2>{props.pairing().remote ? 'Paired with your box' : 'This app is paired'}</h2>
                <Show
                  when={isEnrolled()}
                  fallback={<span class="touchid-status-pill" data-device-badge="none">{props.status().local_owner && !props.pairing().bootstrap ? "Owner device not enrolled" : "App paired"}</span>}
                >
                  <span class="touchid-status-pill" data-device-badge="registered">
                    {mobileBiometrics()
                      ? 'Biometrics Enrolled · Android Keystore'
                      : 'Touch ID Enrolled · Secure Enclave'}
                  </span>
                </Show>
                <p class="hint" style={{ margin: '4px 0 0' }} data-pairing-plain>
                  {props.pairing().remote ? 'This app reaches your box over an encrypted connection.' : 'This app talks only to the node on this Mac.'}
                </p>
              </div>
            </div>

            {/* What this app may do stays in view (not behind the details). */}
            <p class="pairing-access">
              Access: <strong>{scopeList(props.pairing().scopes)}</strong>
            </p>


            <Show when={props.pairing().bootstrap}>
              <p class="hint" data-identity-free>
                Your node is identity-free (fresh install). {props.status().local_owner && !props.pairing().remote ? "Create your identity with the owner setup below." : props.pairing().remote ? "Set up your box with the owner setup below." : "You can restore an existing identity on this Mac."} Nothing has been created yet.
              </p>
            </Show>

            {/* Progressive disclosure: technical codes & tripwires kept under summary */}
            <details class="pairing-details">
              <summary>Pairing verification & security details</summary>
              <div class="pairing-details-body">
                <Show
                  when={props.pairing().remote}
                  fallback={
                    <Show
                      when={isEnrolled()}
                      fallback={<p class="hint" style={{ margin: '4px 0 0' }}>Loopback authenticated. Ordinary pairing is file-backed on this Mac.</p>}
                    >
                      <p class="hint" style={{ margin: '4px 0 0' }}>
                        Loopback authenticated. Touch ID on this Mac can approve a contact or budget; it does not sign every payment.
                      </p>
                    </Show>
                  }
                >
                  <p class="hint" style={{ margin: '4px 0 0' }}>
                    This app is paired with a remote node over a pinned encrypted connection;
                    the local proxy only accepts this app’s credential.
                  </p>
                </Show>
                <Show when={props.pairing().short_code}>
                  <p class="short-code" data-short-code>
                    Pairing code <code>{props.pairing().short_code}</code>
                    <Show
                      when={props.pairing().code_from_node}
                      fallback={<span> — derived from the challenge; compare it with what your node printed.</span>}
                    >
                      <span> — matches what your node printed.</span>
                    </Show>
                  </p>
                  <p class="hint">
                    The code is a tripwire: a mismatch means something is wrong. It is not what
                    keeps other programs out — this app reads your node’s output itself.
                  </p>
                </Show>
                <p class="hint">
                  A packaged app like this one cannot spend and cannot replace a live identity. To
                  spend, run the node yourself and grant it with the owner CLI on that machine.
                </p>
                <p class="hint">Less exposure, not solved local security.</p>
              </div>
            </details>
          </div>
        </Match>

        <Match when={props.pairing().state === 'failed'}>
          <div class="panel pairing error" data-pairing="failed">
            <h2>Pairing failed</h2>
            <SoftError message={props.pairing().reason ?? 'Pairing failed.'} summary="We could not pair this app with your node." detailNote="The app did not fall back to the older unpaired login. Check that your node is the one this app started, then reconnect." onReconnect={props.onRetry} />
          </div>
        </Match>

        <Match when={props.pairing().state === 'fallback'}>
          <div class="panel pairing" data-pairing="fallback">
            <h2>Pairing not available on this node</h2>
            <p class="hint">
              This older node has no pairing routes, so this app signs in with the
              local loopback token (/auth/local). Upgrade the node to use pairing.
            </p>
          </div>
        </Match>
      </Switch>

      {/* Touch ID approvals belong to setup, right after pairing (they used to live only in + New). */}
      <Show when={props.onRegisterDevice && props.onCancelDevice && props.pairing().state === 'paired' && stage() !== 'node' && !approvalsSkipped()}>
        <DeviceApprovals
          device={props.device?.() ?? null}
          joinDevice={props.joinDevice}
          remote={props.pairing().remote}
          mobile={mobileBiometrics()}
          onRegister={props.onRegisterDevice!}
          onCancel={props.onCancelDevice!}
          onSkip={() => setApprovalsSkipped(true)}
        />
      </Show>
      </Show>

      <Show when={target() !== 'local'}>
      <form class="panel pairing remote-form" data-remote-access onSubmit={importRemote}>
        <h2>{props.onScanRemote ? 'Scan or paste the pairing link' : 'Paste the pairing link'}</h2>
        <p class="hint">To join from another owner device, open Settings → Devices → Add a device there, then scan or paste its ticket here.</p>
        <p class="hint">After a power cut, open the app once. Your password is never stored on the box.</p>
        <Show when={props.onScanRemote}>
          <p class="hint">BitSov uses the camera to read your node’s pairing QR code. You can paste instead. Nothing is saved until you choose Use remote node.</p>
          <button
            type="button"
            class="quiet"
            data-scan-pairing-qr
            disabled={busy()}
            onClick={() => void scanRemote()}
          >
            {scanning() ? 'Scanning…' : 'Scan pairing QR'}
          </button>
        </Show>
        <label for={props.pairingInputId ?? 'remote-pairing-link'}>Pairing link</label>
        <input
          id={props.pairingInputId ?? 'remote-pairing-link'}
          type="password"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          disabled={busy()}
          value={remoteLink()}
          onInput={(event) => editLink(event.currentTarget.value)}
          placeholder="bitsov://pair/…"
        />
        <Show when={preview()}>{review => (
          <div class="panel" data-pairing-preview role="status">
            <p>Pair with endpoint: <bdi>{review().view.endpoint}</bdi></p>
            <p>Node ID fingerprint: <bdi>{review().view.node_id_fingerprint}</bdi></p>
            <Show when={review().view.hosted_by}>{label => <p>Hosted by <bdi>{label()}</bdi></p>}</Show>
            <p>Compare these details with your node before confirming.</p>
          </div>
        )}</Show>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={busy()}>
            {importing() ? 'Saving…' : previewing() ? 'Checking ticket…' : preview() ? 'Use remote node' : 'Review pairing ticket'}
          </button>
          <Show when={remoteLink() || preview() || importResult()}>
            <button type="button" class="quiet" data-cancel-pairing-review disabled={busy()} onClick={() => editLink('')}>Close ticket review</button>
          </Show>
        </div>
        <p class="hint">The link is verified and stored for the next app start.</p>
        <Show when={importResult()}>
          {(result) => (
            <p class="ok-note" data-import-result>
              Remote node {result().endpoint}
              <Show when={result().hosted_by}>
                {(label) => <> (hosted by <bdi data-hosted-by>{label()}</bdi>)</>}
              </Show>
              {' '}saved. Node ID fingerprint: {result().node_id_fingerprint}. Restart BitSov to connect.
            </p>
          )}
        </Show>
        <Show when={importError()}>
          <SoftError message={importError()!} />
        </Show>
      </form>
      </Show>
    </section>
  );
}
