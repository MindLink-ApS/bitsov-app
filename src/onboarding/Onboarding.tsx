import { LocalNodeSwitch } from './LocalNodeSwitch';
import { SoftError } from '../control/SoftError';
import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { onboardingSteps, scopeList, type NodeStatus, type PairingView } from './pairing';
import type { DeviceView } from '../control/types';

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
  onForgetRemote?: () => Promise<void>;
  onImportRemote?: (link: string) => Promise<{
    endpoint: string;
    node_id_fingerprint: string;
    restart_required: boolean;
  }>;
}) {
  // Runtime, opt-in only. This changes presentation, never node authority.
  const testNodes = (() => {
    try { return localStorage.getItem('bitsov.test-nodes') === '1'; } catch { return false; }
  })();
  const steps = () => onboardingSteps(props.status(), props.pairing(), props.trustAck());
  const stage = () => onboardingStage(steps());
  const [internalTarget, setInternalTarget] = createSignal<NodeTarget>('local');
  const target = () => props.selectedTarget ?? internalTarget();
  const setTarget = (t: NodeTarget) => {
    setInternalTarget(t);
    props.onTargetChange?.(t);
  };
  const isEnrolled = () => props.device?.()?.state === 'registered';
  const [remoteLink, setRemoteLink] = createSignal('');
  const [importing, setImporting] = createSignal(false);
  const [forgetting, setForgetting] = createSignal(false);
  const [remoteRevision, setRemoteRevision] = createSignal(0);
  const [remoteChoiceEdited, setRemoteChoiceEdited] = createSignal(false);
  const [importResult, setImportResult] = createSignal<string | null>(null);
  const [importError, setImportError] = createSignal<string | null>(null);

  const importRemote = async (event: Event) => {
    event.preventDefault();
    if (importing() || forgetting()) return;
    const link = remoteLink().trim();
    setRemoteLink('');
    if (!link) {
      setImportError('Paste a remote pairing link.');
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      if (!props.onImportRemote) throw new Error('Remote access import is unavailable.');
      const result = await props.onImportRemote(link);
      setRemoteRevision(n => n + 1);
      setRemoteChoiceEdited(true);
      setImportResult(
        `Remote node ${result.endpoint} saved. Node ID fingerprint: ${result.node_id_fingerprint}. Restart BitSov to connect.`,
      );
    } catch (error) {
      setImportError(String(error));
    } finally {
      setImporting(false);
    }
  };

  const forgetRemote = async () => {
    setForgetting(true);
    try {
      await props.onForgetRemote!();
      setRemoteChoiceEdited(true);
      setImportResult(null);
      setImportError(null);
    } finally { setForgetting(false); }
  };

  return (
    <section class="onboarding" aria-label="First-run setup" data-stage={stage()}>
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
            <h1>Before you add sats</h1>
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
          <h1>Where should your node run?</h1>
          <p class="lede">Every message you send is a small bitcoin payment to the person you are writing to. Your node makes those payments, so it needs a home first.</p>
        </header>
      </Show>

      {/* Node location: this Mac first; compact once the node is up */}
      <div class="node-target-section" classList={{ compact: stage() !== 'node' }}>
        <h2 class="node-target-title" classList={{ 'sr-only': stage() === 'node' }}>Where your node runs</h2>
        <div class="node-target-grid" role="radiogroup" aria-label="Choose node location">
          {/* Option 1: This computer (local node) */}
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
            </div>
          </button>

          <details class="node-target-advanced" open={target() !== 'local'}>
            <summary>Advanced: use a node you already run at home</summary>
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
                <strong>Your computer at home</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge">Pairing link</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>A computer you keep running at home can receive while this Mac is off. Its keys live on that computer. Paste its pairing link; it is saved for the next start.</p>
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
          {props.pairing().remote ? 'This app connects to your remote node.' : 'This app connects to the node on this Mac.'}
          <Show when={!props.pairing().remote && target() !== 'local'}> A saved pairing link takes effect at the next start.</Show>
          <Show when={isEnrolled()}> Touch ID on this Mac can approve a contact or budget.</Show>
        </p>
      </div>

      <Show when={props.onForgetRemote && (props.pairing().remote || target() !== 'local' || remoteChoiceEdited())}>
        <LocalNodeSwitch onForget={forgetRemote} disabled={importing() || forgetting()} remoteRevision={remoteRevision()} />
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
                  <p class="hint">Touch ID approvals are already set up on this Mac; pairing does not create that key.</p>
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
              <div class="touchid-text">
                <h2>This app is paired</h2>
                <Show
                  when={isEnrolled()}
                  fallback={<span class="touchid-status-pill" data-device-badge="none">{props.status().local_owner && !props.pairing().bootstrap ? "Owner device not enrolled" : "App paired"}</span>}
                >
                  <span class="touchid-status-pill" data-device-badge="registered">Touch ID Enrolled · Secure Enclave</span>
                </Show>
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
              </div>
            </div>

            <p class="pairing-access">
              Access: <strong>{scopeList(props.pairing().scopes)}</strong>
            </p>

            <Show when={props.pairing().bootstrap}>
              <p class="hint" data-identity-free>
                Your node is identity-free (fresh install). {props.status().local_owner && !props.pairing().remote ? "Create your identity with the owner setup below." : props.pairing().remote ? "Restore your identity at your node." : "You can restore an existing identity on this Mac."} Nothing has been created yet.
              </p>
            </Show>

            {/* Progressive disclosure: technical codes & tripwires kept under summary */}
            <details class="pairing-details">
              <summary>Pairing verification & security details</summary>
              <div class="pairing-details-body">
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

      <Show when={target() !== 'local'}>
      <p class="hint">After a power cut, open the app once. Your password is never stored on the box.</p>
      <form class="panel pairing remote-form" data-remote-access onSubmit={importRemote}>
        <h2>Paste the pairing link</h2>
        <label for="remote-pairing-link">Pairing link</label>
        <input
          id="remote-pairing-link"
          type="password"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          disabled={importing() || forgetting()}
          value={remoteLink()}
          onInput={(event) => setRemoteLink(event.currentTarget.value)}
          placeholder="bitsov://pair/…"
        />
        <button type="submit" class="primary" disabled={importing() || forgetting()}>
          {importing() ? 'Saving…' : 'Use remote node'}
        </button>
        <p class="hint">The link is verified and stored for the next app start.</p>
        <Show when={importResult()}>
          <p class="ok-note">{importResult()}</p>
        </Show>
        <Show when={importError()}>
          <SoftError message={importError()!} />
        </Show>
      </form>
      </Show>
    </section>
  );
}
