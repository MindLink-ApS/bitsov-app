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
  /** Their node takes mesh-meeting legs (connected, advertising `call_meeting_v1`). */
  meetings?: boolean;
  /** Their node checks room bindings (connected, advertising `room_binding_v1`). */
  rooms?: boolean;
  /** Our node holds an E2EE session with them (`GET /sessions`). */
  session?: boolean;
  /** Their node answers porch reads (connected, advertising `porch_read_v1`). */
  porch?: boolean;
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
  /** Room thread (`room_thread`) only: our one room message, each member's copy. */
  copies?: RoomCopy[];
};

/** One member's copy of our own room message (genome `RoomCopy`). */
export type RoomCopy = { recipient: string; id: string; payment_amount_msat: number | null };

/**
 * `price_quote`. `own_msat` is what *this* node charges for a text message.
 * Reaching a peer costs the peer's price; `peer_msat` is set only when the node
 * holds that peer's pricing table.
 */
export type PriceQuote = {
  /** Host refuses to promise an all-in message cap on an older node. */
  send_unavailable?: string | null;
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
  /** Legacy node-reported aggregate; not a claim of spendability. */
  balance_msat: number;
  /** Sum of active channels' outbound capacity. Not a partition of `balance_msat`. */
  lightning_outbound_msat: number;
  /** Optional measured categories in sats. Missing/null means unknown, not zero.
   * These overlap and are not an additive partition of balance_msat. */
  lightning_spendable_sats?: number | null;
  onchain_spendable_sats?: number | null;
  onchain_total_sats?: number | null;
  onchain_pending_sats?: number | null;
  anchor_reserve_sats?: number | null;
  closing_sats?: number | null;
  contested_sats?: number | null;
  channels: Channel[];
};

/** `node_overview` — `GET /status`, projected. */
export type NodeReadiness = {
  money_ready: boolean;
  state: string;
  retry_attempt: number;
  retry_after_secs: number | null;
  events: { sequence: number; timestamp: number; state: string; money_ready: boolean }[];
};

export type NodeOverview = {
  money_ready?: boolean | null;
  readiness?: NodeReadiness | null;
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
  /** Known node capabilities (`energy_v1`, `membrane_v1`, `call_meeting_v1`, `room_binding_v1`, `porch_read_v1`, `front_door_v1`); absent or empty on rc7. */
  capabilities?: string[];
  /** UDP port of the node's own STUN responder (`[calls] stun_listen`); absent when off. */
  stun_port?: number | null;
  /** `stun:host:port` for it at the node's public host; absent without one. Offered, never applied. */
  stun_url?: string | null;
  /** The LDK network the host started the node with (`mainnet`, `regtest`, …); absent when unknown. */
  network?: string | null;
  /** Where the node's seed lives (node REMOTE-SIGNER.md §2); absent from older nodes. */
  custody_mode?: CustodyMode | null;
  /** Unix ms when the host read it. */
  read_at: number;
};

export type CustodyMode =
  | 'local_seed'
  | 'encrypted_seed'
  | 'hosted_custody'
  | 'money_signer'
  | 'remote_signer';

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
  /** A room bound on chat (`room_binding_v1`): its id; the roster is on this device (room.ts). */
  | { kind: 'bound'; id: string }
  | { kind: 'ai' }
  | { kind: 'new' }
  | { kind: 'discover' }
  /** Paid reads of a contact's card and pages (porch_read_v1). */
  | { kind: 'porch' }
  /** Receipts of payments made from the Wallet page. Never an open conversation. */
  | { kind: 'wallet' };

/**
 * FrontDoorCard v1 (doorstep): free to carry, signed by the node key, valid
 * seven days. Snapshot prices only; Knock uses a fresh first-contact quote.
 */
export type FrontDoor = {
  node_id: string;
  network: string;
  endpoint: string;
  reach: 'public' | 'local';
  seq: number;
  issued_at: number;
  expires_at: number;
  prices: {
    admission_msat: number;
    message_msat: number;
    page_msat: number;
    price_epoch: number;
  };
  profile: {
    kind: 'person' | 'company';
    display_name: string;
    tagline: string;
    about: string;
    avatar?: { inline_b64?: string; hash?: string; size?: number; mime?: string };
  };
  cv?: { path: string; hash: string; size: number };
  media: { hash: string; size: number; mime: string; thumb_b64?: string; title: string }[];
  site?: { manifest_hash?: string; index_path?: string; page_count: number; titles: string[] };
  links: { label: string; url: string }[];
  /** `bitsov://front-door#…` — also the QR payload. */
  link: string;
  verified: boolean;
  fresh: boolean;
};

/** `bitsov_app::porch::PorchCard`: a card the host verified for this view. */
export type PorchCard = FrontDoor & {
  /** Held by this node from an earlier read; nothing was paid to show it. */
  cached: boolean;
  /** Their node served an older card than the one this node holds. */
  stale: boolean;
};

