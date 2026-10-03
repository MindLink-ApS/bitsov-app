// First-run onboarding model: Start node → Pair this app → Create/restore identity → Fund.
// Pure functions over what the host reports (`node_status`, `pairing_status`), so the
// step logic is testable without a window. The host never sends a token or key here.

export type NodeStatus = { retry_after_secs?: number | null; ready: boolean; node_id: string | null; error: string | null };

/** Mirrors `bitsov_app::pairing::PairingView`. */
export type PairingView = {
  /** The running node uses the pinned remote transport. */
  remote: boolean;
  state: 'starting' | 'pending' | 'paired' | 'failed' | 'fallback';
  scopes: string[];
  short_code: string | null;
  /** The code was read from the node's own stdout and matched the challenge file. */
  code_from_node: boolean;
  reason: string | null;
  /** `bootstrap` on an identity-free node. */
  bootstrap: string | null;
};

export type StepStatus = 'todo' | 'active' | 'done' | 'failed' | 'skipped' | 'blocked';
export type Step = { id: 'node' | 'pair' | 'identity' | 'fund'; label: string; status: StepStatus };

export const INITIAL_PAIRING: PairingView = {
  remote: false,
  state: 'starting',
  scopes: [],
  short_code: null,
  code_from_node: false,
  reason: null,
  bootstrap: null,
};

export function onboardingSteps(status: NodeStatus, pairing: PairingView, trustAck: boolean): Step[] {
  const nodeUp = pairing.state !== 'starting' || status.ready;
  const node: StepStatus = nodeUp ? 'done' : status.error ? 'failed' : 'active';

  const pair: StepStatus = !nodeUp
    ? 'todo'
    : pairing.state === 'pending'
      ? 'active'
      : pairing.state === 'failed'
        ? 'failed'
        : pairing.state === 'fallback'
          ? 'skipped'
          : 'done';

  const authed = pair === 'done' || pair === 'skipped';
  const identity: StepStatus = !authed
    ? 'todo'
    : pairing.bootstrap
      ? 'blocked'
      : !status.ready
        ? 'todo'
        : trustAck || (pairing.remote && !!status.node_id)
          ? 'done'
          : 'active';

  const fund: StepStatus = identity === 'done' ? 'active' : 'todo';

  return [
    { id: 'node', label: 'Start node', status: node },
    { id: 'pair', label: 'Pair this app', status: pair },
    { id: 'identity', label: 'Create or restore identity', status: identity },
    { id: 'fund', label: 'Fund', status: fund },
  ];
}

export const scopeList = (scopes: string[]) => scopes.join(' + ');
