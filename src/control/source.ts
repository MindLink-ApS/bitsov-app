import type { AddInput, AddView, JoinInput, JoinView } from '../onboarding/AddDevice';
import type { WatchSample, WatchUpdate } from './watches';
import type { AssistantId, AssistantThread, ThreadRequest, LocalTurn } from './assistants';
import type { ApprovalRequest, ApprovalView, DeviceKeysView } from './ownerApproval';
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
  FrontDoor,
  FrontDoorPublish,
  PorchCard,
  PorchRead,
  Introduction,
  SponsorOwnerApproval,
  SponsorCandidate,
  SponsorStatus,
  AiTopic,
  Disclosure,
  LocalStatus,
  Preset,
  ProviderKind,
  ProviderView,
  RemoteAnswer,
  TopicRead,
  FileReceipt,
  VoiceBlob,
  FileSaveResult,
  CallQuote,
  CallReceipt,
  InvoiceAmount,
  InvoiceStatus,
  InvoiceView,
  InviteView,
  PaymentReceipt,
  RedeemView,
  RoomQuote,
  SendReceipt,
  SpendView,
  DeviceView,
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
  PaymentQuote,
  EnergyRead,
  EnergySpan,
  MembraneRead,
  RestoreOutcome,
  Room,
  WalletOverview,
} from './types';

export type RemotePreviewView = {
  endpoint: string;
  node_id_fingerprint: string;
  hosted_by?: string | null;
};

export type RemoteImportView = {
  endpoint: string;
  node_id_fingerprint: string;
  hosted_by?: string | null;
  restart_required: boolean;
};