/** `porch_read`: one paid read of a contact's card or a flat page. */
export type PorchRead = {
  node_id: string;
  path: string;
  status: 'ok' | 'not_found' | 'unavailable';
  /** `markdown` and `text` bodies are text only; nothing renders HTML. */
  kind: 'card' | 'markdown' | 'text' | 'none';
  body: string;
  card: PorchCard | null;
  amount_msat: number;
  /** What the read counts against the budget (its all-in ceiling). */
  total_msat: number;
  message_id: string;
};

export type FrontDoorPublish = {
  display_name: string;
  tagline?: string;
  about?: string;
  kind?: 'person' | 'company';
  admission_msat?: number;
  message_msat?: number;
  page_msat?: number;
  avatar?: { inline_b64?: string; hash?: string; size?: number; mime?: string };
  media?: { hash: string; size: number; mime: string; thumb_b64?: string; title: string }[];
  cv?: { path: string; hash: string; size: number };
  links?: { label: string; url: string }[];
};

/**
 * Marker that a peer track was opened from a front-door Knock (not an
 * Introduction). Display only — never admission, never re-dialed as introduce.
 */
export type Doorstep = {
  node_id: string;
  network: string;
  endpoint: string;
  reach: 'public' | 'local';
  admission_msat: number;
  message_msat: number;
  issued_at: number;
  expires_at: number;
  /** `bitsov://front-door#…` */
  link: string;
};

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
    | 'price_changed' | 'price_cap_exceeded' | 'price_cap_unavailable' | 'price_quote_unavailable' | 'room_partial'
    | 'spend_locked'
    | 'spend_expired'
    | 'spend_refused'
    | 'owner_only'
    | 'sponsor_owner_approval_required'
    | 'budget_paused' | 'budget_exhausted' | 'ceiling_exhausted' | 'first_contact' | 'budget_needed' | 'budget_unreadable'
    // G1 node grants: refused before any payment (see src-tauri/src/grant.rs).
    | 'grant_ended' | 'grant_exhausted' | 'grant_per_call' | 'grant_recipient' | 'grant_unpriced' | 'grant_ledger' | 'grant_refused' | 'grant_unknown' | 'grant_first_contact' | 'grant_readmission'
    | 'grant_no_envelope'
    // This Mac's Touch ID approvals (device key).
    | 'device_not_registered' | 'device_biometry' | 'device_cancelled' | 'device_unavailable' | 'device_invalid' | 'device_key' | 'device_unsupported'
    | 'room_unreachable'
    // Paid, not delivered (node 502 `payment_settled_send_incomplete`), and its retry.
    | 'payment_settled_undelivered' | 'retry_unavailable' | 'retry_needs_admission' | 'undelivered_pending'
    // Durable message operations (genome `message_operations_v1`): the node has not
    // resolved the payment; the retry's text differs from the send it retries;
    // paid and refused for good. None of them is ever re-sent on its own.
    | 'payment_unknown' | 'operation_mismatch' | 'failed_paid'
    // The contact asks for admission again after a reconnect/restart; the node
    // pays no re-admission under a cap (genome readmit_then_pay). Nothing paid.
    | 'readmission_capped'
    // Genome quoted_readmission_v1: the contact asks for admission again and its
    // signed quote (`admission`) is the new all-in price; nothing was paid. The
    // owner sends once more at that price; the same message keeps its operation.
    | 'readmission_quoted'
    // Porch reads (src-tauri/src/porch.rs). Refused before paying:
    | 'porch_knock_first' | 'porch_unreachable' | 'porch_busy' | 'porch_own_node' | 'porch_path_invalid'
    | 'porch_unsupported' | 'porch_unavailable' | 'porch_needs_contact' | 'porch_readmission'
    // Paid, with no usable answer; never retried:
    | 'porch_timeout' | 'porch_reply_invalid' | 'porch_card_mismatch'
    | 'not_ready' | 'app_not_ready'
    // Genome #115: the node proved nothing left the wallet (a room leg it could not bind, a fee ceiling).
    | 'not_dispatched'
    | 'invalid'
    | 'node';
  message: string;
  /** `payment_settled_undelivered` only. */
  undelivered?: Undelivered;
  /** `retry_needs_admission` / `readmission_quoted`: the price to approve, when the node could tell. */
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

/** This Mac as a paired device (`device_key_status`). */
export type DeviceState = 'unavailable' | 'none' | 'pending' | 'registered' | 'lapsed' | 'off';
export type DeviceView = {
  /** This Mac has a Secure Enclave the app can use. */
  available: boolean;
  state: DeviceState;
  /** This Mac's key fingerprint, as the node shows it to the owner. */
  fingerprint: string | null;
  /** While pending: the node's one-time owner command, verbatim. */
  owner_action: string | null;
  expires_at_ms: number | null;
  /** State `off`: the node's reason code (e.g. `seed_not_encrypted`) and what the owner is told. */
  off_reason?: string | null;
  off_message?: string | null;
};

