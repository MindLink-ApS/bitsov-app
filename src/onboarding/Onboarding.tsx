import { For, Match, Show, Switch } from 'solid-js';
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

export function Onboarding(props: {
  status: () => NodeStatus;
  pairing: () => PairingView;
  trustAck: () => boolean;
  onRetry: () => void;
}) {
  const steps = () => onboardingSteps(props.status(), props.pairing(), props.trustAck());

  return (
    <section class="onboarding" aria-label="First-run setup">
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
            <div class="spinner" />
            <p>Pairing this app with your node…</p>
            <p class="hint">
              The app proves it can read your node’s data folder by signing a one-time
              challenge the node wrote there.
            </p>
          </div>
        </Match>

        <Match when={props.pairing().state === 'paired'}>
          <div class="panel pairing" data-pairing="paired">
            <h2>This app is paired</h2>
            <p>
              Access: <strong>{scopeList(props.pairing().scopes)}</strong>
            </p>
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
            <Show when={props.pairing().bootstrap}>
              <p class="hint" data-identity-free>
                Your node is identity-free (fresh install). Creating or restoring an identity
                from this app arrives with the next genome release; nothing has been created
                yet.
              </p>
            </Show>
            <p class="hint">
              A packaged app like this one cannot spend and cannot replace a live identity. To
              spend, run the node yourself and grant it with the owner CLI on that machine.
            </p>
            <p class="hint">Less exposure, not solved local security.</p>
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