export interface Source {
  readonly mode: 'node' | 'sample';
  // first run
  nodeStatus(): Promise<NodeStatus>;
  nodeUnlock(): Promise<void>;
  /** Android: unlock with the node password the owner typed. The host keeps it only for nodeUnlockRemember. */
  nodeUnlockPassword(password: string): Promise<void>;
  /** Android: save (fingerprint-protected) or discard the password the node just accepted. */
  nodeUnlockRemember(remember: boolean): Promise<void>;
  nodeRepairInitialized(confirmed: boolean): Promise<void>;
  nodeRepairPriceFloor(confirmed: boolean): Promise<void>;
  pairingStatus(): Promise<PairingView>;
  trustAcknowledge(nodeId: string, remote: boolean, legacy: boolean): Promise<boolean>;
  pairingRetry(): Promise<PairingView>;
  remoteAccessForget(): Promise<void>;
  remoteAccessPreview(link: string): Promise<RemotePreviewView>;
  remoteAccessImport(link: string): Promise<RemoteImportView>;
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
  /** `GET /messages?room=`: a bound room's thread, both directions, oldest first; pages count whole messages. */
  roomThread(room: string, before?: number, limit?: number): Promise<Message[]>;
  priceQuote(peer?: string): Promise<PriceQuote>;
  /** The door card: a stranger's signed quote before a first contact. */
  firstContactQuote(peer: string): Promise<FirstContactQuote>;
  /** K1: this node's signed introduction for the QR (read). */
  introductionMine(): Promise<Introduction>;
  /** K1: verify a scanned or pasted introduction. Local only: nothing is sent. */
  introductionRead(text: string): Promise<Introduction>;
  /** K1: Continue: the node dials the introduced node, unprivileged. Pays nothing. */
  introductionOpen(text: string, allowLocal: boolean): Promise<Introduction>;
  /** Front door: this node's published card (read), or missing. */
  frontDoorMine(): Promise<FrontDoor>;
  /** Front door: verify a pasted/scanned card locally. Never dials. */
  frontDoorRead(text: string): Promise<FrontDoor>;
  /** Front door: dial unprivileged so Knock can use first contact. */
  frontDoorOpen(text: string, allowLocal: boolean): Promise<FrontDoor>;
  /** Front door: Admin publish / update (signs, bumps seq). */
  frontDoorPublish(fields: FrontDoorPublish): Promise<FrontDoor>;
  /** Front door: blake3-hex of base64 bytes (avatar/media/CV prep). */
  frontDoorHashBytes(bytesB64: string): Promise<string>;
  /** Free path availability and price (`porch_quote_v1`); legacy nodes estimate. */
  porchQuote(peer: string, path: string): Promise<PaymentQuote>;
  /** One paid read of the card (`/front-door.json`) or a flat page, under `maxMsat`. Never retried. */
  porchRead(peer: string, path: string, maxMsat: number): Promise<PorchRead>;
  /** Cards this node holds from earlier reads, verified again. Pays nothing. */
  porchCards(): Promise<PorchCard[]>;
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
  firstContactRequest(peer: string, maxMsat: number, budgetMsat?: number): Promise<OwnerContactApproval | null>;
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
  /** Withdraw the pending request at the node, then forget it. */
  spendCancel(): Promise<SpendView>;
  /** Owner ticket creation, comparison and hardware-signed delegation. */
  addDevice(input: AddInput): Promise<AddView>;
  joinDevice(input: JoinInput): Promise<JoinView>;
  /** This device's hardware approvals: where the registration stands. */
  deviceKeyStatus(): Promise<DeviceView>;
  /** Create the enclave key, prove it with Touch ID, ask the owner once. */
  deviceKeyRegister(): Promise<DeviceView>;
  deviceKeyCancel(): Promise<DeviceView>;
  // Owner approval from an enrolled owner device (owner_device_approval_v1).
  // Contract, host duties and error mapping: src/control/ownerApproval.ts.
  /** Ask the node for an owner approval (any pairing). */
  approvalRequest(request: ApprovalRequest): Promise<ApprovalView>;
  /** This pairing's own request, as the node sees it now (404 → approval_unknown). */
  approvalStatus(opId: string): Promise<ApprovalView>;
  /** Requests this owner device may approve (never its own pairing's). Remote pairings only. */
  approvalsPending(): Promise<ApprovalView[]>;
  /** Approve with Touch ID: the host re-reads the op, checks `approvalMessage` is unchanged, signs it, posts it. */
  approvalApprove(opId: string, approvalMessage: string): Promise<ApprovalView>;
  /** Whether this pairing can approve, and the node's owner devices. */
  deviceKeys(): Promise<DeviceKeysView>;
  /** One contact's envelope, signed with Touch ID; null takes the host default. */
  /** The host names the contact in the Touch ID dialog from the node's own peer list. */
  relationApprove(peer: string, budgetMsat: number | null, perActMaxMsat: number | null): Promise<SpendView>;
  spendReconcile(): Promise<string>;
  /**
   * A message pays inside the owner's budget with no prompt. `firstContactMsat`
   * is the owner's one-time OK for someone not yet budgeted, with their budget.
   */
  send(recipient: string, isRoom: boolean, plaintext: string, maxMsat: number, maxRecipientMsat?: Record<string, number>, firstContactMsat?: number): Promise<SendReceipt>;
  /**
   * Retry a paid, undelivered message through its own journal record. Without
   * `approvedMsat` it pays nothing new (the node is capped at zero; the host
   * answers `retry_needs_admission` with the price still due); with it, the
   * owner approved that all-in price and the node pays at most that.
   */
  retry(recipient: string, plaintext: string, approvedMsat?: number): Promise<SendReceipt>;
  /** Stop retrying the paid, undelivered message `pendingId` names. Dispatches nothing. */
  dismissUndelivered(pendingId: string): Promise<string>;
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
  /** Read only: whether an invoice we issued was paid to this node. */
  invoiceStatus(bolt11: string): Promise<InvoiceStatus>;
  pay(bolt11: string, amountMsat: number, maxMsat: number): Promise<PaymentReceipt>;
  keysend(destPubkey: string, amountMsat: number, memo: string | null, maxMsat: number): Promise<PaymentReceipt>;
  inviteCreate(invitee: string, addr: string, hours: number): Promise<InviteView>;
  inviteRedeem(invite: string): Promise<RedeemView>;
  filePrice(): Promise<PaymentQuote>;
  fileSend(recipient: string, filename: string, mimeType: string, dataB64: string, maxMsat: number, firstContactMsat?: number): Promise<FileReceipt>;
  /** Read-only: a received voice note (kind 200, audio/*) by its message id. Never pays. */
  voiceNote(messageId: string): Promise<VoiceBlob>;
  /** Read-only: any received kind-200 file by message id. Never pays. Refuses over 1.4 MB. */
  fileFetch(messageId: string): Promise<VoiceBlob>;
  /** Fetch then save via the native dialog (user path only). Never auto-saves. */
  fileSave(messageId: string): Promise<FileSaveResult>;
  /** Read-only: what calling this contact costs. */
  callQuote(peer: string): Promise<CallQuote>;
  /** One paid call signal (kinds 400-403) under the message budget rules. */
  callSignal(peer: string, kind: number, plaintext: string, maxMsat: number): Promise<CallReceipt>;
  // AI track: the host reads through its broker; a remote model gets only a body the owner saw
  aiRead(topic: AiTopic, sinceMs: number | null, assistant?: AssistantId): Promise<TopicRead>;
  aiLocalTurn(assistant: AssistantId, question: string, draftText: string): Promise<LocalTurn>;
  aiWatchPoll(assistant: AssistantId, watch: WatchSample, revision: string | null): Promise<WatchUpdate | null>;
  aiThread(assistant: AssistantId, thread: ThreadRequest): Promise<AssistantThread>;
  aiProviders(): Promise<ProviderView[]>;
  /** Prepare, never send. */
  aiDisclose(provider: ProviderKind, topic: AiTopic, sinceMs: number | null, preset: Preset, question: string, assistant?: AssistantId): Promise<Disclosure>;
  /** Send the prepared body, once. Takes the id only. */
  aiSend(disclosureId: string): Promise<RemoteAnswer>;
  aiCancel(disclosureId: string): Promise<boolean>;
  /** Probe loopback for a local model server (Ollama / llama.cpp). */
  aiLocalStatus(port?: number | null): Promise<LocalStatus>;
  /** Pick an Own-tier model on loopback. Remotes stay off. */
  aiLocalSelect(model: string, port?: number | null): Promise<ProviderView[]>;
  /** Clear the Own model pick; answers fall back to rules. */
  aiLocalClear(): Promise<ProviderView[]>;
}

