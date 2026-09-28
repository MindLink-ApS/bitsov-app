// Where the shell's data comes from: the Rust host (Tauri commands + the
// `node-live` event), or sample data in dev mode. The renderer never talks to
// the node directly — no socket, no HTTP, no token (Gate G2). Every node call
// is a host command.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NodeStatus, PairingView } from '../onboarding/pairing';
import type {
  OwnerContactApproval,
  FirstContactQuote,
  FundingAsk,
  FundingStatus,
  Introduction,
  SponsorOwnerApproval,
  SponsorCandidate,
  SponsorStatus,
  AiTopic,
  Disclosure,
  Preset,
  ProviderKind,
  ProviderView,
  RemoteAnswer,
  TopicRead,
  FileReceipt,
  InvoiceAmount,
  InvoiceView,
  InviteView,
  PaymentReceipt,
  RedeemView,
  RoomQuote,
  SendReceipt,
  SpendView,
  BudgetView,
  PresetId,
  FundingAddress,
  FundState,
  LiveEvent,
  LinkState,
  Message,
  NodeOverview,
  Peer,
  PriceQuote,
  EnergyRead,
  EnergySpan,
  MembraneRead,
  RestoreOutcome,
  Room,
  WalletOverview,
} from './types';

export interface Source {
  readonly mode: 'node' | 'sample';
  // first run
  nodeStatus(): Promise<NodeStatus>;
  pairingStatus(): Promise<PairingView>;
  pairingRetry(): Promise<PairingView>;
  identityRestore(mnemonic: string): Promise<RestoreOutcome>;
  fundState(): Promise<FundState | null>;
  fundStart(sats: number): Promise<FundState>;
  fundingAddress(): Promise<FundingAddress>;
  // control center (read / receive only)
  nodeOverview(): Promise<NodeOverview>;
  peers(): Promise<Peer[]>;
  rooms(): Promise<Room[]>;
  roomMembers(roomId: string): Promise<string[]>;
  messages(peer: string, before?: number): Promise<Message[]>;
  priceQuote(peer?: string): Promise<PriceQuote>;
  /** The door card: a stranger's signed quote before a first contact. */
  firstContactQuote(peer: string): Promise<FirstContactQuote>;
  /** K1: this node's signed introduction for the QR (read). */
  introductionMine(): Promise<Introduction>;
  /** K1: verify a scanned or pasted introduction. Local only: nothing is sent. */
  introductionRead(text: string): Promise<Introduction>;
  /** K1 Continue: the node dials the introduced node, unprivileged. Pays nothing. */
  introductionOpen(text: string, allowLocal: boolean): Promise<Introduction>;
  /** K1 slice 2 (sponsor): whether the owner turned starter bitcoin on. */
  sponsorStatus(): Promise<SponsorStatus>;
  /** A fresh introduction with starter bitcoin (spend window). */
  sponsorOffer(): Promise<Introduction>;
  /** Review a newcomer's request. Pays nothing. */
  sponsorCandidate(request: string): Promise<SponsorCandidate>;
  /** Prepare the independent owner command; never sends an approval. */
  sponsorOwnerApproval(candidate: SponsorCandidate, code: string): Promise<SponsorOwnerApproval>;
  /** Recheck an unresolved payment; this cannot dispatch. */
  sponsorReconcile(introId: string): Promise<void>;
  sponsorCancel(introId: string): Promise<void>;
  /** K1 slice 2 (newcomer): ask for the offered gift. Nothing is sent. */
  sponsorRequest(text: string): Promise<FundingAsk>;
  sponsorRequestStatus(paymentHash: string): Promise<FundingStatus>;
  firstContactRequest(peer: string, maxMsat: number, budgetMsat: number): Promise<OwnerContactApproval | null>;
  firstContactStatus(id: string): Promise<OwnerContactApproval>;
  firstContactCancel(id: string): Promise<void>;
  wallet(): Promise<WalletOverview>;
  /** Node-wide energy (genome N1). Call only when the overview lists `energy_v1`. */
  energy(span: EnergySpan): Promise<EnergyRead>;
  /** The node's membrane ring, newest first (genome N2). Only with `membrane_v1`. */
  membrane(limit?: number): Promise<MembraneRead>;
  /** Subscribe to live events; resolves to an unsubscribe. */
  onLive(handler: (event: LiveEvent) => void): Promise<() => void>;
  /**
   * Ask the host to re-send the current `/ws` link state as a `link` live event.
   * Call it after `onLive` resolves: the socket may have opened before anyone listened.
   */
  liveLink(): Promise<LinkState | null>;
  // actions: spending ones are refused by the host outside the owner's spend window
  spendStatus(): Promise<SpendView>;
  /** The owner's one tap: open the short spend window, or ask the node for spend. */
  spendRequest(): Promise<SpendView>;
  spendLock(): Promise<SpendView>;
  spendReconcile(): Promise<string>;
  /**
   * A message pays inside the owner's budget with no prompt. `firstContactMsat`
   * is the owner's one-time OK for someone not yet budgeted, with their budget.
   */
  send(recipient: string, isRoom: boolean, plaintext: string, maxMsat: number, maxRecipientMsat?: Record<string, number>, firstContactMsat?: number): Promise<SendReceipt>;
  // budgets (B2): numbers the host keeps; the approval itself stays in host memory
  budgetStatus(): Promise<BudgetView>;
  /** The owner's one approval for a daily total. Lowering an open one needs no new approval. */
  budgetApprove(ceilingMsat: number, preset: PresetId): Promise<BudgetView>;
  /** Set or lower a budget within the daily total; 0 forgets the contact. */
  budgetSet(target: string, room: boolean, limitMsat: number): Promise<BudgetView>;
  budgetPause(): Promise<BudgetView>;
  budgetResume(): Promise<BudgetView>;
  roomQuote(roomId: string): Promise<RoomQuote>;
  invoiceCreate(amountMsat: number, note: string): Promise<InvoiceView>;
  invoiceAmount(bolt11: string): Promise<InvoiceAmount>;
  pay(bolt11: string, amountMsat: number, maxMsat: number): Promise<PaymentReceipt>;
  keysend(destPubkey: string, amountMsat: number, memo: string | null, maxMsat: number): Promise<PaymentReceipt>;
  inviteCreate(invitee: string, addr: string, hours: number): Promise<InviteView>;
  inviteRedeem(invite: string): Promise<RedeemView>;
  filePrice(): Promise<number>;
  fileSend(recipient: string, filename: string, mimeType: string, dataB64: string, maxMsat: number): Promise<FileReceipt>;
  // AI track: the host reads through its broker; a remote model gets only a body the owner saw
  aiRead(topic: AiTopic, sinceMs: number | null): Promise<TopicRead>;
  aiProviders(): Promise<ProviderView[]>;
  /** Prepare, never send. */
  aiDisclose(provider: ProviderKind, topic: AiTopic, sinceMs: number | null, preset: Preset, question: string): Promise<Disclosure>;
  /** Send the prepared body, once. Takes the id only. */
  aiSend(disclosureId: string): Promise<RemoteAnswer>;
  aiCancel(disclosureId: string): Promise<boolean>;
}