/** Why the last request ended without a grant. `lost`: the node restarted (or cancelled it) and can no longer approve it. */
export type SpendLapse = 'expired' | 'lost';

/** `spend_status` / `spend_request` / `spend_lock`. */
export type SpendView = {
  state: SpendState;
  /** Set with `expired` when a request ended ungranted: offer Ask again. */
  lapse?: SpendLapse | null;
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
export type NodeGrantSummary = {
  expires_at_ms: number;
  budget_msat: number;
  remaining_msat: number;
  per_call_max_msat: number;
  /** A Touch ID relation grant: each contact with an envelope → when it ends (ms). Absent for a console grant. */
  envelopes?: Record<string, number> | null;
};

/** `message_send`. */
export type SendReceipt = {
  /** Proven routing fee for a settled payment; absent when unknown or unsupported. */
  fee_paid_msat?: number;
  total_msat?: number;
  max_routing_fee_msat?: number;
  message_id: string;
  recipient: string;
  is_room: boolean;
  delivered: boolean;
  amount_msat: number;
  sent_at_ms: number;
  /** The node's idempotency key for this send; every retry of it reuses it. */
  operation_id?: string;
  /** The node's operation state: `acked`, `sent`, `paid`, `failed_paid`, ... */
  state?: string;
  /** The recipient's node stored it. `delivered` alone is only a transport write. */
  accepted?: boolean;
  /** Admission paid again in this send after a reconnect; included in `total_msat`. */
  readmission_msat?: number;
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
/**
 * The host's reading of an invoice (`invoice_amount`), decoded by the same
 * parser the node pays with. The only source of a payee the app shows.
 */
export type InvoiceAmount = {
  amount_msat: number;
  network: string;
  /** The node the payment goes to, compressed pubkey hex. */
  payee: string;
  expires_at_ms: number;
  /** Canonical, lower case, no `lightning:`: what Pay sends. */
  bolt11: string;
  payment_hash: string;
  /** The `d` field as written by the payee; null for a description hash. */
  description: string | null;
};
/** `invoice_status`: an invoice we issued, as the node reports it. Read only. */
export type InvoiceStatus = { state: 'paid' | 'waiting' | 'failed' | 'unknown'; amount_msat: number | null };
export type PaymentReceipt = {
  /** Proven routing fee for a settled payment; absent when unknown or unsupported. */
  fee_paid_msat?: number;
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
  operation_id?: string;
  state?: string;
  accepted?: boolean;
};

/** `call_quote`: what calling a contact costs before anything is paid (msat). */
export type CallQuote = {
  offer_msat: number | null;
  offer_max_routing_fee_msat: number;
  signal_msat: number;
  signal_max_routing_fee_msat: number;
  call_total_msat: number | null;
};
/** `call_signal`: one paid call signal. */
export type CallReceipt = {
  message_id: string;
  kind: number;
  amount_msat: number;
  total_msat: number;
  max_routing_fee_msat: number;
  delivered: boolean;
  accepted: boolean;
  sent_at_ms: number;
};

/** `voice_note_fetch` / `file_fetch`: a received file's bytes (read-only). */
export type VoiceBlob = { filename: string; mime_type: string; size_bytes: number; data_b64: string };

/** `file_save`: wrote only if the owner confirmed the native save dialog. */
export type FileSaveResult = { saved: boolean; filename: string; mime_type: string; size_bytes: number };

/** Delivery of one sent message, from the send reply and then `/ws`. */
export type Delivery = { status: 'accepted' | 'sent' | 'queued' | 'delivered' | 'rejected'; reason: string | null };

/** A local, inline artifact in a track: the result of an action taken there. */
export type Artifact =
  | { id: string; at: number; type: 'invoice'; invoice: InvoiceView }
  /** `invoice`: the bolt11 an invoice payment paid, so a request card can show it paid. */
  | { id: string; at: number; type: 'payment'; receipt: PaymentReceipt; invoice?: string }
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

/** How a provider is paid, as far as the app knows. The app never pays a model. */
export type PayRail = 'none' | 'fiat';
/** Who gets paid when a provider answers. Host-derived; the window cannot set it. */
export type Pays = { to: string | null; rail: PayRail };

/** `ai_providers`. Remote ones are off unless this computer's settings turn them on. */
export type ProviderView = {
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  host: string | null;
  model: string | null;
  note: string | null;
  pays: Pays;
  /** `null`: nothing leaves. Otherwise the preset a preview starts at. */
  data_leaves: Preset | null;
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

/** `ai_local_status`: loopback Ollama / llama.cpp, or a short how-to when none. */
export type LocalKind = 'ollama' | 'open_ai_compat';
export type LocalStatus = {
  running: boolean;
  kind: LocalKind | null;
  port: number | null;
  models: string[];
  selected: string | null;
  selected_port: number | null;
  howto: string;
};

/** Principal and explicit caller routing allowance, used for file quotes. */
export type PaymentQuote = { principal_msat: number; max_routing_fee_msat: number; total_msat: number };