export const LIVE_EVENT = 'node-live';

export const hostSource: Source = {
  mode: 'node',
  nodeStatus: () => invoke<NodeStatus>('node_status'),
  nodeUnlock: () => invoke<void>('node_unlock'),
  nodeUnlockPassword: (password) => invoke<void>('node_unlock_password', { password }),
  nodeUnlockRemember: (remember) => invoke<void>('node_unlock_remember', { remember }),
  pairingStatus: () => invoke<PairingView>('pairing_status'),
  trustAcknowledge: (node_id, remote, legacy) => invoke<boolean>('trust_acknowledge', { node_id, remote, legacy }),
  pairingRetry: () => invoke<PairingView>('pairing_retry'),
  remoteAccessForget: () => invoke<void>('remote_access_forget'),
  remoteAccessPreview: (link) => invoke<RemotePreviewView>('remote_access_preview', { link }),
  remoteAccessImport: (link) => invoke<RemoteImportView>('remote_access_import', { link }),
  nodeRepairInitialized: (confirmed) => invoke<void>('node_repair_initialized', { confirmed }),
  nodeRepairPriceFloor: (confirmed) => invoke<void>('node_repair_price_floor', { confirmed }),
  identityRestore: (mnemonic) => invoke<RestoreOutcome>('identity_restore', { mnemonic }),
  fundState: () => invoke<FundState | null>('fund_state'),
  fundStart: (sats) => invoke<FundState>('fund_start', { funding_amount_sats: sats }),
  fundingAddress: () => invoke<FundingAddress>('funding_address'),
  nodeOverview: () => invoke<NodeOverview>('node_overview'),
  peers: () => invoke<Peer[]>('peers_list'),
  rooms: () => invoke<Room[]>('rooms_list'),
  roomMembers: (roomId) => invoke<string[]>('room_members', { room_id: roomId }),
  messages: (peer, before) => invoke<Message[]>('messages_list', { peer, before: before ?? null }),
  roomThread: (room, before, limit) => invoke<Message[]>('room_thread', { room, before: before ?? null, limit: limit ?? null }),
  priceQuote: (peer) => invoke<PriceQuote>('price_quote', { peer: peer ?? null }),
  firstContactQuote: (peer) => invoke<FirstContactQuote>('first_contact_quote', { peer }),
  introductionMine: () => invoke<Introduction>('introduction_mine'),
  introductionRead: (text) => invoke<Introduction>('introduction_read', { text }),
  introductionOpen: (text, allowLocal) => invoke<Introduction>('introduction_open', { text, allow_local: allowLocal }),
  frontDoorMine: () => invoke<FrontDoor>('front_door_mine'),
  frontDoorRead: (text) => invoke<FrontDoor>('front_door_read', { text }),
  frontDoorOpen: (text, allowLocal) => invoke<FrontDoor>('front_door_open', { text, allow_local: allowLocal }),
  frontDoorPublish: (fields) =>
    invoke<FrontDoor>('front_door_publish', {
      fields: {
        display_name: fields.display_name,
        tagline: fields.tagline ?? '',
        about: fields.about ?? '',
        kind: fields.kind ?? null,
        admission_msat: fields.admission_msat ?? null,
        message_msat: fields.message_msat ?? null,
        page_msat: fields.page_msat ?? null,
        avatar: fields.avatar ?? null,
        media: fields.media ?? [],
        cv: fields.cv ?? null,
        links: fields.links ?? [],
      },
    }),
  frontDoorHashBytes: (bytesB64) => invoke<string>('front_door_hash_bytes', { bytes_b64: bytesB64 }),
  porchQuote: (peer, path) => invoke<PaymentQuote>('porch_quote', { peer, path }),
  porchRead: (peer, path, maxMsat) => invoke<PorchRead>('porch_read', { peer, path, max_msat: maxMsat }),
  porchCards: () => invoke<PorchCard[]>('porch_cards'),
  sponsorStatus: () => invoke<SponsorStatus>('sponsor_status'),
  sponsorOffer: () => invoke<Introduction>('sponsor_offer'),
  sponsorCandidate: (request) => invoke<SponsorCandidate>('sponsor_candidate', { request }),
  sponsorOwnerApproval: (candidate, code) => invoke<SponsorOwnerApproval>('sponsor_owner_approval', { candidate, code }),
  sponsorReconcile: (introId) => invoke<void>('sponsor_reconcile', { intro_id: introId }),
  sponsorCancel: (introId) => invoke<void>('sponsor_cancel', { intro_id: introId }),
  sponsorRequest: (text) => invoke<FundingAsk>('sponsor_request', { text }),
  sponsorRequestStatus: (paymentHash) => invoke<FundingStatus>('sponsor_request_status', { payment_hash: paymentHash }),
  firstContactRequest: (recipient, maxMsat, budgetMsat) => invoke<OwnerContactApproval | null>('first_contact_request', { recipient, max_msat: maxMsat, contact_budget_msat: budgetMsat ?? null }),
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
  spendCancel: () => invoke<SpendView>('spend_cancel'),
  addDevice: input => invoke<AddView>('add_device', { input }),
  joinDevice: input => invoke<JoinView>('join_device', { input }),
  deviceKeyStatus: () => invoke<DeviceView>('device_key_status'),
  deviceKeyRegister: () => invoke<DeviceView>('device_key_register'),
  approvalRequest: (request) => invoke<ApprovalView>('owner_approval_request', { request }),
  approvalStatus: (opId) => invoke<ApprovalView>('owner_approval_status', { opId }),
  approvalsPending: () => invoke<ApprovalView[]>('owner_approvals_pending'),
  approvalApprove: (opId, approvalMessage) => invoke<ApprovalView>('owner_approval_approve', { opId, approvalMessage }),
  deviceKeys: () => invoke<DeviceKeysView>('owner_device_keys'),
  deviceKeyCancel: () => invoke<DeviceView>('device_key_cancel'),
  relationApprove: (peer, budgetMsat, perActMaxMsat) =>
    invoke<SpendView>('relation_approve', { peer, budget_msat: budgetMsat, per_act_max_msat: perActMaxMsat }),
  spendReconcile: () => invoke<string>('spend_reconcile'),
  send: (recipient, isRoom, plaintext, maxMsat, maxRecipientMsat, firstContactMsat) =>
    invoke<SendReceipt>('message_send', { recipient, is_room: isRoom, plaintext, max_msat: maxMsat, max_recipient_msat: maxRecipientMsat ?? null, first_contact_msat: firstContactMsat ?? null }),
  retry: (recipient, plaintext, approvedMsat) => invoke<SendReceipt>('message_retry', { recipient, plaintext, approved_msat: approvedMsat ?? null }),
  dismissUndelivered: (pendingId) => invoke<string>('spend_dismiss_undelivered', { pending_id: pendingId }),
  budgetStatus: () => invoke<BudgetView>('budget_status'),
  budgetApprove: (ceilingMsat, preset) => invoke<BudgetView>('budget_approve', { ceiling_msat: ceilingMsat, preset }),
  budgetSet: (target, room, limitMsat) => invoke<BudgetView>('budget_set', { target, room, limit_msat: limitMsat }),
  budgetPause: () => invoke<BudgetView>('budget_pause'),
  budgetResume: () => invoke<BudgetView>('budget_resume'),
  roomQuote: (roomId) => invoke<RoomQuote>('room_quote', { room_id: roomId }),
  invoiceCreate: (amountMsat, note) => invoke<InvoiceView>('invoice_create', { amount_msat: amountMsat, note, expiry_secs: null }),
  invoiceAmount: (bolt11) => invoke<InvoiceAmount>('invoice_amount', { bolt11 }),
  invoiceStatus: (bolt11) => invoke<InvoiceStatus>('invoice_status', { bolt11 }),
  pay: (bolt11, amountMsat, maxMsat) => invoke<PaymentReceipt>('payment_pay', { bolt11, amount_msat: amountMsat, max_msat: maxMsat }),
  keysend: (destPubkey, amountMsat, memo, maxMsat) =>
    invoke<PaymentReceipt>('payment_keysend', { dest_pubkey: destPubkey, amount_msat: amountMsat, memo, max_msat: maxMsat }),
  inviteCreate: (invitee, addr, hours) => invoke<InviteView>('invite_create', { invitee, addr, hours }),
  inviteRedeem: (invite) => invoke<RedeemView>('invite_redeem', { invite }),
  filePrice: () => invoke<PaymentQuote>('file_price'),
  fileSend: (recipient, filename, mimeType, dataB64, maxMsat, firstContactMsat) =>
    invoke<FileReceipt>('file_send', { recipient, filename, mime_type: mimeType, data_b64: dataB64, max_msat: maxMsat, first_contact_msat: firstContactMsat ?? null }),
  voiceNote: (messageId) => invoke<VoiceBlob>('voice_note_fetch', { message_id: messageId }),
  fileFetch: (messageId) => invoke<VoiceBlob>('file_fetch', { message_id: messageId }),
  fileSave: (messageId) => invoke<FileSaveResult>('file_save', { message_id: messageId }),
  callQuote: (peer) => invoke<CallQuote>('call_quote', { peer }),
  callSignal: (peer, kind, plaintext, maxMsat) => invoke<CallReceipt>('call_signal', { peer, kind, plaintext, max_msat: maxMsat }),
  aiRead: (topic, sinceMs, assistant) => invoke<TopicRead>('ai_read', { topic, since_ms: sinceMs, ...(assistant ? { assistant } : {}) }),
  aiLocalTurn: (assistant, question, draftText) => invoke<LocalTurn>('ai_read', { assistant, local_turn: { question, draft_text: draftText } }),
  aiWatchPoll: (assistant, sample, revision) => invoke<WatchUpdate | null>('ai_read', { assistant, watch: { sample, revision } }),
  aiThread: (assistant, thread) => invoke<AssistantThread>('ai_read', { assistant, thread }),
  aiProviders: () => invoke<ProviderView[]>('ai_providers'),
  aiDisclose: (provider, topic, sinceMs, preset, question, assistant) =>
    invoke<Disclosure>('ai_disclose', { provider, topic, since_ms: sinceMs, preset, question, ...(assistant ? { assistant } : {}) }),
  aiSend: (disclosureId) => invoke<RemoteAnswer>('ai_send', { disclosure_id: disclosureId }),
  aiCancel: (disclosureId) => invoke<boolean>('ai_cancel', { disclosure_id: disclosureId }),
  aiLocalStatus: (port) => invoke<LocalStatus>('ai_local_status', { port: port ?? null }),
  aiLocalSelect: (model, port) =>
    invoke<ProviderView[]>('ai_local_select', { model, port: port ?? null }),
  aiLocalClear: () => invoke<ProviderView[]>('ai_local_clear'),
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
