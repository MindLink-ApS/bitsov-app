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
  max_routing_fee_msat?: number;
  kind: number;
  own_msat: number;
  peer_msat: number | null;
  peer_age_secs: number | null;
  peer_stale: boolean;
};

/**
 * `first_contact_quote`: a stranger's own signed price before anything is
 * paid (genome `first_contact_grant_v1`). Admission is paid once; the message
 * price is for this first message; the total is the cap the owner confirms.
 */
export type FirstContactQuote = {
  max_routing_fee_msat?: number;
  recipient: string;
  admission_msat: number;
  message_msat: number;
  total_msat: number;
  /** Unix seconds (≤ 60 s ahead). */
  expires_at: number;
};

/**
 * K1 slice 1: an introduction (door card), read and verified by the host:
 * a node key, where to reach it and its current prices, signed by that key,
 * valid ten minutes. Never admission. The prices are the card's signed
 * snapshot for display; before anything is paid the composer asks the node's
 * own fresh quote and the owner confirms that total.
 */
export type Introduction = {
  node_id: string;
  network: string;
  /** BitSov peer endpoint, host:port. */
  endpoint: string;
  /** `local`: a private-network address the reader must choose to allow. */
  reach: 'public' | 'local';
  admission_msat: number;
  message_msat: number;
  /** Unix seconds. */
  issued_at: number;
  expires_at: number;
  /** `bitsov://introduce#…` */
  link: string;
  /** K1 slice 2: a verified starter-bitcoin offer riding with the card. */
  starter?: Starter;
  /** The card with its offer, for the QR and a funding request. */
  offer_link?: string;
};

/**
 * K1 slice 2: starter bitcoin. The inviter's node pays a small, capped gift
 * into the newcomer's own node. It is the newcomer's balance, never
 * admission: every message still pays.
 */
export type Starter = { gift_msat: number; expires_at: number };

export type SponsorStatus = {
  enabled: boolean;
  gift_msat: number;
  fee_msat: number;
  purse_msat: number;
  purse_used_msat: number;
  kits_per_day: number;
  kits_today: number;
  kits?: SponsorKit[];
};

/** A newcomer's request, frozen by the sponsor's node for review. */
export type SponsorCandidate = {
  intro_id: string;
  payment_hash: string;
  newcomer: string;
  gift_msat: number;
  fee_max_msat: number;
  code: string;
  expires_at: number;
};

export type SponsorOwnerApproval = { owner_command: string };
export type SponsorKit = {
  intro_id: string;
  gift_msat: number;
  fee_msat: number;
  candidate: { newcomer: string; payment_hash: string; code: string } | null;
  state: 'offered' | 'candidate' | 'paying' | 'funded' | 'unknown' | 'failed' | 'cancelled' | 'expired';
  paid_msat: number;
  fee_paid_msat: number;
};

/** What the newcomer shows the sponsor, in person. */
export type FundingAsk = {
  request: string;
  code: string;
  sponsor: string;
  amount_msat: number;
  payment_hash: string;
  expires_at: number;
};

export type FundingStatus = { payment_hash: string; state: 'waiting' | 'received'; amount_msat: number };

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
  /** Known node capabilities (`energy_v1`, `membrane_v1`); absent or empty on rc7. */
  capabilities?: string[];
  /** Unix ms when the host read it. */
  read_at: number;
};

// ---- organism reads (genome N1 / N2) ------------------------------------------
// Mirrors `bitsov_app::control` EnergyRead / MembraneRead. Local reads of the
// node's own ledger: counterparty ids only, never a hash, preimage or payload.

export type EnergySpan = '1h' | '24h' | '7d';

/** One bucket; a bucket with nothing in it is absent (a gap, not a zero). */
export type EnergyBucket = { start_ms: number; in_msat: number; out_msat: number };

export type EnergyRead = {
  window: EnergySpan;
  as_of_ms: number;
  bucket_ms: number;
  buckets: EnergyBucket[];
  counterparties: { kind: 'peer' | 'room'; id: string; in_msat: number; out_msat: number; in_count: number; out_count: number }[];
  totals: { in_msat: number; out_msat: number; in_count: number; out_count: number };
  truncated: boolean;
};

