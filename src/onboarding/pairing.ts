export const FIRST_RUN_PHONE_MESSAGE = "This node isn't set up yet. Finish setup on a Mac, then add this phone.";

// First-run onboarding model: Start node → Pair this app → Create/restore identity → Fund.
// Pure functions over what the host reports (`node_status`, `pairing_status`), so the
// step logic is testable without a window. The host never sends a token or key here.

/** Envelope only. The existing Rust parser remains authoritative for the ticket,
 * signed keys, expiry and endpoint, and runs before anything is persisted. */
export function normalizePairingLink(input: string): string {
  const link = input.trim();
  const prefix = 'bitsov://pair/';
  if (!link.startsWith(prefix) || link.length > prefix.length + 16384 ||
      !/^[A-Za-z0-9_-]+$/.test(link.slice(prefix.length))) {
    throw new Error('Use a bitsov://pair/ pairing ticket from your node.');
  }
  return link;
}

/** Structured host failures; detail belongs in connection diagnostics. */
export type ConnectionError = {
  kind: 'unclaimed' | 'local_network' | 'unreachable' | 'busy' | 'expired' | 'clock' | 'used' | 'tailscale' | 'claim_mismatch' | 'other';
  detail: string;
};

export type NodeStatus = {
  /** Host has inspected the saved descriptor; null means startup is unresolved. */
  phone_setup?: boolean | null;
  connection_error?: ConnectionError | null;
  locked?: boolean;
  typed_unlock_supported?: boolean;
  unlock_state?: 'ready' | 'no-password' | 'not-enrolled' | 'pending-approval';
  pending_device?: { fingerprint: string | null; owner_action: string | null } | null;
  attempts_left?: number | null;
  remember_offer?: boolean;
  local_owner?: boolean;
  owner_warning?: string | null;
  initialization_repair?: 'none' | 'required' | 'repairing' | 'price_floor_required' | 'price_floor_repairing';
  retry_after_secs?: number | null;
  ready: boolean;
  node_id: string | null;
  error: string | null;
};

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
  /** Display-only label from the saved remote pairing link; capped by the host. */
  hosted_by?: string | null;
  /** Durable acknowledgement from the host, bound to this connection mode. */
  trust_acknowledged_node_id?: string | null;
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

/**
 * The setup steps. `phone`: an Android or iOS build has no node of its own, so
 * there is no "Start node" step; until it is paired to a remote node, pairing
 * is the step in progress (never a local-node failure).
 */
export function onboardingSteps(status: NodeStatus, pairing: PairingView, trustAck: boolean, phone = false): Step[] {
  const nodeUp = pairing.state !== 'starting' || status.ready;
  const node: StepStatus = nodeUp ? 'done' : status.error ? 'failed' : 'active';

  const pair: StepStatus = phone && (!pairing.remote || !nodeUp)
    ? 'active'
    : !nodeUp
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
      ? (pairing.bootstrap === 'bootstrap' ? 'active' : 'blocked')
      : !status.ready
        ? 'todo'
        : trustAck || (pairing.remote && !!status.node_id)
          ? 'done'
          : 'active';

  const fund: StepStatus = identity === 'done' ? 'active' : 'todo';

  return [
    ...(phone ? [] : [{ id: 'node', label: 'Start node', status: node } as Step]),
    { id: 'pair', label: 'Pair this app', status: pair },
    { id: 'identity', label: 'Create or restore identity', status: identity },
    { id: 'fund', label: 'Fund', status: fund },
  ];
}

export const scopeList = (scopes: string[]) => scopes.join(' + ');

/** Host connection errors carry sanitized diagnostic copy. */
export function connectionErrorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error && typeof error.detail === 'string') return error.detail;
  return String(error);
}
