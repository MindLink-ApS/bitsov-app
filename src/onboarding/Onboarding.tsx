import { t, type CopyKey } from '../i18n';
import { deviceWord, isMobilePlatform } from '../platform';
import type { JoinInput, JoinView } from './AddDevice';
import { BoxIllustration } from './BoxIllustration';
import { LocalNodeSwitch } from './LocalNodeSwitch';
import { LocalNodeSetup } from './LocalNodeSetup';
import { DeviceApprovals } from './DeviceApprovals';
import { SoftError } from '../control/SoftError';
import { softenError } from '../control/userFacing';
import { createEffect, createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { normalizePairingLink, onboardingDiagnostic, pairingProblem, withoutErrorPrefix, type PairingProblem, onboardingSteps, scopeList, SECURE_STORAGE_KEPT, type NodeStatus, type PairingView } from './pairing';
import type { DeviceView } from '../control/types';
import type { RemoteImportView, RemotePreviewView } from '../control/source';
import { usePairingActivity } from '../pairingActivity';

// Claim discipline (BitSov-bitsov docs/security/pairing.md): less exposure, not solved
// local security. The short code is a tripwire, never described as what protects the
// pairing — in the sidecar deployment this app reads the node's stdout by construction.

const STATUS_TEXT = {
  todo: null,
  active: 'obNow',
  done: 'obDone',
  failed: 'obFailed',
  skipped: 'obUnavailableNode',
  blocked: 'obUnavailableHere',
} satisfies Record<string, CopyKey | null>;

export type NodeTarget = 'local' | 'network' | 'cloud';

/** Three stages the owner sees; the four host steps map onto them. */
export type Stage = 'node' | 'identity' | 'fund';
const STEP_LABEL = { node: 'obYourNode', pair: 'obPairApp', identity: 'obYourIdentity', fund: 'obAddSats' } as const;

export function onboardingStage(steps: { id: string; status: string }[]): Stage {
  const by = (id: string) => steps.find((s) => s.id === id)?.status;
  const settled = (st?: string) => st === 'done' || st === 'skipped';
  // A phone has no node step: only pairing gates the first stage there.
  const node = by('node');
  if ((node !== undefined && !settled(node)) || !settled(by('pair'))) return 'node';
  return by('identity') === 'done' ? 'fund' : 'identity';
}

export function Onboarding(props: {
  status: () => NodeStatus;
  pairing: () => PairingView;
  trustAck: () => boolean;
  onRetry: () => void;
  /** Fresh Mac only: the owner's explicit choice to create a node here. */
  onSetupLocal?: () => Promise<void>;
  selectedTarget?: NodeTarget;
  onTargetChange?: (target: NodeTarget) => void;
  device?: () => DeviceView | null;
  joinDevice?: (input: JoinInput) => Promise<JoinView>;
  onForgetRemote?: () => Promise<void>;
  onPreviewRemote?: (link: string) => Promise<RemotePreviewView>;
  onBusyChange?: (busy: boolean) => void;
  onImportRemote?: (link: string) => Promise<RemoteImportView>;
  onScanRemote?: () => Promise<string>;
  /** Mobile wording (Android or iOS), independent of scanner capability. */
  mobile?: boolean;
  /** A phone or tablet build (Android or iOS). Defaults to the runtime platform. */
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
  const steps = () => onboardingSteps(props.status(), props.pairing(), props.trustAck(), phone());
  const stage = () => onboardingStage(steps());
  // On a phone the only target is your node (there is no "This Mac").
  const phone = () => props.phone ?? props.mobile ?? isMobilePlatform();
  const mobileBiometrics = () => props.mobile ?? isMobilePlatform();
  const device = () => deviceWord() === 'iPad' ? 'iPad' : t('obPhone');
  const [internalTarget, setInternalTarget] = createSignal<NodeTarget>(
    phone() || props.pairing().remote || props.initialPairingLink !== undefined ? 'network' : 'local',
  );
  const localUnavailable = () => props.status().network_refusal === 'local_unavailable';
  const target = () => localUnavailable() ? 'network' : props.selectedTarget ?? internalTarget();
  const setTarget = (t: NodeTarget) => {
    setInternalTarget(t);
    props.onTargetChange?.(t);
  };
  const isEnrolled = () => props.device?.()?.state === 'registered';
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
  const [importError, setImportError] = createSignal<PairingProblem | null>(null);
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
    catch (error) { setImportError(pairingProblem(error)); }
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
        if (!props.onPreviewRemote) throw new Error(t('obPreviewUnavailable'));
        const view = await props.onPreviewRemote(link);
        // Keep the normalized, parsed ticket as the sole confirmation authority.
        setRemoteLink(link);
        setPreview({ link, view });
      } catch (error) {
        setRemoteLink('');
        setImportError(pairingProblem(error));
      } finally { setPreviewing(false); }
      return;
    }
    if (phone() && reviewed.view.first_run) return;
    if (props.confirmImport) {
      setConfirming(true);
      let confirmed = false;
      try { confirmed = await props.confirmImport(reviewed.view); }
      catch { confirmed = false; }
      finally { setConfirming(false); }
      // Cancel, or a link edited meanwhile, saves nothing.
      if (!confirmed || preview() !== reviewed || remoteLink() !== reviewed.link) return;
    }
    // Keep the reviewed ticket in this screen until connect succeeds. Native
    // inbox receipts are take-once, so a retry must not depend on another tap.
    setImporting(true);
    try {
      if (!props.onImportRemote) throw new Error(t('obImportUnavailable'));
      const result = await props.onImportRemote(reviewed.link);
      setRemoteLink('');
      setPreview(null);
      setRemoteRevision(n => n + 1);
      setRemoteChoiceEdited(true);
      setSavedHostedBy(result.hosted_by ?? null);
      setImportResult(result);
    } catch (error) {
      setImportError(pairingProblem(error));
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
      setImportError({ text: t('obScanFailed'), known: true });
    } finally { setScanning(false); }
  };

  // After a refusal: scan (or paste) a new link from an owner device. The saved
  // link stays until the new one is reviewed and saved.
  const pairAgain = async () => {
    if (busy()) return;
    if (props.onScanRemote) return scanRemote();
    document.getElementById(props.pairingInputId ?? 'remote-pairing-link')?.focus();
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
    <section class="onboarding" aria-label={props.formOnly ? t('obPairAnother') : t('obFirstRun')} data-stage={stage()}>
      <Show when={!props.formOnly}>
      <ol class="steps stepper" aria-label={t('obSetupProgress')}>
        <For each={steps()}>
          {(step) => (
            <li class={`step ${step.status}`} classList={{ joined: step.id === 'pair' && !phone() }} data-step={step.id} data-status={step.status}>
              <span class="pip" aria-hidden="true" />
              {/* Node and pair read as one stage: two pips, one label after both. */}
              <span class="step-label" classList={{ 'sr-only': step.id === 'node' }}>
                <Show when={step.id === 'pair'}><span class="sr-only">{t(STEP_LABEL.pair)}: </span></Show>
                {t(step.id === 'pair' ? STEP_LABEL.node : step.id === 'node' ? 'obStartNode' : STEP_LABEL[step.id])}
                <Show when={step.id === 'fund'}><span class="step-optional"> {t('obOptional')}</span></Show>
              </span>
              <Show when={STATUS_TEXT[step.status]}>
                {/* Progress pips say now/done; waiting and failure are said in words. */}
                <span class="step-status" classList={{ 'sr-only': !['failed', 'blocked', 'skipped'].includes(step.status) }}>{t(STATUS_TEXT[step.status]!)}</span>
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
            <h1>{phone() && !props.pairing().bootstrap ? t('obPhoneAlmostDone') : t('obYourIdentity')}</h1>
            <Show
              when={!props.pairing().bootstrap}
              fallback={<Show when={props.status().local_owner && !props.pairing().remote} fallback={<p class="lede">{t('obNoIdentity')}{' '}{props.pairing().remote ? t('obRestoreAtNode') : t('obRestoreOnMac')} {t('obCreateNotAvailable')}</p>}><p class="lede">{t('obCreateIdentityBelow')}</p></Show>}
            >
              <p class="lede">{phone() ? t('obPhoneTrustLede') : t('obReadTrust')}</p>
            </Show>
          </header>
        }
      >
        <header class="ob-head" data-ob-head="node">
          <Show when={target() !== 'local'}><BoxIllustration /></Show>
          <h1>{phone() ? t('obConnectDevice', device()) : t('obWhereNode')}</h1>
          <p class="lede">{phone()
            ? t('obDevicePayments', device())
            : t('obPaymentsNeedHome')}</p>
        </header>
      </Show>

      {/* Both node locations are first-class choices; compact once the node is up. */}
      <div class="node-target-section" classList={{ compact: stage() !== 'node' }}>
        <h2 class="node-target-title" classList={{ 'sr-only': stage() === 'node' }}>{t('obNodeLocation')}</h2>
        <div class="node-target-grid" role="radiogroup" aria-label={t('obChooseLocation')}>
          {/* Option 1: This computer (local node). A phone has no node of its own to run. */}
          <Show when={!phone() && !localUnavailable()}>
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
                <strong>{t('obThisMac')}</strong>
                <div class="row" style={{ width: 'auto', gap: 'var(--s-2)' }}>
                  <span class="target-badge">{t('obKeysOnMac')}</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>{t('obMacNodeHint')}</p>
              <p class="hint" data-local-only>{t('obMacOnlyHint')}</p>
            </div>
          </button>
          </Show>

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
                <strong>{localUnavailable() ? t('obBetaConnectSignet') : phone() ? t('obYourNode') : t('obComputerAtHome')}</strong>
                <div class="row" style={{ width: 'auto', gap: 'var(--s-2)' }}>
                  <Show when={hostedBy()} fallback={<span class="target-badge">{t('obPairingLink')}</span>}>
                    {(label) => (
                      <span class="target-badge hosted-by" data-hosted-by title={t('obHostedByName', label())}>
                        {t('obHostedBy')}{' '}<bdi>{label()}</bdi>
                      </span>
                    )}
                  </Show>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>{phone()
                ? t('obHomeNodeConnect', props.onScanRemote ? t('obScanOrPaste') : t('obPaste'), device())
                : t('obHomeComputerHint')}</p>
            </div>
          </button>

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
                <strong>{t('obInternalTestNode')}</strong>
                <div class="row" style={{ width: 'auto', gap: 'var(--s-2)' }}>
                  <span class="target-badge">{t('obPairingLink')}</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>{t('obTestNodeWarning')}</p>
            </div>
          </button>
          </Show>
        </div>
        {/* Joining from another owner device is a first-run path of its own: directly accessible. */}
        <Show when={!phone() && stage() === 'node' && target() === 'local'}>
          <p class="hint" data-join-from-device>
            {t('obJoiningAnotherDevice')}{' '}
            <button type="button" class="link" data-join-open onClick={() => setTarget('network')}>{t('obScanPasteTicket')}</button>
          </p>
        </Show>

        <p class="hint connect-line">
          {props.pairing().remote ? t('obConnectsRemote') : phone() ? t('obDeviceNotConnected', device()) : t('obConnectsMac')}
          <Show when={!props.pairing().remote && target() !== 'local'}> {phone() ? t('obDeviceConnectsOnSave', device()) : t('obLinkNextStart')}</Show>
          <Show when={isEnrolled()}>
            {mobileBiometrics()
              ? t('obDeviceApproves', device())
              : t('obTouchIdContactBudget')}
          </Show>
        </p>
      </div>

      {/* "Use this Mac instead" means nothing on a phone. */}
      <Show when={!phone() && !localUnavailable() && props.onForgetRemote && (props.pairing().remote || target() !== 'local' || remoteChoiceEdited())}>
        <LocalNodeSwitch onForget={forgetRemote} disabled={busy()} remoteRevision={remoteRevision()} />
      </Show>

      <Show when={!phone() && !localUnavailable() && props.onSetupLocal && props.status().local_setup_needed && !props.pairing().remote && target() === 'local'}>
        <LocalNodeSetup onConfirm={props.onSetupLocal!} />
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
                <h2>{props.pairing().remote ? t('obConnectingNode') : t('obPairingNode')}</h2>
                <p>{t('obEstablishingPairing')}</p>
                <Show when={isEnrolled()}>
                  <p class="hint">
                    {mobileBiometrics()
                      ? t('obBiometricsAlreadySetup', device())
                      : t('obTouchIdAlreadySetup')}
                  </p>
                </Show>
              </div>
            </div>
            <Show when={!props.pairing().remote} fallback={<p class="hint">{t('obWaitingEncrypted')}</p>}>
              <p class="hint">
                {t('obFileChallenge')}</p>
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
                <h2>{props.pairing().remote ? t('obPairedBox') : t('obAppIsPaired')}</h2>
                <Show
                  when={isEnrolled()}
                  fallback={<span class="touchid-status-pill" data-device-badge="none">{props.status().local_owner && !props.pairing().bootstrap ? t('obOwnerNotEnrolled') : t('obAppPaired')}</span>}
                >
                  <span class="touchid-status-pill" data-device-badge="registered">
                    {mobileBiometrics()
                      ? t('obBiometricsEnabled')
                      : t('obTouchIdEnrolled')}
                  </span>
                </Show>
                <p class="hint" style={{ margin: '4px 0 0' }} data-pairing-plain>
                  {props.pairing().remote ? t('obEncryptedBox') : t('obOnlyMacNode')}
                </p>
              </div>
            </div>

            {/* What this app may do stays in view (not behind the details). A phone keeps it in the details. */}
            <p class="pairing-access" hidden={phone()}>
              {t('obAccess')}{' '}<strong>{scopeList(props.pairing().scopes)}</strong>
            </p>


            <Show when={props.pairing().bootstrap}>
              <p class="hint" data-identity-free>
                {t('obFreshIdentity')}{' '}{props.status().local_owner && !props.pairing().remote ? t('obCreateOwnerBelow') : props.pairing().remote ? t('obSetupBoxBelow') : t('obCanRestoreMac')} {t('obNothingCreated')}</p>
            </Show>

            {/* Progressive disclosure: technical codes & tripwires kept under summary */}
            <details class="pairing-details">
              <summary>{t('obPairingDetails')}</summary>
              <div class="pairing-details-body">
                <Show
                  when={props.pairing().remote}
                  fallback={
                    <Show
                      when={isEnrolled()}
                      fallback={<p class="hint" style={{ margin: '4px 0 0' }}>{t('obLoopbackFile')}</p>}
                    >
                      <p class="hint" style={{ margin: '4px 0 0' }}>
                        {t('obLoopbackTouchId')}</p>
                    </Show>
                  }
                >
                  <p class="hint" style={{ margin: '4px 0 0' }}>
                    {t('obPinnedConnection')}</p>
                </Show>
                <Show when={props.pairing().short_code}>
                  <p class="short-code" data-short-code>
                    {t('obPairingCode')}{' '}<code>{props.pairing().short_code}</code>
                    <Show
                      when={props.pairing().code_from_node}
                      fallback={<span> {t('obCodeDerived')}</span>}
                    >
                      <span> {t('obCodeMatches')}</span>
                    </Show>
                  </p>
                  <p class="hint">
                    {t('obCodeTripwire')}</p>
                </Show>
                <p class="hint">
                  {t('obPackagedAppLimits')}</p>
                <p class="hint">{t('obLocalSecurityLimit')}</p>
              </div>
            </details>
          </div>
        </Match>

        {/* No Secure Enclave on this Mac: permanent, so there is no Try again. */}
        <Match when={props.pairing().state !== 'paired' && props.status().connection_error?.kind === 'secure_storage_unavailable'}>
          <div class="panel pairing error" data-pairing="secure-storage-unavailable">
            <h2>{t('obPairingFailedTitle')}</h2>
            <p class="err-note" role="alert">{t('pairing.secureStorageUnavailable')}</p>
            <Show when={props.status().connection_error?.detail === SECURE_STORAGE_KEPT}>
              <p class="hint">{t('pairing.secureStorageKept')}</p>
            </Show>
          </div>
        </Match>

        {/* A definitive refusal: one way forward, and no Try again that cannot help. */}
        <Match when={props.pairing().state === 'failed' && props.pairing().refused}>
          <div class="panel pairing error" data-pairing="refused">
            <h2>{t('obRefusedTitle')}</h2>
            <p class="err-note" role="alert" data-refused-summary>{t('obRefusedLine')}</p>
            <p class="hint">{props.onScanRemote ? t('obRefusedHow') : t('obRefusedHowPaste')}</p>
            <button type="button" class="primary" data-pair-again disabled={busy()} onClick={() => void pairAgain()}>
              {scanning() ? t('obScanning') : props.onScanRemote ? t('obScanNewQr') : t('obPasteNewLink')}
            </button>
            <Show when={props.pairing().reason}>{reason => (
              <details class="quiet-detail" data-soft-detail>
                <summary>{t('uiDetails')}</summary>
                <p class="hint">{onboardingDiagnostic(reason(), t('obPairingLinkHelp'))}</p>
              </details>
            )}</Show>
          </div>
        </Match>

        <Match when={props.pairing().state === 'failed'}>
          <div class="panel pairing error" data-pairing="failed">
            <h2>{t('obPairingFailedTitle')}</h2>
            <SoftError message={onboardingDiagnostic(props.pairing().reason ?? t('obPairingFailed'), t('obPairingLinkHelp'))} summary={t('obCouldNotPair')} detailNote={t('obNoFallback')} onReconnect={props.onRetry} />
          </div>
        </Match>

        <Match when={props.pairing().state === 'fallback'}>
          <div class="panel pairing" data-pairing="fallback">
            <h2>{t('obPairingUnavailable')}</h2>
            <p class="hint">
              {t('obOlderNode')}</p>
          </div>
        </Match>
      </Switch>

      <Show when={approvalsSkipped() && props.pairing().state === 'paired' && !isEnrolled()}>
        <p class="hint" data-device-approvals-deferred>
          {t('approvalSetupReason')}{' '}
          <button type="button" class="link" data-device-approvals-later onClick={() => setApprovalsSkipped(false)}>
            {t(mobileBiometrics() ? 'obSetupBiometrics' : 'obSetupTouchId')}
          </button>
        </p>
      </Show>
      {/* Touch ID approvals belong to setup, right after pairing (they used to live only in + New). */}
      {/* A phone sets up approvals later, in Settings; its first run ends at the trust step. */}
      <Show when={!phone() && props.onRegisterDevice && props.onCancelDevice && props.pairing().state === 'paired' && stage() !== 'node' && !approvalsSkipped()}>
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
        <h2>{props.onScanRemote ? t('obScanPasteLink') : t('obPasteLink')}</h2>
        <p class="hint">{t('obJoinFromOwner')}</p>
        <p class="hint">{t('obAfterPowerCut')}</p>
        <Show when={props.onScanRemote}>
          <p class="hint">{t('obCameraPurpose')}</p>
          <button
            type="button"
            class="quiet"
            data-scan-pairing-qr
            disabled={busy()}
            onClick={() => void scanRemote()}
          >
            {scanning() ? t('obScanning') : t('obScanQr')}
          </button>
        </Show>
        <label for={props.pairingInputId ?? 'remote-pairing-link'}>{t('obPairingLink')}</label>
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
            <Show when={phone() && review().view.first_run} fallback={<>
            <p>{t('obPairEndpoint')}{' '}<bdi>{review().view.endpoint}</bdi></p>
            <p>{t('obNodeFingerprint')}{' '}<bdi>{review().view.node_id_fingerprint}</bdi></p>
            <Show when={review().view.hosted_by}>{label => <p>{t('obHostedBy')}{' '}<bdi>{label()}</bdi></p>}</Show>
            <p>{t('obCompareDetails')}</p>
            </>}>
              <p role="status">{t('obFirstRunDevice', device())}</p>
            </Show>
          </div>
        )}</Show>
        <div class="form-actions">
          <Show when={!(phone() && preview()?.view.first_run)}>
          <button type="submit" class="primary" disabled={busy()}>
            {importing() ? t('obSaving') : previewing() ? t('obCheckingTicket') : preview() ? t('obUseRemote') : t('obReviewTicket')}
          </button>
          </Show>
          <Show when={remoteLink() || preview() || importResult()}>
            <button type="button" class="quiet" data-cancel-pairing-review disabled={busy()} onClick={() => editLink('')}>{t('obCloseReview')}</button>
          </Show>
        </div>
        <p class="hint">{phone() ? t('obLinkSavedConnect', device()) : t('obLinkStored')}</p>
        <Show when={importResult()}>
          {(result) => (
            <p class="ok-note" data-import-result>
              {t('obRemoteNode')}{' '}{result().endpoint}
              <Show when={result().hosted_by}>
                {(label) => <> {t('obHostedByParenthesis')}{' '}<bdi data-hosted-by>{label()}</bdi>)</>}
              </Show>
              {' '}{t('obSavedFingerprint')}{' '}{result().node_id_fingerprint}. {result().restart_required ? t('obRestartConnect') : t('obConnectingNode')}
            </p>
          )}
        </Show>
        <Show when={importError()}>
          {(problem) => (
            <Show when={!problem().known} fallback={
              // The app's own format check: its message is the next step, shown as written.
              <div class="soft-error" data-soft-error="pairing-format">
                <p class="err-note" role="alert" data-soft-summary>{problem().text}</p>
              </div>
            }>
              <PairingSoftError message={onboardingDiagnostic(problem().text, t('obPairingLinkHelp'))} />
            </Show>
          )}
        </Show>
      </form>
      </Show>
    </section>
  );
}

/**
 * An unexpected pairing failure: the summary is chosen from the full text, as
 * before, and Details shows the reason without a leading "Error:".
 */
function PairingSoftError(props: { message: string }) {
  const soft = () => softenError(props.message);
  return <SoftError message={withoutErrorPrefix(props.message)} summary={soft().detail !== null ? soft().summary : undefined} />;
}