/** One admission decision at a payment gate, as the node reports it. */
export type MembraneEvent = {
  seq: number;
  at: number;
  direction: 'inbound' | 'outbound';
  verdict: 'admitted' | 'refused';
  code: string;
  kind: number | null;
  /** Only when the node verified the sender before deciding. */
  counterparty: string | null;
  first_contact: boolean;
  required_msat: number | null;
  paid_msat: number | null;
  cap_msat: number | null;
};

/** Host sums of genome #96's 24 UTC-hour buckets. Decimal strings avoid JS rounding. */
export type RefusalCount = { count: string; at_least: boolean };
export type PrePaymentRefusals = {
  hour_start_ms: number | null;
  rows: { reason: PrePaymentReason; hour: RefusalCount | null; day: RefusalCount }[];
};
export type PrePaymentReason =
  | 'session_before_payment' | 'delivery_before_payment' | 'price_before_payment'
  | 'peer_exchange_before_payment' | 'lightning_info_before_payment' | 'gossip_before_payment'
  | 'invoice_error_before_payment' | 'admission_required';

export type MembraneRead = {
  capacity: number;
  totals: { admitted: number; first_contacts: number; refused: number; outbound_refused: number; readmissions?: number };
  events: MembraneEvent[];
  pre_payment_refusals?: PrePaymentRefusals | null;
  read_at: number;
};

export type LinkState = 'connecting' | 'open' | 'closed';

/** `node-live` event payload, parsed by the host from `GET /ws`. */
export type LiveEvent =
  | { type: 'message'; message: Message; room_id: string | null }
  | { type: 'delivery'; message_id: string; status: string; reason: string | null }
  | { type: 'onboarding'; step: string }
  | { type: 'link'; state: LinkState; detail: string | null }
  | { type: 'membrane'; event: MembraneEvent };

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
  // Unknown includes transport loss after dispatch: it must never mean "not sent".
  code:
    | 'spend_unknown'
    | 'price_changed' | 'price_cap_exceeded' | 'price_cap_unavailable' | 'room_partial'
    | 'spend_locked'
    | 'spend_expired'
    | 'spend_refused'
    | 'owner_only'
    | 'sponsor_owner_approval_required'
    | 'budget_paused' | 'budget_exhausted' | 'ceiling_exhausted' | 'first_contact' | 'budget_needed' | 'budget_unreadable'
    // G1 node grants: refused before any payment (see src-tauri/src/grant.rs).
    | 'grant_ended' | 'grant_exhausted' | 'grant_per_call' | 'grant_recipient' | 'grant_unpriced' | 'grant_ledger' | 'grant_refused' | 'grant_unknown' | 'grant_first_contact' | 'grant_readmission'
    | 'room_unreachable'
    // Paid, not delivered (node 502 `payment_settled_send_incomplete`), and its retry.
    | 'payment_settled_undelivered' | 'retry_unavailable' | 'retry_needs_admission' | 'undelivered_pending'
    | 'not_ready'
    | 'invalid'
    | 'node';
  message: string;
  /** `payment_settled_undelivered` only. */
  undelivered?: Undelivered;
  /** `retry_needs_admission` only: the price to approve, when the node could tell. */
  admission?: AdmissionPrice;
  /**
   * `payment_settled_undelivered` / `undelivered_pending`: the host's durable
   * record. Stop retrying names it, so a stale card never releases another message.
   */
  pending_id?: string;
};

/**
 * Retry delivery paid nothing new, and delivering a paid, undelivered message
 * still needs a payment: the message's price, and admission again if the
 * contact reconnected. `total_msat` is the cap the owner approves. `quoted`:
 * the contact's own signed quote; otherwise an estimate from the admission paid before.
 */
export type AdmissionPrice = { admission_msat: number; message_msat: number; max_routing_fee_msat?: number; total_msat: number; quoted: boolean };

/**
 * The node settled payment but the message did not go. `retry`: the node said a
 * retry re-sends its paid proof rather than paying again.
 */
export type Undelivered = { paid_msat: number; retry: boolean };