export const LIVE_EVENT = 'node-live';

export const hostSource: Source = {
  mode: 'node',
  nodeStatus: () => invoke<NodeStatus>('node_status'),
  pairingStatus: () => invoke<PairingView>('pairing_status'),
  pairingRetry: () => invoke<PairingView>('pairing_retry'),
  identityRestore: (mnemonic) => invoke<RestoreOutcome>('identity_restore', { mnemonic }),
  fundState: () => invoke<FundState | null>('fund_state'),
  fundStart: (sats) => invoke<FundState>('fund_start', { funding_amount_sats: sats }),
  fundingAddress: () => invoke<FundingAddress>('funding_address'),
  nodeOverview: () => invoke<NodeOverview>('node_overview'),
  peers: () => invoke<Peer[]>('peers_list'),
  rooms: () => invoke<Room[]>('rooms_list'),
  roomMembers: (roomId) => invoke<string[]>('room_members', { room_id: roomId }),
  messages: (peer, before) => invoke<Message[]>('messages_list', { peer, before: before ?? null }),
  priceQuote: (peer) => invoke<PriceQuote>('price_quote', { peer: peer ?? null }),
  firstContactQuote: (peer) => invoke<FirstContactQuote>('first_contact_quote', { peer }),
  introductionMine: () => invoke<Introduction>('introduction_mine'),
  introductionRead: (text) => invoke<Introduction>('introduction_read', { text }),
  introductionOpen: (text, allowLocal) => invoke<Introduction>('introduction_open', { text, allow_local: allowLocal }),
  sponsorStatus: () => invoke<SponsorStatus>('sponsor_status'),
  sponsorOffer: () => invoke<Introduction>('sponsor_offer'),
  sponsorCandidate: (request) => invoke<SponsorCandidate>('sponsor_candidate', { request }),
  sponsorOwnerApproval: (candidate, code) => invoke<SponsorOwnerApproval>('sponsor_owner_approval', { candidate, code }),
  sponsorReconcile: (introId) => invoke<void>('sponsor_reconcile', { intro_id: introId }),
  sponsorCancel: (introId) => invoke<void>('sponsor_cancel', { intro_id: introId }),
  sponsorRequest: (text) => invoke<FundingAsk>('sponsor_request', { text }),
  sponsorRequestStatus: (paymentHash) => invoke<FundingStatus>('sponsor_request_status', { payment_hash: paymentHash }),
  firstContactRequest: (recipient, maxMsat, budgetMsat) => invoke<OwnerContactApproval | null>('first_contact_request', { recipient, max_msat: maxMsat, contact_budget_msat: budgetMsat }),
  firstContactStatus: (id) => invoke<OwnerContactApproval>('first_contact_status', { id }),
  firstContactCancel: (id) => invoke<void>('first_contact_cancel', { id }),
  wallet: () => invoke<WalletOverview>('payments_overview'),
  energy: (span) => invoke<EnergyRead>('energy_read', { span }),
  membrane: (limit) => invoke<MembraneRead>('membrane_read', { limit: limit ?? null }),
  onLive: (handler) => listen<LiveEvent>(LIVE_EVENT, (e) => handler(e.payload)),
  liveLink: () => invoke<LinkState | null>('live_link'),
  spendStatus: () => invoke<SpendView>('spend_status'),
  spendRequest: () => invoke<SpendView>('spend_request'),
  spendLock: () => invoke<SpendView>('spend_lock'),
  spendReconcile: () => invoke<string>('spend_reconcile'),
  send: (recipient, isRoom, plaintext, maxMsat, maxRecipientMsat, firstContactMsat) =>
    invoke<SendReceipt>('message_send', { recipient, is_room: isRoom, plaintext, max_msat: maxMsat, max_recipient_msat: maxRecipientMsat ?? null, first_contact_msat: firstContactMsat ?? null }),
  budgetStatus: () => invoke<BudgetView>('budget_status'),
  budgetApprove: (ceilingMsat, preset) => invoke<BudgetView>('budget_approve', { ceiling_msat: ceilingMsat, preset }),
  budgetSet: (target, room, limitMsat) => invoke<BudgetView>('budget_set', { target, room, limit_msat: limitMsat }),
  budgetPause: () => invoke<BudgetView>('budget_pause'),
  budgetResume: () => invoke<BudgetView>('budget_resume'),
  roomQuote: (roomId) => invoke<RoomQuote>('room_quote', { room_id: roomId }),
  invoiceCreate: (amountMsat, note) => invoke<InvoiceView>('invoice_create', { amount_msat: amountMsat, note, expiry_secs: null }),
  invoiceAmount: (bolt11) => invoke<InvoiceAmount>('invoice_amount', { bolt11 }),
  pay: (bolt11, amountMsat, maxMsat) => invoke<PaymentReceipt>('payment_pay', { bolt11, amount_msat: amountMsat, max_msat: maxMsat }),
  keysend: (destPubkey, amountMsat, memo, maxMsat) =>
    invoke<PaymentReceipt>('payment_keysend', { dest_pubkey: destPubkey, amount_msat: amountMsat, memo, max_msat: maxMsat }),
  inviteCreate: (invitee, addr, hours) => invoke<InviteView>('invite_create', { invitee, addr, hours }),
  inviteRedeem: (invite) => invoke<RedeemView>('invite_redeem', { invite }),
  filePrice: () => invoke<number>('file_price'),
  fileSend: (recipient, filename, mimeType, dataB64, maxMsat) =>
    invoke<FileReceipt>('file_send', { recipient, filename, mime_type: mimeType, data_b64: dataB64, max_msat: maxMsat }),
  aiRead: (topic, sinceMs) => invoke<TopicRead>('ai_read', { topic, since_ms: sinceMs }),
  aiProviders: () => invoke<ProviderView[]>('ai_providers'),
  aiDisclose: (provider, topic, sinceMs, preset, question) =>
    invoke<Disclosure>('ai_disclose', { provider, topic, since_ms: sinceMs, preset, question }),
  aiSend: (disclosureId) => invoke<RemoteAnswer>('ai_send', { disclosure_id: disclosureId }),
  aiCancel: (disclosureId) => invoke<boolean>('ai_cancel', { disclosure_id: disclosureId }),
};

/** Running inside the Tauri host (vs. a plain browser tab on the Vite server). */
export const inHost = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type SampleStart = 'shell' | 'first-run';

/**
 * Dev mode: sample data when there is no host (a browser on `npm run dev`), or
 * when the URL asks for it (`?sample`, `?sample=first-run`). Never in a release
 * bundle unless there is also no host, which a release never lacks.
 */
export function sampleRequest(search: string, hosted: boolean, dev: boolean): SampleStart | null {
  const params = new URLSearchParams(search);
  const asked = params.get('sample') ?? params.get('mock');
  if (asked !== null && (dev || !hosted)) return asked === 'first-run' ? 'first-run' : 'shell';
  if (!hosted) return 'shell';
  return null;
}
