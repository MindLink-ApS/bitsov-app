import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { onboardingSteps, scopeList, type NodeStatus, type PairingView } from './pairing';

// Claim discipline (BitSov-bitsov docs/security/pairing.md): less exposure, not solved
// local security. The short code is a tripwire, never described as what protects the
// pairing — in the sidecar deployment this app reads the node's stdout by construction.

const STATUS_TEXT = {
  todo: '',
  active: 'now',
  done: 'done',
  failed: 'failed',
  skipped: 'not available on this node',
  blocked: 'waiting on a genome release',
} as const;

export type NodeTarget = 'local' | 'network' | 'cloud';

export function Onboarding(props: {
  status: () => NodeStatus;
  pairing: () => PairingView;
  trustAck: () => boolean;
  onRetry: () => void;
  selectedTarget?: NodeTarget;
  onTargetChange?: (target: NodeTarget) => void;
}) {
  const steps = () => onboardingSteps(props.status(), props.pairing(), props.trustAck());
  const [internalTarget, setInternalTarget] = createSignal<NodeTarget>('local');
  const target = () => props.selectedTarget ?? internalTarget();
  const setTarget = (t: NodeTarget) => {
    setInternalTarget(t);
    props.onTargetChange?.(t);
  };

  const [touchIdSimulated, setTouchIdSimulated] = createSignal(false);

  return (
    <section class="onboarding" aria-label="First-run setup">
      {/* Node location selection: 3 honest choices */}
      <div class="node-target-section">
        <h2 class="node-target-title">Where does your node live?</h2>
        <p class="hint">Select how you want to connect. Touch ID on this device approves every payment the app makes.</p>

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
                <strong>This computer</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge ok">Local · Recommended</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>Run your sovereign node directly on this Mac. Keys on this Mac; nothing to trust but your own machine.</p>
            </div>
          </button>

          {/* Option 2: A node on my network */}
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
                <strong>A node on my network</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge">Home Server · LAN</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>Connect to a home server running BitSov on your local Wi-Fi or wired network.</p>
            </div>
          </button>

          {/* Option 3: A cloud node (hosted, labelled honestly) */}
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
                <strong>A cloud node</strong>
                <div class="row" style={{ width: 'auto', gap: '8px' }}>
                  <span class="target-badge honest">Hosted custody</span>
                  <span class="target-radio-indicator" aria-hidden="true">✓</span>
                </div>
              </div>
              <p>Hosted: the machine that runs your node holds its keys. Good for always-on; choose this only if you trust the host. A remote signer that keeps keys on your Mac is coming.</p>
            </div>
          </button>
        </div>

        <Show when={target() === 'network'}>
          <div class="node-target-aux" data-target-aux="network">
            <div class="row">
              <div class="spinner small" />
              <span>Scanning local network for BitSov nodes…</span>
            </div>
            <details class="node-advanced">
              <summary>Enter connection address manually</summary>
              <div class="fields" style={{ 'margin-top': '8px' }}>
                <input type="text" placeholder="e.g. bitsov-server.local or my-node.lan" aria-label="Network node address" />
              </div>
            </details>
          </div>
        </Show>

        <Show when={target() === 'cloud'}>
          <div class="node-target-aux" data-target-aux="cloud">
            <p class="hint">
              <strong>Honest custody notice:</strong> Hosted: the machine that runs your node holds its keys. Good for always-on; choose this only if you trust the host. A remote signer that keeps keys on your Mac is coming.
            </p>
            <details class="node-advanced">
              <summary>Enter cloud provider details</summary>
              <div class="fields" style={{ 'margin-top': '8px' }}>
                <input type="text" placeholder="e.g. node.bitsov.cloud" aria-label="Cloud provider hostname" />
              </div>
            </details>
          </div>
        </Show>
      </div>

      <ol class="steps">
        <For each={steps()}>
          {(step) => (
            <li class={`step ${step.status}`} data-step={step.id} data-status={step.status}>
              <span class="step-label">{step.label}</span>
              <Show when={STATUS_TEXT[step.status]}>
                <span class="step-status">{STATUS_TEXT[step.status]}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>

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
                <h2>Pairing this app with your node…</h2>
                <p>Registering this Mac’s Secure Enclave key with Touch ID.</p>
              </div>
            </div>
            <p class="hint">
              The app proves it can read your node’s data folder by signing a one-time
              challenge the node wrote there.
            </p>
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
                <span class="touchid-status-pill">Touch ID Enrolled · Secure Enclave</span>
              </div>
            </div>

            <p>
              Access: <strong>{scopeList(props.pairing().scopes)}</strong>
            </p>

            <Show when={props.pairing().bootstrap}>
              <p class="hint" data-identity-free>
                Your node is identity-free (fresh install). Creating or restoring an identity
                from this app arrives with the next genome release; nothing has been created
                yet.
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
            <code>{props.pairing().reason}</code>
            <p class="hint">
              The app did not fall back to the older unpaired login. Check that your node is
              the one this app started, then retry.
            </p>
            <button class="primary" onClick={() => props.onRetry()}>
              Retry pairing
            </button>
          </div>
        </Match>

        <Match when={props.pairing().state === 'fallback'}>
          <div class="panel pairing" data-pairing="fallback">
            <h2>Pairing not available on this node</h2>
            <p class="hint">
              The bundled node (v0.3.0-rc7) predates pairing, so this app signs in with the
              local loopback token (/auth/local) as before. Pairing turns on once a node
              release that supports it is bundled.
            </p>
          </div>
        </Match>
      </Switch>
    </section>
  );
}