/** Public owner handoff only; no owner credential is exposed to the app. */
export type OwnerContactApproval = {
  id: string;
  request: { client_id: string; grant_op_id: string; recipient: string; max_total_msat: number; contact_budget_msat: number };
  owner_command: string;
  ready: boolean;
  expires_at_ms: number;
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

// ---- budgets (B2) -------------------------------------------------------------
// Mirrors `bitsov_app::budget` (src-tauri/src/budget.rs). Numbers only: the
// owner's approval lives in host memory and never appears here as a grant.

export type PresetId = 'careful' | 'everyday' | 'generous';
export type BudgetPreset = { id: PresetId; contact_msat: number; room_msat: number; ceiling_msat: number };
export type AutopayState = 'off' | 'open' | 'expired';
export type BudgetRow = { target: string; room: boolean; limit_msat: number | null; spent_msat: number };

/** `budget_status` and every budget command. Spends are a rolling 24 hours. */
export type BudgetView = {
  paused: boolean;
  autopay: { state: AutopayState; open_until_ms: number | null; ceiling_msat: number | null; basis: SpendBasis | null };
  /** A budget approval is waiting for the owner at the node. */
  waiting_for_owner: boolean;
  preset: PresetId;
  /** The daily total last approved. */
  ceiling_msat: number;
  spent_msat: number;
  /** Reserved at the price cap because the outcome is not known yet; included in `spent_msat`. */
  unsettled_msat: number;
  rows: BudgetRow[];
  presets: BudgetPreset[];
  window_ms: number;
  max_daily_msat: number;
  /** The live G1 node grant (`GET /pair/grant`) bounding this session's approvals. */
  node_grant: NodeGrantSummary | null;
};

/** What the node reports about its budget grant. Numbers only. */
export type NodeGrantSummary = { expires_at_ms: number; budget_msat: number; remaining_msat: number; per_call_max_msat: number };

/** `message_send`. */
export type SendReceipt = {
  total_msat?: number;
  max_routing_fee_msat?: number;
  message_id: string;
  recipient: string;
  is_room: boolean;
  delivered: boolean;
  amount_msat: number;
  sent_at_ms: number;
};

export type MemberCost = { max_routing_fee_msat?: number; node_id: string; msat: number; advertised: boolean; connected: boolean };

/** `room_quote`: each member's own price, summed. */
export type RoomQuote = {
  max_routing_fee_msat?: number;
  room_id: string;
  members: MemberCost[];
  total_msat: number;
  unreachable: string[];
  estimate: boolean;
};

export type InvoiceView = { bolt11: string; amount_msat: number; note: string | null; expires_at_ms: number };
export type InvoiceAmount = { amount_msat: number; network: string };
export type PaymentReceipt = {
  max_routing_fee_msat?: number;
  method: 'invoice' | 'keysend';
  amount_msat: number;
  status: 'settled' | 'pending' | 'inflight' | 'failed';
  paid_at_ms: number;
};
export type InviteView = { invite_id: string; invite_link: string; invitee: string; expires_at_ms: number };
export type RedeemView = { inviter_pubkey: string; addr: string };
export type FileReceipt = {
  total_msat?: number;
  max_routing_fee_msat?: number;
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
  | { id: string; at: number; type: 'failed'; action: string; error: ActionError }
  /**
   * Paid, not delivered. `text` is the owner's own draft, kept in memory for
   * Retry delivery only. `admission`: Retry delivery paid nothing new and a
   * payment is still due; this is the price to approve. `pendingId`: the host
   * record this card is about.
   */
  | { id: string; at: number; type: 'undelivered'; ownerApproval?: OwnerContactApproval | null; text: string; paid: Undelivered; note: string | null; admission: AdmissionPrice | null; pendingId: string | null }
  | { id: string; at: number; type: 'door'; door: DoorCard };

/**
 * The membrane in the stream: a first contact admitted at your door, a verified
 * sender refused there, or your own send refused at theirs.
 */
export type DoorCard =
  | { side: 'in'; verdict: 'admitted'; sender: string; paid_msat: number | null; door_msat: number | null }
  | { side: 'in'; verdict: 'refused'; sender: string; code: string; required_msat: number | null; paid_msat: number | null }
  | { side: 'out'; verdict: 'refused'; code: string; detail: string; cap_msat: number | null };

// ---- AI track (slice C) -----------------------------------------------------
// Each mirrors `bitsov_app::ai` (src-tauri/src/ai.rs) or the read broker's
// allowlisted projection (src-tauri/src/jarvis/broker/schema.rs). The host reads
// with the paired token only; nothing here carries a body, hash, label or key.

export type AiTopic = 'balance' | 'channels' | 'node' | 'inbox' | 'prices' | 'payments';

export type Unavailable = { kind: 'timeout' | 'upstream_error' | 'malformed' | 'absent' | 'stale' | 'overflow' };

/** A broker figure: a value with its unit and source field, or why there is none. */
export type Amount<T = number> =
  | { state: 'available'; value: T; unit: string; source_field: string }
  | { state: 'unavailable'; unit: string; source_field: string; reason: Unavailable };

export type Report<T> = { state: 'ready'; value: T } | { state: 'unavailable'; reason: Unavailable };

export type CopiedId = { state: 'value'; value: string } | { state: 'withheld' };

export type BalanceReport = {
  label: 'ldk_onchain_plus_lightning' | 'lnd_channel_balance' | 'node_reported';
  wallet_balance: Amount;
  channel_local_balance: Amount;
  channel_remote_balance: Amount;
  channel_capacity: Amount;
};

export type ChannelSummaryReport = {
  channel_id: CopiedId;
  capacity: Amount;
  local_balance: Amount;
  remote_balance: Amount;
  active: boolean;
  short_channel_id: CopiedId | null;
};

export type ChannelsReport = { count: Amount; active_count: Amount; channels: ChannelSummaryReport[] };

export type HealthReport = {
  liveness: 'ok' | 'other';
  connected_peers: Amount;
  e2ee_sessions: Amount;
  pending_deliveries: Amount;
  lightning_available: boolean;
  lightning_payment_capable: boolean;
  uptime: Amount;
  version: Amount;
  lightning_backend: string;
  chain_backend: string;
  block_height: Amount;
};

export type MessageCountsReport = {
  returned_count: Amount;
  senders: { sender: string; count: Amount }[];
  withheld_senders: Amount;
};

export type LocalPricesReport = {
  mode: string;
  prices: { category: string; price: Amount }[];
  block_height: Amount;
  [more: string]: unknown;
};

export type PaymentEntry = { at_ms: number; direction: 'sent' | 'received'; amount: Amount; peer: CopiedId };

export type PaymentsReport = {
  entries: PaymentEntry[];
  sent_total: Amount;
  received_total: Amount;
  unlisted: Amount;
  peers_read: Amount;
  peers_unread: Amount;
  partial_threads: Amount;
};

export type ToolOutput =
  | { tool: 'balance'; report: Report<BalanceReport> }
  | { tool: 'channels'; report: Report<ChannelsReport> }
  | { tool: 'health'; report: Report<HealthReport> }
  | { tool: 'message_counts'; report: Report<MessageCountsReport> }
  | { tool: 'local_prices'; report: Report<LocalPricesReport> }
  | { tool: 'payments'; report: Report<PaymentsReport> };

/** One worst case over the reads behind an answer, from the node's As-Of/Stale headers. */
export type AiFreshness = {
  state: 'fresh' | 'stale' | 'unknown';
  age_ms: number | null;
  /** Time left until the first route expires; null when freshness is unknown. */
  fresh_for_ms: number | null;
  node_as_of: boolean;
  node_stale: boolean;
  clock_skew: boolean;
};

export type NoRead = 'not_paired' | 'rc7_fallback' | 'node_unreachable';

/** `ai_read`. */
export type TopicRead =
  | { state: 'live'; topic: AiTopic; outputs: ToolOutput[]; freshness: AiFreshness; routes: string[] }
  | { state: 'unavailable'; topic: AiTopic; reason: NoRead };

export type ProviderKind = 'local' | 'shared' | 'frontier';
export type Preset = 'exact' | 'rounded' | 'counts';

/** `ai_providers`. Remote ones are off unless this computer's settings turn them on. */
export type ProviderView = {
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  host: string | null;
  model: string | null;
  note: string | null;
};

/** `ai_disclose`: what would leave, byte for byte. Nothing has been sent. */
export type Disclosure = {
  id: string;
  provider: ProviderKind;
  label: string;
  host: string;
  model: string;
  preset: Preset;
  body: string;
  bytes: number;
  key_env: string | null;
  expires_in_ms: number;
};

/** `ai_send`. Plain text; the app never acts on it. */
export type RemoteAnswer = {
  provider: ProviderKind;
  label: string;
  host: string;
  model: string;
  text: string;
  sent_bytes: number;
};

/** Principal and explicit caller routing allowance, used for file quotes. */
export type PaymentQuote = { principal_msat: number; max_routing_fee_msat: number; total_msat: number };
