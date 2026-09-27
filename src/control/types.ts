// Shapes the host's read commands return. Each mirrors a `bitsov_app::control`
// struct (src-tauri/src/control.rs), which mirrors the pinned node route
// (v0.3.0-rc7). No token, key, preimage or ciphertext is in any of them.

/** `peers_list` — `GET /peers`. Contacts are private local knowledge, not an allow-list. */
export type Peer = {
  node_id: string;
  addr: string | null;
  label: string | null;
  connected: boolean;
  fingerprint: string | null;
};

/** `rooms_list` — `GET /rooms`. */
export type Room = {
  id: string;
  name: string;
  created_by: string | null;
  /** ISO 8601. */
  created_at: string | null;
};

/** `messages_list` — `GET /messages?peer=…`. Timestamps are unix milliseconds. */
export type Message = {
  id: string;
  kind: number;
  sender: string;
  /** Hex node id, room UUID, or `broadcast`. */
  recipient: string;
  timestamp: number;
  plaintext: string | null;
  payment_amount_msat: number | null;
};

/**
 * `price_quote`. `own_msat` is what *this* node charges for a text message.
 * Reaching a peer costs the peer's price; `peer_msat` is set only when the node
 * holds that peer's pricing table.
 */
export type PriceQuote = {
  kind: number;
  own_msat: number;
  peer_msat: number | null;
  peer_age_secs: number | null;
  peer_stale: boolean;
};

export type Channel = {
  channel_id: string;
  peer_pubkey: string;
  capacity_msat: number;
  local_balance_msat: number;
  remote_balance_msat: number;
  active: boolean;
};

/** `payments_overview`. */
export type WalletOverview = {
  /** rc7 reports one combined figure: Lightning + spendable on-chain. */
  balance_msat: number;
  /** Sum of active channels' outbound capacity. Not a partition of `balance_msat`. */
  lightning_outbound_msat: number;
  channels: Channel[];
};

/** `node_overview` — `GET /status`, projected. */
export type NodeOverview = {
  node_id: string;
  status: string;
  version: string | null;
  connected_peers: number;
  e2ee_sessions: number;
  pending_deliveries: number;
  lightning_available: boolean;
  block_height: number | null;
  uptime_secs: number;
  lightning_backend: string | null;
  chain_backend: string | null;
  /** Unix ms when the host read it. */
  read_at: number;
};

export type LinkState = 'connecting' | 'open' | 'closed';

/** `node-live` event payload, parsed by the host from `GET /ws`. */
export type LiveEvent =
  | { type: 'message'; message: Message; room_id: string | null }
  | { type: 'delivery'; message_id: string; status: string; reason: string | null }
  | { type: 'onboarding'; step: string }
  | { type: 'link'; state: LinkState; detail: string | null };

export type TrackRef =
  | { kind: 'peer'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'ai' }
  | { kind: 'new' };

/** First-run funding shapes (unchanged from CS-2). */
export type FundState = {
  current_step: string;
  tier: string | null;
  funding_address: string | null;
  funding_amount_sats_required: number | null;
  funding_amount_sats_received: number;
  funding_evidence: string | null;
  funded: boolean;
};
export type FundingAddress = { address: string; network: string | null; note: string | null };
export type Balance = { balance_msat: number };
export type RestoreOutcome = { node_id: string; restart_required: boolean; restarted: boolean };

// ---- actions (slice B) ------------------------------------------------------
// Each mirrors a `bitsov_app::act` struct (src-tauri/src/act.rs). Receipts carry
// amounts and status only: no preimage, payment hash or token.

/** A refused or failed action, as the host rejects it. */
export type ActionError = {
  code:
    | 'spend_locked'
    | 'spend_expired'
    | 'spend_refused'
    | 'owner_only'
    | 'room_unreachable'
    | 'not_ready'
    | 'invalid'
    | 'node';
  message: string;
};

export type SpendState = 'locked' | 'pending' | 'unavailable' | 'open' | 'expired';

/** `app_lock`: rc7 scopes nothing, the window is the app's own. `node_grant`: an owner-written grant. */
export type SpendBasis = 'app_lock' | 'node_grant';

export type Elevation = {
  op_id: string;
  expires_at_ms: number;
  /** The node's own words for what the owner must run. Shown verbatim. */
  owner_action: string;
  owner_can_grant: boolean;
};

/** `spend_status` / `spend_request` / `spend_lock`. */
export type SpendView = {
  state: SpendState;
  basis: SpendBasis | null;
  open_until_ms: number | null;
  pending: Elevation | null;
  window_ms: number;
};

/** `message_send`. */
export type SendReceipt = {
  message_id: string;
  recipient: string;
  is_room: boolean;
  delivered: boolean;
  amount_msat: number;
  sent_at_ms: number;
};

export type MemberCost = { node_id: string; msat: number; advertised: boolean; connected: boolean };

/** `room_quote`: each member's own price, summed. */
export type RoomQuote = {
  room_id: string;
  members: MemberCost[];
  total_msat: number;
  unreachable: string[];
  estimate: boolean;
};

export type InvoiceView = { bolt11: string; amount_msat: number; note: string | null; expires_at_ms: number };
export type InvoiceAmount = { amount_msat: number; network: string };
export type PaymentReceipt = {
  method: 'invoice' | 'keysend';
  amount_msat: number;
  status: 'settled' | 'pending' | 'inflight' | 'failed';
  paid_at_ms: number;
};
export type InviteView = { invite_id: string; invite_link: string; invitee: string; expires_at_ms: number };
export type RedeemView = { inviter_pubkey: string; addr: string };
export type FileReceipt = {
  message_id: string;
  recipient: string;
  filename: string;
  size_bytes: number;
  delivered: boolean;
  amount_msat: number;
  sent_at_ms: number;
};

/** Delivery of one sent message, from the send reply and then `/ws`. */
export type Delivery = { status: 'sent' | 'queued' | 'delivered' | 'rejected'; reason: string | null };

/** A local, inline artifact in a track: the result of an action taken there. */
export type Artifact =
  | { id: string; at: number; type: 'invoice'; invoice: InvoiceView }
  | { id: string; at: number; type: 'payment'; receipt: PaymentReceipt }
  | { id: string; at: number; type: 'file'; receipt: FileReceipt }
  | { id: string; at: number; type: 'failed'; action: string; error: ActionError };
