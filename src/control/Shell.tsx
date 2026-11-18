import { IncomingCallAlerts } from './IncomingCallAlerts';
import { createMissedCalls } from './missedCalls';
import { createPhoneLayout, createPhoneNavigationGuard, PhoneTabs, type PhoneTab } from './PhoneShell';
import { MediaView } from './CallMedia';
import { knownCallLimit, RingBudgetNote } from './ringBudget';
import { createMessageNotifications, NotificationSettings } from './messageNotifications';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { OwnerApprovalSheets } from './OwnerApprovalSheet';
import { FirstSpendSheet, type FirstSpendChoice } from './FirstSpendSheet';
import { createAmountDraft } from './amountDraft';
import { t as tr, possessive, languagePref, setLanguagePref, type LanguagePref } from '../i18n';
import { CallRepairs } from './CallRepairs';
import { checkFacts, type PaymentFacts, provenUnpaid } from './paymentOutcome';
import { hostText } from './hostCopy';
import { AddDevice } from '../onboarding/AddDevice';
import { PairWords } from '../onboarding/PairWords';
import { CALL_STATE_WORD, OnCallPill } from './OnCallPill';
import { ConnectionCard, nextLastCall, type NodeAnswer, type StunSource, type TrackedCall } from './ConnectionCard';
import { watchSamples, type WatchSamples, type WatchUpdates } from './watches';
import { ASSISTANTS, type AssistantId } from './assistants';
import { PendingApproval } from '../onboarding/LockedNode';
import { PairingActivityProvider, usePairingActivity } from '../pairingActivity';
import { createMessageEntrance } from './messageEntrance';
import { LocalNodeSwitch } from '../onboarding/LocalNodeSwitch';
import { PairAnotherNode } from '../onboarding/PairAnotherNode';
import { cameraQrScannerAvailable, scanPairingLinkWithCamera } from '../cameraQrScanner';
import { appPlatform, deviceWord, isMobilePlatform } from '../platform';
import { DeviceApprovals } from '../onboarding/DeviceApprovals';
import { approvalMemory, BreakerCard, breakerReason, OwnerApprovals, OwnerApprovalWait, type BreakerReason } from './OwnerApprovals';
import { OWNER_DEVICE_APPROVAL, OWNER_DEVICE_BREAKER_RESET, refusalText, type ApprovalRequest, type ApprovalView, type DeviceKeysView } from './ownerApproval';
import { HubTrustInfo } from './HubTrust';
import { CopyVersions, VersionRows } from './BuildVersions';
import { pollingSource } from './polling';
import { deliveryPoller } from './deliveryPoll';
import { readSpendPreset, saveSpendPreset } from './prefs';
import { WelcomeHome } from './WelcomeHome';
import { ChainNotice } from './ChainNotice';
import { DelayedSpinner } from './DelayedSpinner';
import { StreamFrame, StreamNoteContext } from './StreamFrame';
import { isChainUnavailable, MONEY_NOT_READY, readinessLine, readinessSource } from './readiness';
import { batch, createEffect, createMemo, createResource, createSignal, createUniqueId, For, type JSX, Match, on, onCleanup, onMount, Show, Switch, untrack } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { qrSvg } from '../qr';
import type { Proposal } from './ai';
import { AiTrack, createAiSession } from './AiTrack';
import { amount as fmtAmount, paidAmount, budgetNote, allIn, clock, day, feeCeiling, routingFee, sats, satsWhole, satUnit, shortId, uptime } from './format';
import { ambiguousThousands, amountText, inPaymentBounds, MAX_PAYMENT_MSAT, MIN_PAYMENT_MSAT, parseAmount } from './amountInput';
import { Organism } from './BodyPanel';
import { SoftError } from './SoftError';
import { DiscoverPanel, FrontDoorEditor } from './Discover';
import { OperatorDetails } from './OperatorDetails';
import { PorchPanel } from './Porch';
import { ContactPanel } from './ContactPanel';
import { onEscape } from './escapeStack';
import { custodyBadge, CustodyBadgeView } from './custody';
import { CopyButton, NO_CHANNELS, WalletPage, type WalletActions, type WalletTab } from './WalletPage';
import { artifactActivity, logActivity, type LoggedActivity } from './wallet';
import { mobileQrScannerAvailable, scanPairingLink } from '../pairingScanner';
import { answerCost, callCost, callPerPaymentMax, createCallEngine, NO_MEDIA_DEVICES, RECOVERY_CLOSING, IDLE as CALL_IDLE, isCallKind, isCallTrafficKind, signalCost, stunServer, type CallMedia, type CallView } from './call';
import { CallReportCopy } from './CallReportCopy';
import { createMeetingEngine, declineCost, inviteCost, joinCost, MAX_PARTICIPANTS, MEETING_IDLE, type LegState, type MeetingView, type ShownQuotes } from './meeting';
import { nodeRoutedAudio, nodeRoutedVideo, sealedAudio } from './callFlags';
import { AUDIO_PLAYOUT_DELAY_MS, createCallVideo, trackVideoSource, type VideoStatus } from './callVideo';
import { createNodeRoutedConnection, sealLabelScope, type SealState } from './nodeRoutedConnection';
import { waitUntilPaid, type MinutesDeps, type MinutesView } from './callMinutes';
import { hostCallSeal, hostMediaBridge, unavailableMediaBridge } from './mediaBridge';
import { createCallAudio } from './callAudio';
import { admitRoom, leaveRoom, localRoom, localRooms, newRoom, rememberRoom, ROOM_CAPABILITY, ROOM_PAGE, roomOf, sameRoom, sendRoom, type LegPlan, type LocalRoom } from './room';
import { NewRoomPanel, RoomThread, type RoomSend, type ThreadRead } from './RoomPanel';
import { blobUrl, duration, FILE_MAX_BYTES, fileNameOf, isVoiceNote, type Recording, startRecording, VOICE_MAX_MS } from './voice';
import { EMOJIS, insertEmoji } from './emoji';
import { cleanPurpose, hostReadProblem, invoicePaymentHash, NOT_PAYABLE_NOTE, type NotPayable, payeeView, readChatInvoice } from './bolt11';
import { safeImageMime, looksLikeSafeImageName, dataImageUrl } from './frontDoorMedia';
import type { PaymentReceipt, FileSaveResult, InvoiceAmount, InvoiceView, VoiceBlob, OpList, OpView, OperationState, NodeGrantSummary } from './types';
import {
  doorCard,
  gateWords,
  homeostasis,
  membraneLive,
  membraneNode,
  membraneRefused,
  membraneSeed,
  metabolism,
  nodeMetabolism,
  nucleus,
  organismCaps,
  outboundKind,
  type MembraneEntry,
} from './body';
import type { Source } from './source';
import {
  denom,
  setDenom,
  setStunPref,
  setStunOff,
  stunOff,
  effectiveStun,
  effectiveStunSource,
  setNodeStun,
  setThemePref,
  stunPref,
  themePref,
  type Denom,
  type ThemePref,
} from './prefs';
import { reconcileKeyChange, verifyState } from './petnames';
import {
  ADMISSION_MAX_MSAT,
  applyDelivery,
  applyLive,
  asActionError,
  peerNotReadyMessage,
  admissionCopy,
  undeliveredCopy,
  budgetStand,
  costToSend,
  deliveryFromReceipt,
  sentFileMessage,
  freshness,
  isBudgetStop,
  isOutgoing,
  isPorchKind,
  mergeMessages,
  messagesWorth,
  needsApproval,
  nodePill,
  type PillStatus,
  peerName,
  sentMessage,
  spendLine,
  streamItems,
  trackKey,
  type BudgetStand as BudgetStandT,
  type Deliveries,
  type Threads,
  type Unread,
  priceBreakdown,
  messagePerPaymentMax,
} from './state';
import type {
  CallQuote,
  AdmissionPrice,
  PrePaymentRefusals,
  OwnerContactApproval,
  FirstContactQuote,
  FundingAsk,
  FundingStatus,
  Introduction,
  Doorstep,
  SponsorKit,
  SponsorOwnerApproval,
  SponsorCandidate,
  SponsorStatus,
  ActionError,
  SendReceipt,
  Artifact,
  BudgetRow,
  BudgetView,
  Delivery,
  DoorCard,
  EnergyRead,
  LinkState,
  Message,
  NodeOverview,
  Peer,
  PresetId,
  PriceQuote,
  PaymentQuote,
  Room,
  RoomQuote,
  SpendView,
  DeviceView,
  TrackRef,
  WalletOverview,
} from './types';

/** How often each panel re-reads while the shell is open. Peers and balance have no live event. */
const REFRESH_MS = { overview: 10_000, peers: 15_000, wallet: 20_000, rooms: 30_000, door: 30_000, energy: 30_000, membrane: 30_000, clock: 5_000, spend: 3_000 } as const;

type Props = {
  onWatchSamples?: (read: (() => WatchSamples) | null) => void;
  watchUpdates?: WatchUpdates;
  watchError?: string | null;
  remote?: boolean;
  /** AuthMode::Local (rc7 fallback), independent of transport location. */
  localApproval?: boolean;
  spendScoped?: boolean;
  /** An Android or iOS build: no node of its own, so no local-node state in the pill. */
  phone?: boolean;
  /** The remote node's display label from its pairing link, if any. */
  hostedBy?: string | null;
  retryAfterSecs?: number | null;
  offline?: JSX.Element;
  onReconnect?: () => Promise<void>;
  source: Source;
  /** Setup completed for this trust boundary: keep the shell mounted. */
  active: boolean;
  /** Transient connection readiness, independent of shell visibility. */
  live?: boolean;
  /** When the status read last reached the node, and its round trip (the connection card). */
  nodeAnswer?: NodeAnswer | null;
  /** One status read (the connection card's Check now); reuses one in flight. */
  onCheckNode?: () => Promise<void>;
  /** A Check now read is in flight (held in App). */
  checkingNode?: boolean;
  /** The node is locked (for the connection card's wording). */
  nodeLocked?: boolean;
  ready: boolean;
  error: string | null;
  /** The pill's own ready/error, debounced in App so one missed status read does not flip it. */
  pillStatus?: PillStatus;
  ownId: string | null;
  /** First-run content shown in the centre until `active`. */
  firstRun: JSX.Element;
  /** Receive / fund UI for the Wallet panel. */
  fund?: (source: Source, blocked: () => boolean) => JSX.Element;
};

/** A draft the AI track prepared for one peer's composer. Applied once. */
export type Prefill = {
  seq: number;
  key: string;
  mode: 'message' | 'pay' | 'request';
  text: string;
  sats: number | null;
  /** Put back from an Unsent card: only into an empty box; the card ends when applied. */
  unsentId?: string;
};

/**
 * A composer's message box, as the send queue sees it. The queue gives text
 * back only into the same composer instance, on the same track, untouched
 * since the press; anything else becomes an Unsent card on its own track.
 */
export type SendBox = { id: number; key: () => string; revision: () => number; draft: () => string; setDraft: (text: string) => void; note: () => string | null; setNote: (text: string) => void };
/** Where a press was made: the composer instance and its revision then. */
export type PressedAt = { box: number; revision: number };
export type SendQueue = {
  /** One queue for the whole app, in press order, whichever composer pressed. */
  enqueue: (job: () => Promise<void>) => Promise<void>;
  /** A queued or approved message must not go out now (an earlier result is open). */
  held: () => boolean;
  /** Why a new press must wait (an unknown payment result, until checked), or null. */
  blocked: () => string | null;
  /** One settled message send: the hold, the text's way back, the note, the announcement. */
  settled: (r: Outcome<unknown>, track: TrackRef, text: string, at: PressedAt) => void;
  /** Its turn came while held: its bubble becomes "Waiting for payment check". */
  holdBack: (track: TrackRef, bubble: string, text: string) => void;
  /** Its turn came, but what it was approved for no longer holds: its bubble becomes a "Not sent" card with `reason`. */
  withdraw: (track: TrackRef, bubble: string, text: string, reason: string) => void;
  attach: (box: SendBox) => () => void;
  live: () => { text: string; seq: number };
};

/** The result of one action: its value, or why it did not happen. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/**
 * What the conversation can do. Messages pay inside the owner's budget; every
 * other spending call is refused by the host outside the ten-minute window.
 */
export type Actions = {
  remote?: () => boolean;
  localApproval?: () => boolean;
  spendScoped?: () => boolean;
  moneyBlocked: () => boolean;
  /** The request was made (open, or pending at the node), with the host's ids for it (#227). */
  approve: (callPeerOrBudget?: string | number) => Promise<ApprovalResult>;
  lock: () => Promise<void>;
  /** Withdraw the pending request at the node. */
  cancelSpend: () => Promise<void>;
  /** Bumped each time the owner's Cancel request succeeds: waits bound to a node request end with it. */
  spendCancels: () => number;
  /** This Mac's Touch ID approvals, as last read. */
  device: () => DeviceView | null;
  registerDevice: () => Promise<void>;
  /** Touch ID approvals live in Settings → Node; other places link there. */
  openNodeSettings?: () => void;
  /** The node approves spending and first contact from an enrolled owner device (owner_device_approval_v1). */
  ownerDeviceApproval?: () => boolean;
  cancelDevice: () => Promise<void>;
  /** One contact's envelope, signed with Touch ID. */
  approveContact: (peer: string, perActMsat: number | null) => Promise<TouchApproval>;
  /** The newest budget read applied (a stamp taken when the read started); see TouchApproval.readsFrom. */
  budgetReadApplied: () => number;
  /** An action's own response cleared the stamp and the read it started is still out: resolves when that read lands; else null. */
  followUpRead: () => Promise<void> | null;
  /** The contact the node last refused for having no envelope (`grant_no_envelope`). */
  noEnvelopeFor: () => string | null;
  reconcile: () => Promise<Outcome<string>>;
  pendingRevision: () => number;
  /** The owner's one approval for a daily total (B2). */
  /** The host took the approval (open, or waiting at the node), with its ids (#227). */
  approveBudget: (ceilingMsat: number, preset: PresetId) => Promise<ApprovalResult>;
  setBudget: (target: string, room: boolean, limitMsat: number) => Promise<Outcome<unknown>>;
  pauseAll: () => Promise<void>;
  /** Payments resumed (or the resume waits at the node), with its ids (#227). */
  resume: () => Promise<ApprovalResult>;
  send: (t: TrackRef, text: string, maxMsat: number, firstContactMsat?: number, sendingId?: string) => Promise<Outcome<unknown>>;
  /** Puts a message in the stream as "Sending · up to N" before its send runs; `send` replaces it. */
  beginSending: (t: TrackRef, text: string, capMsat: number, waiting?: boolean | 'allowed') => string;
  /**
   * A waiting bubble: `null` hands it to the send path (it becomes "Sending");
   * a reason ends it before anything was dispatched, kept whole as Unsent;
   * an empty reason drops it (its words went back to the box).
   */
  settleWaiting: (t: TrackRef, id: string, reason: string | null) => void;
  /** An Unsent card's text back into its own track's box (empty box only). */
  restoreUnsent: (t: TrackRef, id: string) => void;
  discardUnsent: (t: TrackRef, id: string) => void;
  /** The one app-level send queue (it outlives any composer). */
  queue: SendQueue;
  /** A message that did not go and paid nothing, kept whole on its track. */
  keepUnsent: (t: TrackRef, text: string, reason: string) => void;
  /**
   * Retry a paid, undelivered message through its own journal record. With
   * `approvedMsat`, the owner approved that price because admission may be due again.
   */
  retryDelivery: (t: TrackRef, artifactId: string, approvedMsat?: number) => Promise<Outcome<unknown>>;
  /** Stop retrying a paid, undelivered message. Dispatches nothing. */
  stopRetrying: (t: TrackRef | null, pendingId: string | null) => Promise<Outcome<string>>;
  /** The door card: a stranger's signed quote, or null when the node cannot give one. */
  doorQuote: (peer: string) => Promise<FirstContactQuote | null>;
  ownerRequest: (peer: string, cap: number, budget: number) => Promise<Outcome<OwnerContactApproval | null>>;
  ownerStatus: (id: string, recipient?: string, maxMsat?: number) => Promise<Outcome<OwnerContactApproval>>;
  /** Our node already holds an E2EE session with this contact: it admitted them, so a new client needs no first-contact approval. */
  knownAtNode?: (peer: string) => boolean;
  /** Owner approval v1 (requester side): ask for an approval on the owner's other device, and read it back. */
  approvalRequest: (request: ApprovalRequest) => Promise<Outcome<ApprovalView>>;
  approvalStatus: (opId: string) => Promise<Outcome<ApprovalView>>;
  /** The node offers device-approved breaker resets (sub-flag) on this remote pairing. */
  breakerResetOffered?: () => boolean;
  /** Re-read the budget and its grant (after a reset). */
  refreshBudget?: () => void;
  ownerCancel: (id: string) => Promise<void>;
  /** Create an invoice for an exact msat amount (never rounded here). */
  invoice: (t: TrackRef, msat: number, note: string) => Promise<Outcome<unknown>>;
  /** The host's read-only decode of an invoice: the only payee and amount shown. */
  readInvoice: (bolt11: string) => Promise<Outcome<InvoiceAmount>>;
  pay: (t: TrackRef, bolt11: string, msat: number) => Promise<Outcome<PaymentReceipt>>;
  keysend: (t: TrackRef, pubkey: string, msat: number, memo: string) => Promise<Outcome<PaymentReceipt>>;
  file: (t: TrackRef, file: File, maxMsat: number, firstContactMsat?: number) => Promise<Outcome<unknown>>;
  /** Read-only: a playable URL for a voice note in the thread. Never pays. */
  voiceUrl: (messageId: string) => Promise<string>;
  /** Read-only: fetch a received file (refuses over 1.4 MB). */
  fileFetch: (messageId: string) => Promise<VoiceBlob>;
  /** Save a received file via the native dialog. Never auto-saves. */
  fileSave: (messageId: string) => Promise<FileSaveResult>;
  /** Read-only: what calling this contact costs. */
  callQuote: (peer: string) => Promise<Outcome<CallQuote>>;
  /** Place a call after the price was shown. */
  placeCall: (peer: string, media: CallMedia, quote: CallQuote) => void;
  callActive: () => boolean;
  /** Read-only, display only: the current node grant for the call confirm's contact-budget line; null when unknown or stale. */
  callGrant?: () => NodeGrantSummary | null;
  /** Display only: the call limit (minutes) this box pinned on a reservation earlier this session; null when not seen. */
  callLimitMinutes?: () => number | null;
  callView?: () => CallView;
  /** Open the meeting planner with this contact picked. Pays nothing. */
  planMeeting: (peer: string) => void;
};

let artifactSeq = 0;

/** An artifact before it has an id; `at` defaults to now. Distributes over the union. */
type NewArtifact = Artifact extends infer A ? (A extends Artifact ? Omit<A, 'id' | 'at'> & { at?: number } : never) : never;

export function ControlCenter(props: Props) {
  const notifications = isTauri() && /Macintosh|Mac OS X/.test(navigator.userAgent) && !isMobilePlatform() ? createMessageNotifications() : null;
  onMount(() => { void notifications?.checkPermission(); });
  onCleanup(() => notifications?.dispose());
  const phoneLayout = createPhoneLayout();
  const phoneShell = () => props.active && phoneLayout();
  const phoneGuard = createPhoneNavigationGuard(phoneShell);
  const [phoneTab, setPhoneTab] = createSignal<PhoneTab>('chats');
  let phoneList: HTMLElement | undefined;
  let phoneOpener: HTMLElement | null = null;
  const phoneBack = () => {
    setTrack(null);
    queueMicrotask(() => { if (phoneOpener?.isConnected) phoneOpener.focus(); else phoneList?.focus(); });
  };
  let callPanel: HTMLElement | undefined;
  const [now, setNow] = createSignal(Date.now());
  const [overview, setOverview] = createSignal<NodeOverview | null>(null);
  const [readinessRefused, setReadinessRefused] = createSignal(false);
  const moneyBlocked = () => !live() || readinessRefused() || overview()?.money_ready === false;
  // The node's own STUN responder, if `/status` reports one (offered in Settings).
  const ownStun = createMemo<OwnStun | null>(() => {
    const o = overview();
    return o?.stun_port && o.stun_source === 'own'
      ? { port: o.stun_port, url: o.stun_url ?? null } : null;
  }, null, { equals: (a, b) => a?.port === b?.port && a?.url === b?.url });
  let overviewRevision = 0;
  const live = () => props.active && (props.live ?? (props.ready && !props.retryAfterSecs));
  const polling = pollingSource(() => props.source, live, () => props.remote === true);
  createEffect(() => { if (live()) polling.resume(); });
  onCleanup(polling.close);
  const source = readinessSource(() => polling.source, moneyBlocked, () => {
    overviewRevision += 1;
    setReadinessRefused(true);
    setOverview((old) => old ? { ...old, money_ready: false, readiness: null } : old);
  });
  // Only owner-authenticated /status supplies the node's STUN URL and source.
  createEffect(() => {
    const o = overview();
    const url = o?.stun_url ?? '';
    setNodeStun(stunServer(url).length ? url : null, o?.stun_source ?? null);
  });
  onCleanup(() => setNodeStun(null));
  const [peers, setPeers] = createSignal<Peer[]>([]);
  const [peersLoaded, setPeersLoaded] = createSignal(false);
  const [rooms, setRooms] = createSignal<Room[]>([]);
  const [recentCallPeers, setRecentCallPeers] = createSignal<string[]>([]);
  // Cache settled/in-flight reads for this shell/source. Reconnects and peer
  // refreshes reuse them; a live call replaces even a cached negative result.
  const callHistory = new Map<string, Promise<boolean>>();
  const callHistoryNewest = new Map<string, number>();
  const knownCallPeers = new Set<string>();
  const [callHistoryRevision, setCallHistoryRevision] = createSignal(0);
  const noteCallHistory = (id: string) => {
    knownCallPeers.add(id);
    callHistory.set(id, Promise.resolve(true));
    setRecentCallPeers(ids => ids.includes(id) ? ids : [...ids, id]);
  };
  const reconcileCallHistory = () => {
    // A fresh websocket does not replay missed messages. Recheck only history
    // newer than the last completed negative read; retain every positive result.
    for (const id of callHistory.keys()) if (!knownCallPeers.has(id)) callHistory.delete(id);
    setCallHistoryRevision(value => value + 1);
  };
  const peerHasCall = (id: string): Promise<boolean> => {
    const cached = callHistory.get(id);
    if (cached) return cached;
    const cutoff = callHistoryNewest.get(id);
    let newest = cutoff ?? -Infinity;
    const read = (async () => {
      let before: number | undefined;
      while (phoneShell() && live()) {
        const page = await source.messages(id, before);
        if (before === undefined) newest = Math.max(newest, ...page.map(m => m.timestamp));
        if (page.some(m => isCallKind(m.kind))) return true;
        const oldest = Math.min(...page.map(m => m.timestamp));
        if (!page.length || !Number.isFinite(oldest) || (cutoff !== undefined && oldest <= cutoff) || (before !== undefined && oldest >= before)) return false;
        before = oldest;
      }
      throw new Error(tr('caCallHistoryReadInterrupted'));
    })();
    callHistory.set(id, read);
    void read.then(hasCall => {
      if (callHistory.get(id) !== read) return;
      if (hasCall) knownCallPeers.add(id);
      else callHistoryNewest.set(id, newest);
    }, () => { if (callHistory.get(id) === read) callHistory.delete(id); });
    return read;
  };
  const [phoneCallPeers] = createResource(
    () => phoneShell() && live() ? { ids: peers().map(p => p.node_id.toLowerCase()), all: phoneTab() === 'calls', revision: callHistoryRevision() } : false,
    async ({ ids, all }) => {
      const found: string[] = [];
      for (const id of ids) {
        try { if (await peerHasCall(id)) found.push(id); }
        catch { /* Failed reads are retryable, never cached as no history. */ }
        // Startup only answers "has any call?". Enumerate the rest on demand.
        if (found.length && !all) break;
        if (!phoneShell() || !live()) break;
      }
      return found;
    },
  );
  const callPeers = createMemo(() => [...new Set([...(phoneCallPeers() ?? []), ...recentCallPeers()])]);
  const [members, setMembers] = createStore<Record<string, string[]>>({});
  let watchOverviewAt = 0;
  let watchWalletAt = 0;
  let paymentFailures = 0;
  const [wallet, setWallet] = createSignal<WalletOverview | null>(null);
  const [link, setLink] = createSignal<LinkState | null>(null);
  const seenEntrances = new Set<string>();
  const [threads, setThreads] = createStore<{ t: Threads; unread: Unread; fresh: Record<string, true> }>({ t: {}, unread: {}, fresh: {} });
  /**
   * Each chat's CURRENT history read (the latest attempt only): only a read that
   * succeeded may say "no messages"; a reopen or reconnect starts pending again.
   */
  const [threadRead, setThreadRead] = createStore<Record<string, ThreadRead>>({});
  const readRevision: Record<string, number> = {};
  let readSeq = 0;
  /** Runs one history read for `key`, recording pending → ok | failed for this attempt only. */
  /** Each chat's read error, for its current read only (never another chat's, never an older read's). */
  const [threadError, setThreadError] = createStore<Record<string, string | undefined>>({});
  const readThread = async <T,>(key: string, run: () => Promise<T>, apply: (v: T) => void) => {
    const rev = ++readSeq;
    readRevision[key] = rev;
    setThreadRead(key, 'pending');
    setThreadError(key, undefined);
    let value: T;
    try {
      value = await run();
    } catch (e) {
      // Only the current read may say it failed, and only it sets the error.
      if (readRevision[key] !== rev) return;
      const error = asActionError(e);
      setThreadRead(key, 'failed');
      setThreadError(key, error.code === 'not_ready' ? undefined : error.message);
      return;
    }
    // Messages an older read brought are still merged; only the current read sets the state.
    apply(value);
    if (readRevision[key] !== rev) return;
    setThreadRead(key, 'ok');
    setThreadError(key, undefined);
  };
  props.onWatchSamples?.(() => {
    const at = Date.now();
    return watchSamples({ ready: props.ready, locked: false,
      overview: at - watchOverviewAt <= 30_000 ? overview() : null,
      wallet: at - watchWalletAt <= 45_000 ? wallet() : null,
      unread: threads.unread, paymentFailures });
  });
  onCleanup(() => props.onWatchSamples?.(null));
  const [track, setTrack] = createSignal<TrackRef | null>(null);
  const [quote, setQuote] = createSignal<PriceQuote | null>(null);
  const [quoteError, setQuoteError] = createSignal<string | undefined>();
  let quoteRead = 0;
  const loadPrice = async (t: TrackRef) => {
    if (!track() || trackKey(track()!) !== trackKey(t)) return;
    const read = ++quoteRead;
    setQuote(null);
    setQuoteError(undefined);
    try {
      const q = await source.priceQuote((t as { id: string }).id);
      if (read === quoteRead && track() && trackKey(track()!) === trackKey(t)) setQuote(q);
    } catch (error) {
      if (read === quoteRead && track() && trackKey(track()!) === trackKey(t)) setQuoteError(isChainUnavailable(error) ? tr('chainUnavailable') : peerNotReadyMessage(error, t.kind === 'peer' ? nameOf(t.id) : tr('caThisPeer')) ?? tr('caPriceUnavailableCouldNotReadPeerPrice'));
    }
  };
  const [roomQuote, setRoomQuote] = createSignal<RoomQuote | null>(null);
  const [filePrice, setFilePrice] = createSignal<PaymentQuote | null>(null);
  const [spend, setSpend] = createSignal<SpendView | null>(null);
  const [device, setDevice] = createSignal<DeviceView | null>(null);
  const [noEnvelopeFor, setNoEnvelopeFor] = createSignal<string | null>(null);
  const [spendCancels, setSpendCancels] = createSignal(0);
  const [budget, setBudgetValue] = createSignal<BudgetView | null>(null);
  let budgetRevision = 0;
  // Budget reads in start order; the stamp of the newest one applied (Touch ID approve & send freshness).
  let budgetReadSeq = 0;
  let noEnvelopeAfterRead = 0;
  const [budgetReadApplied, setBudgetReadApplied] = createSignal(0);
  // The budget read in flight, and the read count when an action's own response last cleared the stamp.
  let budgetInFlight: { stamp: number; done: Promise<void> } | null = null;
  let budgetResetAt = 0;
  /**
   * Every budget view that is not a fresh read (an action's own response:
   * approve, resume, pause, a row edit) clears the freshness stamp, so no
   * approve & send can be confirmed from it; loadBudget restamps right after.
   */
  const setBudget = (value: BudgetView) => {
    budgetRevision += 1;
    budgetResetAt = budgetReadSeq;
    batch(() => {
      setBudgetValue(value);
      setBudgetReadApplied(0);
    });
  };
  const [deliveries, setDeliveries] = createStore<Deliveries>({});
  /** What each send actually paid, by message id: a room echo carries one member's share only. */
  const [paid, setPaid] = createStore<Record<string, number>>({});
  const [allowances, setAllowances] = createStore<Record<string, { total_msat: number; max_routing_fee_msat: number; fee_paid_msat?: number; readmission_msat?: number }>>({});
  const [pendingRevision, setPendingRevision] = createSignal(0);
  const [reconciled, setReconciled] = createSignal(0);
  let paymentGeneration = 0;
  // A check or dismissal, from any card, that settled what a payment is. `pendingId`:
  // the record the host still holds for it, which only stopping retries or End releases.
  const [lastReconciliation, setLastReconciliation] = createSignal<Reconciliation | null>(null);
  const [artifacts, setArtifacts] = createStore<Record<string, Artifact[]>>({});
  // Rooms (room.ts): what each room send did this session, by room id; the New room picker.
  const [roomSends, setRoomSends] = createStore<Record<string, RoomSend[]>>({});
  const [roomPlan, setRoomPlan] = createSignal(false);
  // Each bound room's thread read (`?room=`): the next page's cursor, and whether there is one.
  const [roomPages, setRoomPages] = createStore<Record<string, { before: number | null; more: boolean; loading: boolean }>>({});
  // An offline transition consumes undispatched retry approvals, even if their
  // request/status response arrives only after readiness has recovered.
  let retryApprovalRevision = 0;
  createEffect(on(moneyBlocked, (blocked) => {
    if (!blocked) return;
    retryApprovalRevision++;
    for (const key of Object.keys(artifacts)) {
      for (const a of artifacts[key] ?? []) {
        if (a.type === 'undelivered' && a.ownerApproval) {
          void source.firstContactCancel(a.ownerApproval.id).catch(() => {});
        }
      }
      setArtifacts(key, (old) => old.map((a) => a.type === 'undelivered'
        ? { ...a, ownerApproval: null, note: null } : a));
    }
  }));
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({});
  const [contactApprovalError, setContactApprovalError] = createSignal<{ peer: string; message: string } | null>(null);
  let contactApprovalRevision = 0;
  const clearContactApprovalError = () => {
    ++contactApprovalRevision;
    setContactApprovalError(null);
  };
  // Invalidate in-flight failures too: returning to a chat must not revive them.
  createEffect(on(() => track() ? trackKey(track()!) : null, clearContactApprovalError));
  const approvalErrorFor = (t: TrackRef) => {
    const error = contactApprovalError();
    return t.kind === 'peer' && error?.peer === t.id.toLowerCase() ? error.message : undefined;
  };
  const [contextOpen, setContextOpen] = createSignal(false);
  /** The full-screen Wallet page, on this tab; null when closed. */
  const [walletTab, setWalletTab] = createSignal<WalletTab | null>(null);
  let walletReturnFocus: HTMLElement | null = null;
  createEffect(on(() => walletTab() !== null, (open) => {
    if (!open) return;
    const opener = walletReturnFocus;
    onCleanup(onEscape(() => { if (!contextOpen()) closeWallet(); }));
    onCleanup(() => queueMicrotask(() => { if (opener?.isConnected) opener.focus(); }));
  }));
  const [settingsEl, setSettingsEl] = createSignal<HTMLElement | null>(null);
  let settingsReturnFocus: HTMLElement | null = null;
  createEffect(() => {
    const open = contextOpen();
    const panel = settingsEl();
    // Closed modal uses visibility:hidden (CSS) so its controls leave the tab order.
    if (open && panel) {
      settingsReturnFocus = document.activeElement as HTMLElement | null;
      queueMicrotask(() => panel.querySelector<HTMLElement>('[data-settings-close]')?.focus());
      onCleanup(onEscape(() => setContextOpen(false)));
    } else if (!open && settingsReturnFocus) {
      const back = settingsReturnFocus;
      settingsReturnFocus = null;
      queueMicrotask(() => back?.focus?.());
    }
  });
  /** K1: cards the owner continued from, by node id. Display only, never admission. */
  const [introduced, setIntroduced] = createStore<Record<string, Introduction>>({});
  /** Front-door Knocks: distinct from introductions so we never re-dial as introduce. */
  const [doorstep, setDoorstep] = createStore<Record<string, Doorstep>>({});
  /** An introduction that finished while the owner was elsewhere: shown, never navigated to. */
  const [introNotice, setIntroNotice] = createSignal<Introduction | null>(null);
  const openIntroduced = (card: Introduction) => {
    setIntroNotice(null);
    setTrack({ kind: 'peer', id: card.node_id.toLowerCase() });
  };
  const openDoorstep = (card: Doorstep) => {
    setIntroNotice(null);
    setTrack({ kind: 'peer', id: card.node_id.toLowerCase() });
  };
  const [tab, setTab] = createSignal<'general' | 'body' | 'node' | 'devices' | 'wallet' | 'budget' | 'frontdoor'>('body');
  // Organism view (O1): readings the organs are drawn from, each with its age.
  const [openedAt, setOpenedAt] = createSignal(Date.now());
  const [membrane, setMembrane] = createSignal<MembraneEntry[]>([]);
  const [prePaymentRefusals, setPrePaymentRefusals] = createSignal<PrePaymentRefusals | null>(null);
  /** When the node's membrane ring and aggregates were last read successfully. */
  const [membraneReadAt, setMembraneReadAt] = createSignal<number | null>(null);
  const [energyAt, setEnergyAt] = createSignal<number | null>(null);
  const [budgetConfirmed, setBudgetConfirmed] = createSignal(false);
  const [grantUnknown, setGrantUnknown] = createSignal(false);
  const [budgetReadAt, setBudgetReadAt] = createSignal<number | null>(null);
  const [door, setDoor] = createSignal<{ msat: number; read_at: number } | null>(null);
  // O1 v2: the node's own energy read (N1) and gate decisions (N2), when advertised.
  const [nodeEnergy, setNodeEnergy] = createSignal<{ hour: EnergyRead; day: EnergyRead } | null>(null);
  const [energyReadAt, setEnergyReadAt] = createSignal<number | null>(null);
  const aiSession = createAiSession();
  const [prefill, setPrefill] = createSignal<Prefill | null>(null);
  let prefillSeq = 0;
  /** The AI track's proposal: open that peer's composer with it filled in. Nothing is sent. */
  const openDraft = (p: Proposal) => {
    const recipient = p.kind === 'message' ? p.recipient : p.peer;
    const key = trackKey({ kind: 'peer', id: recipient });
    setPrefill({
      seq: ++prefillSeq,
      key,
      mode: p.kind,
      text: p.kind === 'message' ? p.draft_text : p.kind === 'request' ? p.note : '',
      sats: p.kind === 'message' ? null : p.sats,
    });
    setTrack({ kind: 'peer', id: recipient });
  };

  const ownId = () => props.ownId ?? overview()?.node_id ?? '';
  const missedCalls = createMissedCalls(ownId);
  const peerById = createMemo(() => new Map(peers().map((p) => [p.node_id.toLowerCase(), p])));
  const caps = createMemo(() => organismCaps(overview()), undefined, { equals: (a, b) => a.energy === b.energy && a.membrane === b.membrane });
  /** First contacts at the door this session (never added to peers), newest first. */
  const knocks = createMemo(() => {
    const seen = new Set<string>();
    return membrane()
      .filter((e): e is Extract<MembraneEntry, { verdict: 'admitted' }> => e.verdict === 'admitted' && e.first_contact && !peerById().has(e.sender))
      .filter((e) => !seen.has(e.sender) && !!seen.add(e.sender))
      .map((e) => e.sender);
  });
  const openKey = () => (phoneShell() && phoneTab() !== 'chats') ? null : (track() ? trackKey(track()!) : null);
  createEffect(() => { const key = openKey(); if (key) setThreads('unread', key, 0); });
  const readFocusedMissedCalls = () => {
    const key = openKey();
    if (key?.startsWith('peer:') && !contextOpen() && walletTab() === null) missedCalls.read(key.slice(5));
  };
  createEffect(on([openKey, contextOpen, walletTab], () => { if (document.hasFocus()) readFocusedMissedCalls(); }));
  window.addEventListener('focus', readFocusedMissedCalls);
  onCleanup(() => window.removeEventListener('focus', readFocusedMissedCalls));
  // Bumped whenever the owner leaves a chat: a retry approval answered after that never goes on to send.
  let viewGeneration = 0;
  createEffect(on(openKey, () => { viewGeneration++; }, { defer: true }));
  // Our own node checks room bindings (genome `room_binding_v1` on /status).
  const nodeRooms = () => overview()?.capabilities?.includes(ROOM_CAPABILITY) === true;
  /**
   * Room chats go to their room's thread (they stay in the member's 1:1
   * history, hidden there). A room is first remembered only once its id is
   * checked against its roster and salt. A left room, or a chat naming a
   * known room id with another roster, shows nowhere. `bump`: a live arrival is unread.
   */
  const foldRoom = (room: LocalRoom, m: Message, bump: boolean) => {
    if (room.left) return;
    const own = ownId();
    const key = trackKey({ kind: 'bound', id: room.id });
    const before = threads.t[key] ?? [];
    const known = before.find((x) => x.id === m.id);
    // A thread entry's copies outlive a copy-less echo of the same message.
    const next = known?.copies?.length && !m.copies?.length ? { ...m, copies: known.copies, recipient: known.recipient } : m;
    if (known && JSON.stringify(known) === JSON.stringify(next)) return;
    setThreads(produce((s) => {
      s.t[key] = mergeMessages(before, [next]);
      if (!known && bump && key !== openKey() && !isOutgoing(m, own)) s.unread[key] = (s.unread[key] ?? 0) + 1;
    }));
  };
  const foldRooms = (messages: Message[], bump: boolean) => {
    for (const m of messages) {
      const chat = roomOf(m, ownId());
      if (!chat) continue;
      const known = localRoom(chat.room.id);
      if (known) {
        if (sameRoom(known, chat.room)) foldRoom(known, m, bump);
        continue;
      }
      void admitRoom(chat.room, m.timestamp).then((room) => { if (room) foldRoom(room, m, bump); });
    }
  };
  /** One page of a bound room's thread from the node: whole messages, older than `before`. */
  const loadRoomPage = (id: string, before: number | null) => {
    if (roomPages[id]?.loading) return;
    setRoomPages(id, { before, more: roomPages[id]?.more ?? false, loading: true });
    // The first page is the room's current read; an earlier page never changes what the room says about being empty.
    const read = <T,>(run: () => Promise<T>, apply: (v: T) => void) =>
      before === null ? readThread(trackKey({ kind: 'bound', id }), run, apply) : attempt('thread', run, apply);
    void read(() => source.roomThread(id, before ?? undefined, ROOM_PAGE), (page) => {
      foldRooms(page, false);
      const oldest = page.length ? Math.min(...page.map((m) => m.timestamp)) : before;
      setRoomPages(id, { before: oldest, more: page.length >= ROOM_PAGE, loading: false });
    }).finally(() => setRoomPages(id, 'loading', false));
  };

  const attempt = async <T,>(area: string, run: () => Promise<T>, apply: (v: T) => void) => {
    try {
      apply(await run());
      setErrors(area, undefined);
    } catch (e) {
      setErrors(area, asActionError(e).code === 'not_ready' ? undefined : typeof e === 'string' ? e : asActionError(e).message);
    }
  };
  const loadOverview = () => {
    const revision = ++overviewRevision;
    return attempt('overview', () => source.nodeOverview(), (value) => {
      if (revision !== overviewRevision) return;
      const recovering = (readinessRefused() || overview()?.money_ready === false) && value.money_ready !== false;
      watchOverviewAt = Date.now();
      setOverview(value);
      setReadinessRefused(false);
      if (recovering) {
        void loadWallet(); void loadDoor(); void loadBudget();
        void attempt('quote', () => source.filePrice(), setFilePrice);
        const t = track();
        if (t?.kind === 'peer') void loadPrice(t);
        if (t?.kind === 'room') void attempt('quote', () => source.roomQuote(t.id), (q) => { if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q); });
      }
    });
  };
  const loadPeers = () => attempt('peers', () => source.peers(), (value) => {
    setPeers(value);
    setPeersLoaded(true);
    if (!track() && !phoneLayout()) {
      const first = value.find((p) => p.connected) ?? value[0];
      if (first) setTrack({ kind: 'peer', id: first.node_id.toLowerCase() });
    }
  });
  const loadRooms = () => attempt('rooms', () => source.rooms(), setRooms);
  const loadWallet = () => attempt('wallet', () => source.wallet(), value => { watchWalletAt = Date.now(); setWallet(value); });
  const loadSpend = () => attempt('spendPoll', () => source.spendStatus(), (value) => {
    const resolved = spend()?.state !== 'open' && value.state === 'open';
    setSpend(value);
    if (resolved) { setErrors('spend', undefined); clearContactApprovalError(); }
  });
  // Never an error line of its own: without a device key the console path stays.
  const loadDevice = () => source.deviceKeyStatus().then(setDevice, () => setDevice(null));
  // Owner approval (owner_device_approval_v1): this pairing may approve other
  // apps' requests when the node says so; never its own (the node excludes them).
  const [deviceKeys, setDeviceKeys] = createSignal<DeviceKeysView | null>(null);
  const [approvals, setApprovals] = createSignal<ApprovalView[]>([]);
  const approvalsCapable = () => props.remote === true && overview()?.capabilities?.includes(OWNER_DEVICE_APPROVAL) === true;
  const canApprove = () => approvalsCapable() && deviceKeys()?.device_approvals === 'enabled';
  // A failed read is said, never shown as "nothing is waiting", and stale entries go.
  const [approvalsError, setApprovalsError] = createSignal<string | null>(null);
  // Kept outcomes outlive the Settings panel (Node → Body → Node), until Dismiss.
  const approvalsMemory = approvalMemory();
  /** A list read that failed in transport says so; a refusal says the node's reason. */
  const listError = (e: ActionError) => (e.code === 'node' ? tr('ownerApprovalReadError') : refusalText(e.code, e));
  const loadApprovals = async () => {
    if (!approvalsCapable()) { setDeviceKeys(null); setApprovals([]); setApprovalsError(null); return; }
    const keys = await act(() => source.deviceKeys());
    // A failed discovery keeps what was known, but no entry may be acted on from it.
    if (!keys.ok) { setApprovalsError(listError(keys.error)); setApprovals([]); return; }
    setDeviceKeys(keys.value);
    if (!canApprove()) { setApprovals([]); setApprovalsError(null); return; }
    const pending = await act(() => source.approvalsPending());
    if (pending.ok) { setApprovals(pending.value.filter((v) => v.status === 'pending')); setApprovalsError(null); }
    else { setApprovalsError(listError(pending.error)); setApprovals([]); }
  };
  /** After an approve the host could not confirm: is the request still waiting at the node? */
  const recheckApproval = async (opId: string): Promise<'pending' | 'gone' | 'unknown'> => {
    const pending = await act(() => source.approvalsPending());
    if (!pending.ok) return 'unknown';
    setApprovals(pending.value.filter((v) => v.status === 'pending'));
    return pending.value.some((v) => v.op_id === opId && v.status === 'pending') ? 'pending' : 'gone';
  };
  createEffect(on(approvalsCapable, (on) => { if (on) void loadApprovals(); else { setDeviceKeys(null); setApprovals([]); setApprovalsError(null); } }));
  const approveOwner = async (opId: string, message: string) => {
    const r = await act(() => source.approvalApprove(opId, message));
    void loadApprovals();
    return r;
  };
  const approvalsWaiting = () => (canApprove() ? approvals().filter((v) => v.expires_at * 1000 > now()).length : 0);
  const loadBudget = () => {
    const revision = ++budgetRevision;
    const stamp = ++budgetReadSeq;
    const done = readBudget(revision, stamp);
    budgetInFlight = { stamp, done };
    void done.finally(() => { if (budgetInFlight?.done === done) budgetInFlight = null; });
    return done;
  };
  const readBudget = async (revision: number, stamp: number) => {
    try {
      const b = await source.budgetStatus();
      if (revision !== budgetRevision) return;
      if (budget()?.autopay.state !== 'open' && b.autopay.state === 'open') setErrors('budget', undefined);
      batch(() => {
        setBudget(b);
        setBudgetReadApplied(stamp);
        const peer = noEnvelopeFor()?.toLowerCase();
        const grant = b.node_grant;
        if (peer && stamp > noEnvelopeAfterRead && grant && grant.expires_at_ms > Date.now() &&
            (grant.envelopes?.[peer] ?? 0) > Date.now()) setNoEnvelopeFor(null);
      });
      setBudgetReadAt(Date.now());
      setBudgetConfirmed(true);
      setGrantUnknown(false);
      setErrors('budgetPoll', undefined);
    } catch (e) {
      if (revision !== budgetRevision) return;
      setBudgetConfirmed(false);
      const error = asActionError(e);
      setGrantUnknown(error.code === 'grant_unknown');
      setErrors('budgetPoll', error.message);
    }
  };
  // Our own price with no peer: what a stranger pays at this node's door.
  const loadDoor = () => attempt('door', () => source.priceQuote(), (q) => setDoor({ msat: q.own_msat, read_at: Date.now() }));
  // N1: node-wide energy, 1 h and 24 h. A failed read keeps the last one, with its age.
  const loadEnergy = () =>
    caps().energy
      ? attempt('energy', () => Promise.all([source.energy('1h'), source.energy('24h')]), ([hour, day]) => {
          setNodeEnergy({ hour, day });
          setEnergyReadAt(Date.now());
        })
      : Promise.resolve();
  let energySoon: ReturnType<typeof setTimeout> | undefined;
  /** A live event moved energy: re-read shortly, once, however many arrive. */
  const energyAfterEvent = () => {
    if (!caps().energy || energySoon) return;
    energySoon = setTimeout(() => {
      energySoon = undefined;
      void loadEnergy();
    }, 1500);
  };

  /** Where a door card lives in the stream, and cards already placed (by membrane entry). */
  const doorsPlaced = new Set<number>();
  const placeDoor = (entry: MembraneEntry) => {
    if (doorsPlaced.has(entry.seq)) return;
    const d = doorCard(entry, door()?.msat ?? null);
    if (!d) return;
    doorsPlaced.add(entry.seq);
    const artifact: Artifact = { id: `door-${entry.seq}`, at: d.at, type: 'door', door: d.card };
    setArtifacts(d.track, (old) => [...(old ?? []), artifact]);
  };
  /** Fold into the membrane; entries it adds may also stand at the door in their track. */
  const foldMembrane = (fold: (log: MembraneEntry[]) => MembraneEntry[]) => {
    const before = membrane();
    const after = fold(before);
    if (after === before) return;
    setMembrane(after);
    const known = new Set(before.map((e) => e.seq));
    after.filter((e) => !known.has(e.seq)).forEach(placeDoor);
  };
  const contactSet = () => new Set(peerById().keys());
  // N2 events have a live feed; pre-payment aggregates require periodic reads.
  const loadMembrane = () =>
    caps().membrane ? attempt('membrane', () => source.membrane(50), (read) => {
      foldMembrane((log) => membraneSeed(log, read.events, { contacts: contactSet() }));
      setPrePaymentRefusals(read.pre_payment_refusals ?? null);
      setMembraneReadAt(read.read_at);
    }) : Promise.resolve();

  const loadThread = (t: TrackRef) => {
    if (t.kind === 'bound') {
      // The node's room thread: both directions, our copies of one message as one entry.
      loadRoomPage(t.id, null);
      return;
    }
    if (t.kind !== 'peer' && t.kind !== 'room') return;
    const key = trackKey(t);
    void readThread(key, () => source.messages(t.id), (page) => {
      // History can already hold a message still sending here: its bubble claims it, as for the live echo.
      for (const m of page) claimEcho(m, t.kind === 'room' ? t.id : null);
      setThreads('t', key, (old) => mergeMessages(old ?? [], page));
      if (t.kind === 'peer') {
        foldRooms(page, false);
        if (page.some(m => isCallKind(m.kind))) noteCallHistory(t.id.toLowerCase());
      }
      // After the thread, so a restored send whose message is already here is not shown twice.
      loadOps(t);
      setEnergyAt(Date.now());
    });
  };

  const clockTimer = setInterval(() => setNow(Date.now()), REFRESH_MS.clock);
  let timers: ReturnType<typeof setTimeout>[] = [];
  let unlisten: (() => void) | undefined;
  // Bumped on every stop so a subscription that resolves late is closed at once.
  let generation = 0;
  const deliveryChecks = deliveryPoller({
    read: (operationId, messageId) => source.messageDelivery(operationId, messageId),
    connected: () => link() === 'open',
    active: live,
    apply: event => {
      const next = applyDelivery(deliveries, event);
      if (next !== deliveries) setDeliveries(event.message_id, next[event.message_id]);
    },
  });
  const stop = () => {
    deliveryChecks.stop();
    generation += 1;
    polling.stop();
    budgetRevision += 1;
    setBudgetConfirmed(false);
    timers.forEach(clearTimeout);
    timers = [];
    unlisten?.();
    unlisten = undefined;
  };

  // Memoised: the host poll hands App a fresh status object every 1.5 s, and
  // the subscription must restart only when `active` actually flips.
  const active = createMemo(() => props.active);
  createEffect(
    on(active, (active) => {
        stop();
        if (!active) return;
        const mine = generation;
        setOpenedAt(Date.now());
        void loadOverview();
        void loadDoor();
        void loadPeers();
        void loadRooms();
        void loadWallet();
        void loadSpend().then(() => { if (mine === generation && live()) return loadBudget(); });
        void loadDevice();
        // Keep timer phases through cooldowns. Skip ticks while paused rather
        // than restarting the initial load sequence when the link recovers.
        const polls: [() => Promise<unknown>, number][] = [
          [loadDevice, REFRESH_MS.peers], [loadOverview, REFRESH_MS.overview], [loadApprovals, REFRESH_MS.overview],
          [loadPeers, REFRESH_MS.peers], [loadWallet, REFRESH_MS.wallet],
          [loadRooms, REFRESH_MS.rooms], [loadDoor, REFRESH_MS.door],
          [loadEnergy, REFRESH_MS.energy], [loadMembrane, REFRESH_MS.membrane],
          [() => loadSpend().then(() => { if (mine === generation && live()) return loadBudget(); }), REFRESH_MS.spend],
        ];
        polls.forEach(([read, period], index) => {
          let reading = false;
          const tick = () => {
            if (mine !== generation) return;
            if (live() && !reading) {
              reading = true;
              void read().finally(() => { reading = false; });
            }
            timers[index] = setTimeout(tick, period);
          };
          timers[index] = setTimeout(tick, period - index * 175);
        });
        source
          .onLive((event) => {
            if (event.type === 'link') {
              if (mine !== generation) return;
              if (event.state === 'open' && link() !== null && link() !== 'open') reconcileCallHistory();
              if (event.state === 'open' && link() !== 'open') deliveryChecks.catchUp();
              setLink(event.state);
              if (event.state !== 'open') { budgetRevision += 1; setBudgetConfirmed(false); }
              else if (live()) void loadSpend().then(() => { if (mine === generation && live()) return loadBudget(); });
              // Back after a gap: re-read the open track so nothing is missed.
              if (event.state === 'open' && live() && track()) loadThread(track()!);
              if (event.state === 'open' && live() && caps().membrane) void loadMembrane();
              return;
            }
            if (event.type === 'membrane') {
              foldMembrane((log) => membraneNode(log, event.event, { contacts: contactSet() }));
              if (event.event.verdict === 'admitted') energyAfterEvent();
              return;
            }
            if (event.type === 'message' && isPorchKind(event.message.kind)) return;
            // Call signals ring or steer the call; they are not chat.
            if (event.type === 'message' && isCallKind(event.message.kind)) {
              const other = event.message.sender.toLowerCase() === ownId().toLowerCase() ? event.message.recipient : event.message.sender;
              noteCallHistory(other.toLowerCase());
              // Each engine takes only its own: meeting legs carry a roster.
              void calls.receive(event.message, ownId());
              // Meetings are app-to-app WebRTC mesh: hidden and unreachable in M6 builds.
              if (routedCalls) return;
              const beforeMeeting = meetingView();
              // receive admits offers synchronously, before its first await. Snapshot this
              // event's transition now so an ignored signal cannot claim a later invitation.
              void meetings.receive(event.message, ownId());
              const invited = meetingView();
              if (invited.phase === 'invited' && invited.id && (beforeMeeting.phase !== 'invited' || beforeMeeting.id !== invited.id)) {
                notifications?.call(invited.id, nameOf(event.message.sender), () => meetingView().phase === 'invited' && meetingView().id === invited.id);
              }
              return;
            }
            if (event.type === 'message' || event.type === 'delivery') {
              foldMembrane((log) =>
                membraneLive(log, event, { ownId: ownId(), contacts: contactSet(), threads: threads.t, nowMs: Date.now(), nodeMembrane: caps().membrane }),
              );
            }
            if (event.type === 'message') {
              notifications?.message(event.message, ownId(), nameOf(event.message.sender));
              setEnergyAt(Date.now());
              energyAfterEvent();
            }
            if (event.type === 'delivery') {
              if (event.status === 'delivered' || event.status === 'rejected') deliveryChecks.confirm(event.message_id);
              const next = applyDelivery(deliveries, event);
              if (next !== deliveries) setDeliveries(event.message_id, next[event.message_id]);
              return;
            }
            // Our own message echoed before its receipt: the bubble still sending
            // claims it, so one send never shows twice.
            const echoed = event.type === 'message' && claimEcho(event.message, event.room_id);
            if (event.type === 'message' && roomOf(event.message, ownId())) {
              // A room chat: unread in its room, kept (hidden) in the member's 1:1 history.
              const m = event.message;
              const peer = (isOutgoing(m, ownId()) ? m.recipient : m.sender).toLowerCase();
              setThreads('t', trackKey({ kind: 'peer', id: peer }), (old) => mergeMessages(old ?? [], [m]));
              if (!echoed) setThreads('fresh', m.id, true);
              foldRooms([m], true);
              return;
            }
            const next = applyLive(threads.t, threads.unread, openKey(), event, ownId());
            if (!next.key) return;
            setThreads(
              produce((s) => {
                s.t = next.threads;
                s.unread = next.unread;
                if (event.type === 'message' && !echoed) s.fresh[event.message.id] = true;
              }),
            );
          })
          .then((off) => {
            if (mine !== generation) {
              off();
              return null;
            }
            unlisten = off;
            // The link state comes from the host's socket, replayed on the channel
            // just subscribed: the bridge usually opened before this shell mounted.
            return source.liveLink();
          })
          .catch((e) => setErrors('live', String(e)));
    }),
  );

  // The node says what it can report (`/status`): start reading N1 / N2 when it does.
  createEffect(on(() => props.active && caps().energy, (on) => void (on && loadEnergy()), { defer: false }));
  createEffect(on(() => props.active && caps().membrane, (on) => void (on && loadMembrane()), { defer: false }));

  // Opening a track: clear its unread count, load history, quote its cost.
  createEffect(
    on(track, (t) => {
      if (!t || !props.active) return;
      setThreads('unread', trackKey(t), 0);
      quoteRead++;
      setQuote(null);
      setQuoteError(undefined);
      setRoomQuote(null);
      loadThread(t);
      if (t.kind === 'peer') {
        void loadPrice(t);
        if (filePrice() === null) void attempt('quote', () => source.filePrice(), setFilePrice);
      }
      if (t.kind === 'room') {
        void attempt('quote', () => source.roomQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q);
        });
        void attempt('members', () => source.roomMembers(t.id), (m) => setMembers(t.id, m));
      }
      setContextOpen(false);
    }),
  );

  onCleanup(() => {
    clearInterval(clockTimer);
    clearTimeout(energySoon);
    stop();
  });

  // ---- actions ------------------------------------------------------------

  const addArtifact = (t: TrackRef, artifact: NewArtifact) => {
    const key = trackKey(t);
    const full = { id: `local-${artifactSeq++}`, at: artifact.at ?? Date.now(), ...artifact } as Artifact;
    setArtifacts(key, (old) => [...(old ?? []), full]);
    return full.id;
  };
  const dropArtifact = (t: TrackRef, id: string) =>
    setArtifacts(trackKey(t), (old) => (old ?? []).filter((x) => x.id !== id));
  /**
   * An outgoing live message that matches a bubble still sending (same track,
   * same text, the earliest pressed without a leg to that recipient yet) is that
   * send's echo. Sends go out strictly in press order, so the earliest is right.
   * A message already known (a replay) is never claimed.
   */
  const claimEcho = (m: Message, roomId: string | null): boolean => {
    if (!isOutgoing(m, ownId())) return false;
    const to = m.recipient.toLowerCase();
    const key = roomId ? trackKey({ kind: 'room', id: roomId.toLowerCase() }) : trackKey({ kind: 'peer', id: to });
    if ((threads.t[key] ?? []).some((x) => x.id === m.id) || (threads.t[trackKey({ kind: 'peer', id: to })] ?? []).some((x) => x.id === m.id)) return false;
    const list = artifacts[key] ?? [];
    if (list.some((a) => a.type === 'sending' && a.echoes?.some((e) => e.id === m.id))) return true;
    // Only a message written around or after the press (any node clock skew allowed for).
    const owner = list.find((a) => a.type === 'sending' && a.text === m.plaintext && m.timestamp >= a.at - ECHO_SKEW_MS && !(a.echoes ?? []).some((e) => e.to === to));
    if (!owner) return false;
    setArtifacts(key, (old) => (old ?? []).map((a) => (a.id === owner.id && a.type === 'sending' ? { ...a, echoes: [...(a.echoes ?? []), { id: m.id, to }] } : a)));
    return true;
  };

  /** At a peer receipt: frees `messageId` from other bubbles; returns this bubble's echoes that were not it. */
  const settleEchoes = (t: TrackRef, bubbleId: string, messageId: string): Message[] => {
    const key = trackKey(t);
    const list = artifacts[key] ?? [];
    const mine = list.find((a) => a.id === bubbleId);
    const wrong = mine?.type === 'sending' ? (mine.echoes ?? []).filter((e) => e.id !== messageId).map((e) => e.id) : [];
    setArtifacts(key, (old) => (old ?? []).map((a) => (a.type === 'sending' && a.id !== bubbleId && a.echoes?.some((e) => e.id === messageId)
      ? { ...a, echoes: a.echoes.filter((e) => e.id !== messageId) } : a)));
    const known = threads.t[key] ?? [];
    return wrong.flatMap((id) => known.filter((m) => m.id === id));
  };
  /** A released echo: another bubble with the same words may take it, else it shows as itself. */
  const reclaimEcho = (t: TrackRef, m: Message) => {
    const key = trackKey(t);
    const to = m.recipient.toLowerCase();
    const owner = (artifacts[key] ?? []).find((a) => a.type === 'sending' && a.text === m.plaintext && m.timestamp >= a.at - ECHO_SKEW_MS && !(a.echoes ?? []).some((e) => e.to === to));
    if (owner) setArtifacts(key, (old) => (old ?? []).map((a) => (a.id === owner.id && a.type === 'sending' ? { ...a, echoes: [...(a.echoes ?? []), { id: m.id, to }] } : a)));
  };
  /**
   * The operation a card names. A failed card's id is only *linked*: the host
   * names the operation an error is about, which may be another one (its
   * pending fence), so it never identifies, deletes or relabels that card as sent.
   */
  const opOf = (a: Artifact): string | undefined =>
    a.type === 'failed' ? a.error.operation_id : a.type === 'undelivered' ? a.operationId : a.type === 'restored' ? a.op.op_id : undefined;
  /** Operations a receipt confirmed: an op list snapshot never brings them back as open. */
  const confirmedOps = new Set<string>();
  /**
   * The one step every successful receipt takes (send, approved send, retry
   * delivery, file): remembered as confirmed, and a card restored for that same
   * operation gives way to it. Failed cards are only linked, never removed here.
   */
  const confirmOperation = (t: TrackRef, opId: string | undefined, messageId: string) => {
    if (!opId) return;
    confirmedOps.add(opId);
    setArtifacts(trackKey(t), (old) => (old ?? [])
      .filter((a) => a.type !== 'restored' || a.op.op_id !== opId)
      // A failed card linked to it keeps its words; its cached money claim (e.g. "not paid") is superseded by the receipt.
      .map((a) => (a.type === 'failed' && a.error.operation_id === opId ? { ...a, op: undefined, confirmedBy: messageId } : a)));
  };
  /**
   * The host's op list for a peer: each card about an operation learns the
   * host's record of it; a message send still open with no card here (the app
   * restarted, the reply was lost) comes back as a restored card. Read only.
   */
  const foldOps = (t: TrackRef, list: OpList) => {
    if (t.kind !== 'peer') return;
    const key = trackKey(t);
    // A snapshot may predate a receipt: a confirmed operation is never shown as open again.
    const byId = new Map(list.operations.filter((o) => o.peer.toLowerCase() === t.id.toLowerCase() && !confirmedOps.has(o.op_id)).map((o) => [o.op_id, o]));
    const known = new Set((threads.t[key] ?? []).map((m) => m.id));
    setArtifacts(key, (old) => {
      const cur = old ?? [];
      const seen = new Set(cur.map(opOf).filter(Boolean));
      const next = cur.map((a) => {
        const op = byId.get(opOf(a) ?? '');
        if (!op) return a;
        if (a.type === 'failed') return a.confirmedBy ? a : { ...a, op };
        if (a.type === 'restored') return { ...a, op };
        return a;
      });
      // A bubble still sending here is an op the host has open with no id on our side yet: restore nothing
      // until it settles (its receipt or error then names its op, and a later read sees the rest).
      if (cur.some((a) => a.type === 'sending')) return next;
      const fresh = [...byId.values()].filter((o) => o.kind === 'message' && RESTORE_OP.has(o.state) && !seen.has(o.op_id) && !(o.message_id && known.has(o.message_id)));
      // Oldest first, after everything already here: the host keeps no time for them.
      const at = Date.now();
      return [...next, ...fresh.reverse().map((op, i) => ({ id: `op-${op.op_id}`, at: at + i, type: 'restored' as const, op }))];
    });
  };
  const loadOps = (t: TrackRef) => {
    if (t.kind !== 'peer') return;
    // All peers: the host's pending fence is global, so any open op may later name another send's refusal.
    // A failed read establishes nothing: the cards stay as they are.
    void source.opList().then((list) => foldOps(t, list), () => {});
  };

  // The send queue: app-level, so navigation (another chat, Discover,
  // Settings) never loses a message, a press order or a hold. Composers only
  // press into it and read from it.
  let sendChain: Promise<void> = Promise.resolve();
  let queued = 0;
  // An unknown result: nothing new goes out until a pending check answers.
  const [checkFirst, setCheckFirst] = createSignal(false);
  // Paid but not delivered (or refused for good): the messages already queued
  // behind it wait; once the queue is empty a new press goes to the host.
  let queueHold = false;
  // Why the queue holds, said on each message it keeps back.
  let holdWhy = tr('caNotSentNothingPaidAnEarlierPaymentSResult');
  // Only a pending check lifts "check first"; a released undelivered record lifts the paid hold.
  createEffect(on(reconciled, () => { setCheckFirst(false); queueHold = false; }, { defer: true }));
  createEffect(on(pendingRevision, () => { queueHold = false; }, { defer: true }));
  let box: SendBox | null = null;
  const [sendLive, setSendLive] = createSignal({ text: '', seq: 0 });
  // Clear, then say it: a repeat of the same words is announced again.
  const announce = (text: string) => {
    setSendLive((l) => ({ text: '', seq: l.seq + 1 }));
    setTimeout(() => setSendLive((l) => ({ ...l, text })), 0);
  };
  const queue: SendQueue = {
    enqueue: (job) => {
      queued++;
      const run = sendChain.then(job).finally(() => { if (--queued === 0) queueHold = false; });
      sendChain = run.catch(() => {});
      return run;
    },
    held: () => untrack(checkFirst) || queueHold,
    blocked: () => (checkFirst() ? tr('caAPaymentResultIsNotKnownYetNothingWas') : null),
    settled: (r, t, text, at) => {
      // Only a code proven unpaid is "refused" (words back, resend offered); anything else is held as unknown.
      const outcome = r.ok ? 'sent' : provenUnpaid(r.error.code) ? 'refused' : paidUndelivered(r) || r.error.code === 'failed_paid' ? 'paid' : 'unknown';
      if (outcome === 'unknown') { setCheckFirst(true); holdWhy = tr('caNotSentNothingPaidAnEarlierPaymentSResult'); }
      if (outcome === 'paid') {
        queueHold = true;
        if (!untrack(checkFirst)) holdWhy = paidUndelivered(r)
          ? tr('caNotSentNothingPaidAnEarlierMessageWasPaid')
          : tr('caNotSentNothingPaidAnEarlierMessageWasPaid515');
      }
      const here = box && box.key() === trackKey(t) ? box : null;
      if (!r.ok && outcome === 'refused') {
        // Back in the box only where it was typed: the same composer, untouched since the press.
        if (here && here.id === at.box && here.revision() === at.revision && !here.draft()) {
          here.setDraft(text);
          if (!here.note()) here.setNote(tr('caNotSentYourMessageIsBackInTheBox'));
        } else {
          addArtifact(t, { type: 'unsent', text, why: 'refused', reason: r.error.message });
          if (here && !here.note()) here.setNote(tr('caNotSentNothingWasPaidTheMessageIsKept'));
        }
      }
      if (here && outcome === 'unknown') here.setNote(tr('caThePaymentResultIsNotKnownYetCheckPending'));
      announce(outcome === 'sent' ? tr('caMessageSent') : outcome === 'paid' ? (paidUndelivered(r) ? tr('caPaidNotDelivered') : tr('caPaidRefusedByTheirNode')) : outcome === 'unknown' ? tr('caMessagePaymentResultUnknown') : tr('caMessageNotSent'));
    },
    holdBack: (t, bubble, text) => {
      batch(() => {
        dropArtifact(t, bubble);
        addArtifact(t, { type: 'unsent', text, why: 'held', reason: untrack(checkFirst) ? tr('caNotSentNothingPaidAnEarlierPaymentSResult') : holdWhy });
      });
      announce(untrack(checkFirst) ? tr('caMessageHeldAnEarlierPaymentIsNotCheckedYet') : tr('caMessageHeldAnEarlierMessageWasPaidButNot'));
    },
    withdraw: (t, bubble, text, reason) => {
      // Checked before anything was dispatched: nothing was paid.
      batch(() => {
        dropArtifact(t, bubble);
        addArtifact(t, { type: 'unsent', text, why: 'refused', reason });
      });
      announce(tr('caMessageNotSent'));
    },
    attach: (b) => {
      box = b;
      return () => { if (box === b) box = null; };
    },
    live: sendLive,
  };
  // The Wallet's history of payments and invoices made here (the node lists neither).
  createEffect(() => {
    const entries: LoggedActivity[] = [];
    for (const [key, list] of Object.entries(artifacts)) {
      const who = key.startsWith('peer:') || key.startsWith('room:') ? key.slice(5) : null;
      for (const a of list ?? []) {
        const entry = artifactActivity(a, who);
        if (entry) entries.push(entry);
      }
    }
    untrack(() => logActivity(entries));
  });

  let settingsBusy = () => false;
  let walletBusy = () => false;
  const [pairingBlockingActions, setPairingBlockingActions] = createSignal(0);
  usePairingActivity(() => pairingBlockingActions() > 0 || contextOpen() || walletTab() !== null ||
    spend()?.state === 'pending' || device()?.state === 'pending' || !!budget()?.waiting_for_owner);
  /** Run one action. An approval error re-reads the window; the caller shows the rest. */
  const act = async <T,>(run: () => Promise<T>): Promise<Outcome<T>> => {
    setPairingBlockingActions(n => n + 1);
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      const error = asActionError(e);
      if (needsApproval(error) || error.code === 'spend_refused' || error.code === 'grant_ended') void loadSpend();
      return { ok: false, error };
    } finally { setPairingBlockingActions(n => n - 1); }
  };
  /** A message the node took: show it in the thread with what it paid. */
  const sentOne = (t: TrackRef, receipt: SendReceipt, text: string, entrance = true) => {
    confirmOperation(t, receipt.operation_id, receipt.message_id);
    setPaid(receipt.message_id, receipt.amount_msat);
    setAllowances(receipt.message_id, {
      total_msat: receipt.total_msat ?? receipt.amount_msat + (receipt.readmission_msat ?? 0) + (receipt.max_routing_fee_msat ?? 0),
      max_routing_fee_msat: receipt.max_routing_fee_msat ?? 0,
      fee_paid_msat: receipt.fee_paid_msat,
      ...(receipt.readmission_msat ? { readmission_msat: receipt.readmission_msat } : {}),
    });
    if (!deliveries[receipt.message_id]) setDeliveries(receipt.message_id, deliveryFromReceipt(receipt));
    if (receipt.operation_id && ['sent', 'queued'].includes(deliveries[receipt.message_id]?.status))
      deliveryChecks.watch(receipt.operation_id, receipt.message_id);
    const sent = sentMessage(receipt, ownId(), text);
    if (entrance) setThreads('fresh', receipt.message_id, true);
    setThreads('t', trackKey(t), (old) => mergeMessages(old ?? [], [sent]));
    foldRooms([sent], false);
  };

  /**
   * One room chat: each confirmed leg in turn through the ordinary 1:1 send
   * (its budget, window, journal and exactly-once rules), capped at the price
   * the owner confirmed for that member. A paid leg that was not delivered
   * waits in that member's chat, where its only safe retry lives.
   */
  const roomSend = async (room: LocalRoom, legs: LegPlan[], plaintext: string, text: string) => {
    const outcomes = await sendRoom(legs, plaintext, async (peer, body, maxMsat) => {
      const t: TrackRef = { kind: 'peer', id: peer };
      const r = await act(() => source.send(peer, false, body, maxMsat));
      void loadBudget();
      if (r.ok) sentOne(t, r.value, body);
      else if (r.error.code === 'payment_settled_undelivered' && r.error.undelivered) {
        addArtifact(t, { type: 'undelivered', text: body, paid: r.error.undelivered, note: null, admission: null, pendingId: r.error.pending_id ?? null });
      }
      return r;
    });
    setRoomSends(room.id, (old) => [...(old ?? []), { at: Date.now(), text, outcomes }]);
    void loadWallet();
    return outcomes;
  };
  /** A budget open for autopay, or the owner's ten-minute window: the app may pay now. */
  const roomCanSpend = () => {
    const b = budget();
    if (b?.paused) return false;
    return (!!b && !b.waiting_for_owner && b.autopay.state === 'open') || spendLine(spend(), now()).open;
  };
  /** Through the budget alone, a member it would refuse before paying is skipped here. */
  const roomBudgetSkip = (peer: string, msat: number): string | null => {
    const b = budget();
    if (!b || spendLine(spend(), now()).open) return null;
    const stand = budgetStand(b, peer, false, msat);
    if (stand.kind === 'first') return tr('caNoBudgetForThemYetMessageThemOnceIn');
    if (stand.kind === 'contact_used') return tr('caTheirBudgetIsUsedUpForTodayNotCharged');
    return null;
  };
  const createRoom = async (picks: string[]) => {
    const room = rememberRoom(await newRoom(ownId(), picks));
    setRoomPlan(false);
    if (room) setTrack({ kind: 'bound', id: room.id });
  };
  /** A failed action that is not an approval or budget question stays in the track as a record. */
  const recordFailure = <T,>(t: TrackRef, action: string, outcome: Outcome<T>, text?: string): Outcome<T> => {
    // A send that did not cross (price, setpoint) is also a membrane reading. A
    // price refusal stands at their door in the track instead of a failure row.
    if (!outcome.ok) foldMembrane((log) => membraneRefused(log, outcome.error, trackKey(t), Date.now()));
    // A message whose outcome is not proven unpaid always keeps a card with its words (`text`), whatever its code.
    const keeps = text !== undefined;
    if (!outcome.ok && (keeps || isChainUnavailable(outcome.error) || (outcome.error.code !== 'not_ready' && !needsApproval(outcome.error) && !isBudgetStop(outcome.error) && outboundKind(outcome.error) !== 'price' && outcome.error.code !== 'readmission_capped' && outcome.error.code !== 'readmission_quoted'))) {
      addArtifact(t, { type: 'failed', action: FAILURE_LABEL[outcome.error.code] ?? action, error: outcome.error, ...(text !== undefined ? { text } : {}) });
    }
    return outcome;
  };

  // Calls: media is peer to peer in this webview; each signal is one paid send.
  const [callView, setCallView] = createSignal<CallView>(CALL_IDLE);
  // Only ever set on a build with sealing on. Null: the plain label.
  const [callSeal, setCallSeal] = createSignal<SealState | null>(null);
  const [callWords, setCallWords] = createSignal<string[] | null>(null);
  // Each connection gets its own label setter; only the newest may change the label.
  const nextSealLabel = sealLabelScope((state, words) => {
    setCallSeal(state);
    setCallWords(words ?? null);
  });
  // Display only, this session, never stored: the call limit (`max_call_minutes`) the box last
  // pinned on one of our reservations. The host does not report it before Ring; the
  // contact-budget line in the call confirm uses it, and shows nothing until it is seen.
  const [seenCallLimit, setSeenCallLimit] = createSignal<{ node: string; minutes: number } | null>(null);
  createEffect(() => {
    const minutes = knownCallLimit(callView().minutes?.reservation?.max_call_minutes);
    const node = ownId();
    if (node && minutes !== null) setSeenCallLimit({ node, minutes });
  });
  const callLimitMinutes = () => { const s = seenCallLimit(); return s && s.node === ownId() ? s.minutes : null; };
  const [waitingCalls, setWaitingCalls] = createSignal<CallView[]>([]);
  const waitingPanels = new Map<string, HTMLElement>();
  const isIncoming = (peer: string, id: string) => [callView(), ...waitingCalls()].some(v => v.peer === peer && v.callId === id && v.phase === 'incoming' && !v.silenced);
  const revealIncoming = (id: string, peer: string) => {
    setWalletTab(null); setContextOpen(false); setPhoneTab('chats');
    setTrack({ kind: 'peer', id: peer });
    queueMicrotask(() => (waitingPanels.get(`${peer}:${id}`) ?? callPanel)?.focus());
  };
  const [callStreams, setCallStreams] = createSignal<{ local: MediaStream | null; remote: MediaStream | null }>({ local: null, remote: null });
  const [callApproval, setCallApproval] = createSignal(false);
  const [callApprovalPeer, setCallApprovalPeer] = createSignal<string>();
  let callApprovalRevision = 0;
  const clearCallApprovalPeer = () => {
    callApprovalRevision++;
    setCallApprovalPeer(undefined);
  };
  const [callApproving, setCallApproving] = createSignal(false);
  const [callBudgetSats, setCallBudgetSats] = createSignal<string | null>(null);
  const callBudgetMsat = () => {
    const sats = Number(callBudgetSats());
    return Number.isSafeInteger(sats) && sats > 0 && sats <= 100_000 ? sats * 1000 : undefined;
  };
  const canStillAnswer = () => [callView(), ...waitingCalls()].some(view => view.phase === 'incoming');
  const answerCallEnded = () => callBudgetSats() === null && callView().phase === 'ended' && !callView().outgoing && !canStillAnswer();
  let callApprovalFrom: string | null = null;
  const closeCallApproval = () => {
    const key = callApprovalFrom;
    callApprovalFrom = null;
    clearCallApprovalPeer();
    setCallBudgetSats(null);
    if (!callApproval()) return;
    setCallApproval(false);
    queueMicrotask(() => {
      const panel = (key && waitingPanels.get(key)) || callPanel;
      if (panel?.isConnected) (panel.querySelector<HTMLElement>('[data-call-accept]:not(:disabled)') ?? panel).focus();
    });
  };
  const openCallApproval = (key: string | null = null) => {
    callApprovalFrom = key;
    clearCallApprovalPeer();
    setCallBudgetSats(null);
    setCallApproval(true);
    queueMicrotask(() => (callPanel?.querySelector<HTMLElement>('[data-call-approve]') ?? callPanel)?.focus());
  };
  const callBudgetCovered = () => {
    const requested = callBudgetMsat();
    const grant = budget()?.node_grant;
    return requested !== undefined && !!grant && grant.expires_at_ms > Date.now()
      && grant.remaining_msat >= requested;
  };
  // A replacement can finish while the original spend window remains open.
  createEffect(on(() => [spendLine(spend(), now()).open, spend()?.pending?.op_id] as const, ([open, pending], previous) => {
    if (open && !pending && previous && (!previous[0] || !!previous[1])) closeCallApproval();
  }, { defer: true }));
  const showCallBudgetRequest = (amountMsat: number | null) => {
    callApprovalFrom = null;
    clearCallApprovalPeer();
    setCallBudgetSats(amountMsat === null ? null : String(Math.ceil(amountMsat / 1000)));
    setCallApproval(amountMsat !== null);
  };
  const callApprovalBlocked = () => moneyBlocked() || callApproving() || callBudgetCovered()
    || (callBudgetSats() !== null && callBudgetMsat() === undefined);
  const approveCallSpending = async (): Promise<ApprovalResult> => {
    const skipped: ApprovalResult = { ok: false, requestId: null, grantedOp: null, bindable: false, waiting: false };
    if (callBudgetCovered()) { closeCallApproval(); return skipped; }
    if (callApprovalBlocked()) return skipped;
    setCallApproving(true);
    try {
      const result = await actions.approve(callBudgetMsat() ?? callApprovalPeer());
      if (result.ok && spendLine(spend(), now()).open && !spend()?.pending) closeCallApproval();
      return result;
    } finally { setCallApproving(false); }
  };
  // M6 A1: the node is the cell. Call audio goes app -> own node -> peer node
  // -> peer app through the host-owned media socket; app-to-app WebRTC media
  // is unreachable while the flag is on (its code stays for the lab profile).
  const routedCalls = nodeRoutedAudio();
  // Node-routed video: off unless the build says otherwise. It goes the same way as the audio.
  const routedVideo = nodeRoutedVideo();
  const [callVideoCanvas, setCallVideoCanvas] = createSignal<HTMLCanvasElement | null>(null);
  const [callVideoStatus, setCallVideoStatus] = createSignal<VideoStatus | null>(null);
  // M6 A2: the caller pays the call's minutes (one kind-404 block per 60 s,
  // drawn from the reservation its node made with the offer) from the
  // callee's answer on; both sides read the node's call status. The host
  // keeps the minutes agreed before Ring (sent with the offer), checks the
  // node's hold against them (`call_hold`, hanging up above them) and pays no
  // minute before the owner confirmed that hold. The node admits the media
  // socket only once the first minute is paid, so the adapter waits for that
  // (`admitted`) instead of paying on media open.
  const callMinutes: MinutesDeps | undefined = routedCalls ? {
    status: (peer, callId) => act(() => source.callStatus(peer, callId)),
    hold: (peer, callId, confirmReservedMsat) => act(() => source.callHold(peer, callId, confirmReservedMsat)),
    pay: async (peer, callId, seq) => {
      const r = await act(() => source.callBlock(peer, callId, seq));
      if (!r.ok && (needsApproval(r.error) || r.error.code === 'spend_refused')) setCallApproval(true);
      void loadBudget();
      void loadWallet();
      return r;
    },
  } : undefined;
  const calls = createCallEngine({
    onBudgetNeeded: showCallBudgetRequest,
    routed: routedCalls,
    routedVideo,
    minutes: callMinutes,
    audioSession: appPlatform() === 'ios' ? (live) => invoke<void>('call_audio_session', { live }) : undefined,
    // A locked or backgrounded phone silences the microphone while the call would go on being paid.
    stopWhenSilenced: isMobilePlatform(),
    closeAdmission: (operationId, peer, callId) => source.closeCallAdmission(operationId, peer, callId),
    authorize: async (peer) => {
      clearCallApprovalPeer();
      const revision = callApprovalRevision;
      setCallBudgetSats(null);
      const pairing = await act(() => source.pairingStatus());
      if (!pairing.ok) {
        if (revision === callApprovalRevision) {
          setCallApprovalPeer(routedCalls ? peer : undefined);
        }
        setErrors('spend', pairing.error.message);
        setCallApproval(true);
        return false;
      }
      const allowed = (pairing.value.state === 'fallback' ||
        (pairing.value.state === 'paired' && pairing.value.scopes.includes('spend'))) && roomCanSpend();
      if (revision === callApprovalRevision) setCallApprovalPeer(!allowed && routedCalls ? peer : undefined);
      setCallApproval(!allowed);
      return allowed;
    },
    grant: () => budget()?.node_grant ?? null,
    callLimitMinutes,
    quote: (peer) => act(() => source.callQuote(peer)),
    signal: async (peer, kind, plaintext, maxMsat, minutes, maxHangupMsat) => {
      const r = await act(() => source.callSignal(peer, kind, plaintext, maxMsat, minutes, maxHangupMsat));
      if (!r.ok && (needsApproval(r.error) || r.error.code === 'grant_ended' || r.error.code === 'spend_refused' || /token lacks.*spend|403/i.test(r.error.message))) setCallApproval(true);
      void loadBudget();
      void loadWallet();
      return r;
    },
    getUserMedia: (c) => navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia(c)
      : Promise.reject(Object.assign(new Error(tr('caNoMediaDevicesInThisWebview')), { name: NO_MEDIA_DEVICES })),
    peerConnection: routedCalls
      ? () => createNodeRoutedConnection({
          callId: () => callView().callId,
          peer: () => callView().peer,
          bridge: isTauri() ? hostMediaBridge() : unavailableMediaBridge(),
          audio: (stream, transport, onFatal) => createCallAudio({ stream, transport, onError: onFatal,
            // Phones: a microphone the OS silenced counts towards ending the call.
            ...(isMobilePlatform() ? { onSilence: (silent: boolean) => calls.micSilent(silent) } : {}) }),
          video: routedVideo ? {
            build: (transport, track) => {
              if (callView().media !== 'video') return null;
              const canvas = document.createElement('canvas');
              const callId = callView().callId;
              setCallVideoCanvas(canvas);
              setCallVideoStatus(null);
              // Only this call's engine speaks for the card: a late status from an earlier call is dropped.
              const onStatus = (status: VideoStatus) => {
                if (callVideoCanvas() === canvas && callView().callId === callId) setCallVideoStatus(status);
              };
              return createCallVideo({ transport, canvas, source: track ? trackVideoSource(track) : null, onStatus, audioDelayMs: () => AUDIO_PLAYOUT_DELAY_MS });
            },
            camera: (engine, track) => engine.setSource(track ? trackVideoSource(track) : null),
          } : undefined,
          admitted: callMinutes ? (callId, peer, closed) => waitUntilPaid(callMinutes.status, peer, callId, () => Date.now(), closed) : undefined,
          // A media session that closed for good ends its call, so no further minute is paid.
          onSession: (event) => { if (event.state === 'closed') calls.mediaClosed(event.callId); },
          // The literal flag lets a build without it drop the seal code entirely.
          ...(import.meta.env.VITE_CALL_SEAL === 'sealed' && sealedAudio() && isTauri() ? { seal: hostCallSeal(), onSeal: nextSealLabel() } : {}),
        })
      : (config) => new RTCPeerConnection(config),
    now: () => Date.now(),
    onView: view => {
      if (view.callId !== callView().callId || view.phase === 'idle' || view.phase === 'ended') {
        nextSealLabel();
        // The picture and its status belong to one call: none of it carries into the next.
        setCallVideoCanvas(null);
        setCallVideoStatus(null);
      }
      if (view.phase === 'incoming') clearCallApprovalPeer();
      setCallView(view);
      if (view.phase === 'incoming' && !view.silenced && view.callId && view.peer) notifications?.call(`${view.peer}:${view.callId}`, nameOf(view.peer), () => isIncoming(view.peer!, view.callId!), () => revealIncoming(view.callId!, view.peer!));
    },
    onMissed: call => missedCalls.add(call, openKey() === `peer:${call.peer}` && document.hasFocus() && !contextOpen() && walletTab() === null),
    onWaiting: views => {
      setWaitingCalls(views);
      for (const view of views) if (view.phase === 'incoming' && !view.silenced && view.callId && view.peer) {
        notifications?.call(`${view.peer}:${view.callId}`, nameOf(view.peer), () => isIncoming(view.peer!, view.callId!), () => revealIncoming(view.callId!, view.peer!));
      }
    },
    onStreams: (local, remote) => setCallStreams({ local, remote }),
    // STUN comes only from the owner's preference or their node's status.
    iceServers: () => stunServer(effectiveStun()),
    busy: () => meetingOn(),
    // H2: the host ends our admission (one paid hangup, or none if the offer was never paid).
    endCall: async (callId) => {
      const r = await act(() => source.opEndCall(callId));
      void loadBudget();
      void loadWallet();
      return r;
    },
    stuckCall: async (peer, opId) => {
      const list = await act(() => source.opList(peer));
      if (!list.ok) return null;
      const open = list.value.operations.filter((o) => (o.kind === 'call_offer' || o.kind === 'call_recovery') && o.call_id);
      return (opId ? open.find((o) => o.op_id === opId) : open[0])?.call_id ?? null;
    },
    provenUnpaid: (code) => provenUnpaid(code),
  });
  // The latest call and its route (candidate types only), kept after the call for the connection card.
  // A call counts once it was placed, or answered here: whether it went live, and its route once the stats name one.
  // A call refused before it had an id (their node takes no calls, the grant is too small) is the latest call too.
  const [lastCall, setLastCall] = createSignal<TrackedCall | null>(null);
  createEffect(() => {
    const v = callView(); setLastCall((prev) => nextLastCall(prev, v));
    if (v.callId && v.peer) setRecentCallPeers(ids => ids.includes(v.peer!.toLowerCase()) ? ids : [...ids, v.peer!.toLowerCase()]);
  });
  const stunSource = (): StunSource => (stunOff() ? 'off' : effectiveStunSource() === 'own' ? 'node' : effectiveStunSource() === 'configured' ? 'custom' : overview() ? 'none' : 'checking');
  // Closing the window ends the call here without paying; only Hang up pays.
  onCleanup(() => calls.endLocal());
  if (isMobilePlatform()) {
    const visibility = () => calls.setBackgrounded(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', visibility);
    visibility();
    onCleanup(() => document.removeEventListener('visibilitychange', visibility));
  }

  // Meetings: up to 4 people, one ordinary paid 1:1 call per pair (meeting.ts).
  const [meetingView, setMeetingView] = createSignal<MeetingView>(MEETING_IDLE);
  const [meetingStreams, setMeetingStreams] = createSignal<{ local: MediaStream | null; remote: Record<string, MediaStream> }>({ local: null, remote: {} });
  const [meetingPlan, setMeetingPlan] = createSignal<string[] | null>(null);
  const meetingOn = () => meetingView().phase === 'invited' || meetingView().phase === 'active';
  // Our own node takes meeting legs (genome `call_meeting_v1` on /status).
  const nodeMeets = () => overview()?.capabilities?.includes('call_meeting_v1') === true;
  const meetings = createMeetingEngine({
    quote: (peer) => act(() => source.callQuote(peer)),
    signal: async (peer, kind, plaintext, maxMsat, minutes, maxHangupMsat) => {
      const r = await act(() => source.callSignal(peer, kind, plaintext, maxMsat, minutes, maxHangupMsat));
      void loadBudget();
      void loadWallet();
      return r;
    },
    getUserMedia: (c) => navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia(c)
      : Promise.reject(Object.assign(new Error(tr('caNoMediaDevicesInThisWebview')), { name: NO_MEDIA_DEVICES })),
    peerConnection: (config) => new RTCPeerConnection(config),
    ownId: () => ownId(),
    canMeet: (peer) => nodeMeets() && peerById().get(peer.toLowerCase())?.meetings === true,
    onView: setMeetingView,
    onStreams: (local, remote) => setMeetingStreams({ local, remote }),
    iceServers: () => stunServer(effectiveStun()),
    busy: () => !['idle', 'ended'].includes(callView().phase),
    provenUnpaid: (code) => provenUnpaid(code),
  });
  onCleanup(() => meetings.endLocal());

  // Voice notes: one object URL per message, revoked when the shell goes.
  // A just-sent clip plays from its own bytes; a received one is read once.
  const voiceUrls = new Map<string, Promise<string>>();
  onCleanup(() => voiceUrls.forEach((u) => void u.then(URL.revokeObjectURL, () => undefined)));
  const actions: Actions = {
    remote: () => props.remote === true,
    localApproval: () => props.localApproval === true,
    spendScoped: () => props.spendScoped === true,
    moneyBlocked,
    callQuote: (peer) => act(() => source.callQuote(peer)),
    placeCall: (peer, media, quote) => { if (!moneyBlocked()) void calls.place(peer, media, quote); },
    callView,
    callActive: () => !['idle', 'ended'].includes(callView().phase) || meetingOn(),
    callLimitMinutes,
    callGrant: () => grantUnknown() || (budget() !== null && (!budgetConfirmed() || !!errors.budgetPoll)) ? null : budget()?.node_grant ?? null,
    // Opens the planner; the contact is pre-picked only if their node takes meetings.
    planMeeting: (peer) => {
      if (meetingOn() || routedCalls) return;
      const id = peer.toLowerCase();
      setMeetingPlan(nodeMeets() && peerById().get(id)?.meetings === true ? [id] : []);
    },
    voiceUrl: (messageId) => {
      let url = voiceUrls.get(messageId);
      if (!url) {
        url = source.voiceNote(messageId).then((b) => blobUrl(b.data_b64, b.mime_type));
        url.catch(() => voiceUrls.delete(messageId));
        voiceUrls.set(messageId, url);
      }
      return url;
    },
    fileFetch: (messageId) => source.fileFetch(messageId),
    fileSave: (messageId) => source.fileSave(messageId),
    approve: async (callPeerOrBudget) => {
      clearContactApprovalError();
      setErrors('spend', undefined);
      const r = await act(() => source.spendRequest(callPeerOrBudget));
      if (r.ok) setSpend(r.value);
      else setErrors('spend', r.error.message);
      return approvalResult(r);
    },
    lock: async () => {
      clearContactApprovalError();
      setErrors('spend', undefined);
      const r = await act(() => source.spendLock());
      if (r.ok) setSpend(r.value);
    },
    cancelSpend: async () => {
      clearContactApprovalError();
      setErrors('spend', undefined);
      const r = await act(() => source.spendCancel());
      if (r.ok) {
        // The cancel first, so the waits it ends say why, then the view.
        setSpendCancels((n) => n + 1);
        setSpend(r.value);
      }
      else setErrors('spend', r.error.message);
      void loadBudget();
    },
    spendCancels,
    device,
    ownerDeviceApproval: () => overview()?.capabilities?.includes(OWNER_DEVICE_APPROVAL) === true,
    openNodeSettings: () => {
      setTab('devices');
      setContextOpen(true);
    },
    registerDevice: async () => {
      clearContactApprovalError();
      setErrors('spend', undefined);
      const r = await act(() => source.deviceKeyRegister());
      if (r.ok) {
        setDevice(r.value);
        setErrors('spend', undefined);
      } else setErrors('spend', r.error.message);
    },
    cancelDevice: async () => {
      const r = await act(() => source.deviceKeyCancel());
      if (r.ok) setDevice(r.value);
    },
    noEnvelopeFor,
    approveContact: async (peer, perActMsat) => {
      clearContactApprovalError();
      const revision = contactApprovalRevision;
      const r = await act(() => source.relationApprove(peer, null, perActMsat));
      if (r.ok) {
        setBudgetConfirmed(false);
        setSpend(r.value);
        if (noEnvelopeFor() === peer) setNoEnvelopeFor(null);
      } else {
        if (revision === contactApprovalRevision) setContactApprovalError({
          peer: peer.toLowerCase(),
          message: r.error.code === 'device_remote_unsupported' ? tr('relationApprovalRemoteUnsupported') : r.error.message,
        });
        if (r.error.code === 'device_invalid') void loadDevice();
      }
      // The read started next is the first one after this approval returned.
      const readsFrom = budgetReadSeq + 1;
      void loadBudget();
      return { ok: r.ok, envelopeId: r.ok ? r.value.envelope_id ?? null : null, readsFrom };
    },
    budgetReadApplied,
    followUpRead: () => (budgetReadApplied() === 0 && budgetInFlight && budgetInFlight.stamp > budgetResetAt ? budgetInFlight.done : null),
    pendingRevision,
    reconcile: async () => {
      const generation = paymentGeneration;
      const revision = pendingRevision();
      const r = await act(() => source.spendReconcile());
      // A delayed check of an older slot cannot clear a newer payment in any
      // card, including through Reconcile's local onChecked callback.
      if (generation !== paymentGeneration || revision !== pendingRevision()) {
        return { ok: false, error: { code: 'spend_unknown', message: tr('caANewerPaymentStartedCheckPendingResultAgain') } };
      }
      const facts = checkFacts(r);
      if (facts.paymentKnown) {
        if (facts.fenceCleared) setReconciled((v) => v + 1);
        setLastReconciliation({ ...facts, text: r.ok ? r.value : r.error.message, pendingId: r.ok ? null : r.error.pending_id ?? null });
        void loadBudget();
        void loadWallet();
      }
      // The check may have settled an open operation: re-read the host's record for this chat.
      const here = track();
      if (here) loadOps(here);
      return r;
    },
    approveBudget: async (ceilingMsat, preset) => {
      clearContactApprovalError();
      setErrors('budget', undefined);
      const r = await act(() => source.budgetApprove(ceilingMsat, preset));
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else setErrors('budget', r.error.message);
      // A paired node asks its owner: the pending request shows from the spend view.
      void loadSpend();
      // The read started next is the first one after this approval returned (approve & send freshness).
      const readsFrom = budgetReadSeq + 1;
      void loadBudget();
      return { ...approvalResult(r), readsFrom };
    },
    setBudget: async (target, room, limitMsat) => {
      clearContactApprovalError();
      const r = await act(() => source.budgetSet(target, room, limitMsat));
      if (r.ok) {
        setBudget(r.value);
        // The response is not a fresh read: start one at once (a queued approve & send waits for it).
        void loadBudget();
      }
      return r;
    },
    pauseAll: async () => {
      clearContactApprovalError();
      setErrors('budget', undefined);
      const r = await act(() => source.budgetPause());
      if (r.ok) setBudget(r.value);
      else setErrors('budget', r.error.message);
      void loadSpend();
    },
    resume: async () => {
      clearContactApprovalError();
      setErrors('budget', undefined);
      const r = await act(() => source.budgetResume());
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else setErrors('budget', r.error.message);
      void loadSpend();
      const readsFrom = budgetReadSeq + 1;
      void loadBudget();
      return { ...approvalResult(r), readsFrom };
    },
    doorQuote: (peer) => source.firstContactQuote(peer),
    ownerRequest: (peer, cap, budget) => act(() => source.firstContactRequest(peer, cap, budget)),
    ownerStatus: (id, recipient, maxMsat) => act(() => maxMsat === undefined ? source.firstContactStatus(id, recipient) : source.firstContactStatus(id, recipient, maxMsat)),
    knownAtNode: (peer) => peerById().get(peer.toLowerCase())?.session === true,
    approvalRequest: (request) => act(() => source.approvalRequest(request)),
    approvalStatus: (opId) => act(() => source.approvalStatus(opId)),
    breakerResetOffered: () => props.remote === true && overview()?.capabilities?.includes(OWNER_DEVICE_BREAKER_RESET) === true,
    refreshBudget: () => void loadBudget(),
    ownerCancel: (id) => source.firstContactCancel(id).catch(() => {}),
    beginSending: (t, text, capMsat, waiting) => addArtifact(t, {
      type: 'sending', text, capMsat, ...(waiting ? { waiting: true as const } : {}), ...(waiting === 'allowed' ? { waitWord: 'allowed' as const } : {}),
      ...(t.kind === 'room' ? { memberCaps: Object.fromEntries((roomQuote()?.members ?? []).map((m) => [m.node_id, m.msat])) } : {}),
    }),
    keepUnsent: (t, text, reason) => { addArtifact(t, { type: 'unsent', text, why: 'refused', reason }); },
    settleWaiting: (t, id, reason) => {
      const a = (artifacts[trackKey(t)] ?? []).find((x) => x.id === id);
      if (a?.type !== 'sending' || !a.waiting) return;
      if (reason === null) {
        setArtifacts(trackKey(t), (old) => (old ?? []).map((x) => (x.id === id && x.type === 'sending' ? { ...x, waiting: undefined } : x)));
        return;
      }
      // Never handed to the send path: nothing was dispatched, so "nothing paid" is true here.
      // An empty reason: its words went back to the box, so no card is kept.
      batch(() => {
        dropArtifact(t, id);
        if (reason) addArtifact(t, { type: 'unsent', text: a.text, why: 'refused', reason });
      });
    },
    restoreUnsent: (t, id) => {
      const a = (artifacts[trackKey(t)] ?? []).find((x) => x.id === id);
      if (a?.type !== 'unsent') return;
      setPrefill({ seq: ++prefillSeq, key: trackKey(t), mode: 'message', text: a.text, sats: null, unsentId: id });
    },
    discardUnsent: (t, id) => dropArtifact(t, id),
    queue,
    send: async (t, text, maxMsat, firstContactMsat, pendingBubble) => {
      if (t.kind !== 'peer' && t.kind !== 'room') return { ok: false, error: { code: 'invalid', message: tr('caNothingToSendTo') } };
      // Optimistic: the message shows at once as "Sending · up to N"; the
      // settled message (or its failure card) replaces it below.
      const sendingId = pendingBubble ?? addArtifact(t, { type: 'sending', text, capMsat: maxMsat });
      // A room's member caps are the ones quoted at the press, even after a queue wait.
      const pressed = (artifacts[trackKey(t)] ?? []).find((a) => a.id === sendingId);
      const memberCaps = pressed?.type === 'sending' && pressed.memberCaps
        ? pressed.memberCaps
        : Object.fromEntries((roomQuote()?.members ?? []).map((m) => [m.node_id, m.msat]));
      const settled = await act(() => source.send(t.id, t.kind === 'room', text, maxMsat, t.kind === 'room' ? memberCaps : undefined, firstContactMsat));
      const r = settled;
      // Classified by error code only. An error's operation_id is a link: the
      // host reuses an id for a resend over a resumable record, and names its
      // pending fence's op, so an id never proves that nothing was dispatched.
      // A refusal remains authoritative until a read started afterward proves
      // this contact's envelope live (including approval on another device).
      if (!r.ok && r.error.code === 'grant_no_envelope' && t.kind === 'peer') {
        noEnvelopeAfterRead = budgetReadSeq;
        setNoEnvelopeFor(t.id);
      }
      // The tally moved, or a budget rule stopped the send: either way, re-read it.
      if (r.ok || isBudgetStop(r.error) || ['spend_unknown', 'payment_unknown', 'failed_paid', 'payment_settled_undelivered'].includes(r.error.code)) void loadBudget();
      if (!r.ok && r.error.code === 'payment_settled_undelivered' && r.error.undelivered) {
        // Paid, not delivered: the draft moves here, with the only safe way to resend it.
        const undelivered = r.error.undelivered;
        batch(() => {
          dropArtifact(t, sendingId);
          addArtifact(t, { type: 'undelivered', text, paid: undelivered, note: null, admission: null, pendingId: r.error.pending_id ?? null, ...(r.error.operation_id ? { operationId: r.error.operation_id } : {}) });
        });
        return r;
      }
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) {
        if (t.kind === 'peer') void loadPrice(t);
        else void attempt('quote', () => source.roomQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q);
        });
      }
      return batch(() => {
        // The receipt names this send's message: echoes claimed by another
        // bubble give it back, and echoes this bubble claimed that are not it
        // are released (they were someone else's same words).
        const released = r.ok && t.kind === 'peer' ? settleEchoes(t, sendingId, r.value.message_id) : [];
        dropArtifact(t, sendingId);
        // The bubble was already on screen: the settled message takes its place without a second entrance.
        if (r.ok) sentOne(t, r.value, text, false);
        for (const m of released) reclaimEcho(t, m);
        // Unknown or partly paid: the failure card keeps the whole text, with no resend.
        return recordFailure(t, !r.ok && r.error.code === 'room_partial' ? tr('caRoomSendIncomplete') : tr('caMessageNotSent535'), r, !r.ok && !provenUnpaid(r.error.code) ? text : undefined);
      });
    },
    retryDelivery: async (t, artifactId, approvedMsat) => {
      if (moneyBlocked()) return { ok: false, error: { code: 'not_ready', message: MONEY_NOT_READY } };
      const submittedApprovalRevision = retryApprovalRevision;
      const submittedView = viewGeneration;
      const key = trackKey(t);
      const a = (artifacts[key] ?? []).find((x) => x.id === artifactId);
      if (t.kind !== 'peer' || a?.type !== 'undelivered' || !a.paid.retry) {
        return { ok: false, error: { code: 'retry_unavailable', message: tr('caNothingToRetry') } };
      }
      // Only the price the card shows can be approved.
      if (approvedMsat !== undefined && approvedMsat !== a.admission?.total_msat) {
        return { ok: false, error: { code: 'retry_unavailable', message: tr('caNothingToApprove') } };
      }
      const text = a.text;
      const update = (next: Partial<Extract<Artifact, { type: 'undelivered' }>> | null) =>
        setArtifacts(key, (old) => (old ?? []).flatMap((x) => (x.id !== artifactId ? [x] : next ? [{ ...x, ...next } as Artifact] : [])));
      const current = () => !moneyBlocked() && submittedApprovalRevision === retryApprovalRevision && submittedView === viewGeneration && (artifacts[key] ?? []).some((x) => x.id === artifactId && x.type === 'undelivered' && x.pendingId === a.pendingId);
      const waiting: Outcome<unknown> = { ok: false, error: { code: 'owner_only', message: tr('caApproveThisRetryAtYourNodeThenCheckApproval') } };
      if (approvedMsat !== undefined) {
        const ownerApproval = a.ownerApproval;
        if (ownerApproval) {
          const ready = await act(() => source.firstContactStatus(ownerApproval.id));
          if (!current()) return waiting;
          if (!ready.ok) {
            void source.firstContactCancel(ownerApproval.id).catch(() => {});
            update({ ownerApproval: null, note: ready.error.message });
            return ready;
          }
          if (!ready.value.ready) return waiting;
        } else {
          const request = await act(() => source.firstContactRequest(t.id, approvedMsat));
          if (!current()) {
            if (request.ok && request.value) void source.firstContactCancel(request.value.id).catch(() => {});
            return waiting;
          }
          if (!request.ok) { update({ note: request.error.message }); return request; }
          if (request.value) {
            update({ ownerApproval: request.value, note: waiting.error.message });
            return waiting;
          }
        }
      }
      update({ ownerApproval: null });
      const r = await act(() => source.retry(t.id, text, approvedMsat));
      void loadBudget();
      if (r.ok) {
        setPendingRevision((v) => v + 1);
        update(null);
        sentOne(t, r.value, text);
      } else if (r.error.code === 'payment_settled_undelivered' && r.error.undelivered) {
        const paid = r.error.undelivered;
        update({ paid, admission: null, pendingId: r.error.pending_id ?? a.pendingId, note: tr('caStillNotDeliveredPaidForThisMessageSoFar', sats(paid.paid_msat), satUnit(paid.paid_msat)) });
      } else if (r.error.code === 'not_ready') {
        // The paid card stays retryable; a chain refusal names only this attempt.
        update({ ownerApproval: null, note: isChainUnavailable(r.error) ? tr('chainUnavailableRetry') : null });
      } else if (r.error.code === 'retry_needs_admission') {
        // Stopped before paying: the price to approve, when the node could tell.
        update({ admission: r.error.admission ?? null, note: r.error.message });
      } else {
        // A refusal before dispatch (approval, price) keeps the retry; anything else ends it.
        // A refused approved price is spent: Retry delivery asks for the current one.
        // Only a code proven unpaid keeps Retry delivery: any other (e.g. budget_unreadable after a paid
        // retry, app.rs refine_retry_fee) may have paid, so retrying from here could pay again.
        const ends = r.error.code === 'retry_unavailable' || !provenUnpaid(r.error.code);
        update({ paid: { ...a.paid, retry: !ends }, note: r.error.message, admission: r.error.code === 'price_cap_exceeded' ? null : a.admission });
      }
      return r;
    },
    stopRetrying: async (t, pendingId) => {
      // Only the record this card (or the pending check) showed: never another one.
      if (!pendingId) return { ok: false, error: { code: 'retry_unavailable', message: tr('caCheckThePendingResultFirst') } };
      const r = await act(() => props.source.dismissUndelivered(pendingId));
      void loadBudget();
      if (r.ok) {
        setPendingRevision((v) => v + 1);
        setReconciled((v) => v + 1);
        setLastReconciliation({ paymentKnown: true, fenceCleared: true, text: r.value, pendingId: null });
        // Every card for that record ends, wherever it was stopped from.
        for (const key of Object.keys(artifacts)) {
          for (const a of artifacts[key] ?? []) {
            if (a.type === 'undelivered' && a.pendingId === pendingId && a.ownerApproval) {
              void props.source.firstContactCancel(a.ownerApproval.id).catch(() => {});
            }
          }
          if ((artifacts[key] ?? []).some((x) => x.type === 'undelivered' && x.pendingId === pendingId)) {
            setArtifacts(key, (old) => (old ?? []).filter((x) => !(x.type === 'undelivered' && x.pendingId === pendingId)));
          }
        }
        if (t) addArtifact(t, { type: 'failed', action: tr('caStoppedRetrying'), error: { code: 'undelivered_pending', message: r.value } });
      }
      return r;
    },
    invoice: async (t, msat, note) => {
      const r = await act(() => source.invoiceCreate(msat, note));
      if (r.ok) addArtifact(t, { type: 'invoice', invoice: r.value });
      return r;
    },
    readInvoice: (bolt11) => act(() => source.invoiceAmount(bolt11)),
    pay: async (t, bolt11, msat) => {
      paymentGeneration++;
      const r = await act(() => source.pay(bolt11, msat, allIn(msat)));
      void loadBudget();
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, invoice: bolt11, at: r.value.paid_at_ms });
        void loadWallet();
      }
      if (r.ok && r.value.status === 'failed') paymentFailures++;
      return recordFailure(t, tr('caPaymentNotSent'), r);
    },
    keysend: async (t, pubkey, msat, memo) => {
      paymentGeneration++;
      const r = await act(() => source.keysend(pubkey, msat, memo.trim() || null, allIn(msat)));
      void loadBudget();
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, at: r.value.paid_at_ms });
        void loadWallet();
      }
      if (r.ok && r.value.status === 'failed') paymentFailures++;
      return recordFailure(t, tr('caPaymentNotSent'), r);
    },
    file: async (t, file, maxMsat, firstContactMsat) => {
      if (t.kind !== 'peer') return { ok: false, error: { code: 'invalid', message: tr('caFilesGoToOnePeerAtATime') } };
      const data = await readBase64(file).catch(() => null);
      if (data === null) return { ok: false, error: { code: 'invalid', message: tr('caTheFileCouldNotBeRead') } };
      const r = await act(() => source.fileSend(t.id, file.name, file.type, data, maxMsat, firstContactMsat));
      void loadBudget();
      void loadWallet();
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) void attempt('quote', () => source.filePrice(), setFilePrice);
      if (r.ok) {
        confirmOperation(t, r.value.operation_id, r.value.message_id);
        if (isVoiceNote(200, file.name)) voiceUrls.set(r.value.message_id, Promise.resolve(URL.createObjectURL(file)));
        setPaid(r.value.message_id, r.value.amount_msat);
        setAllowances(r.value.message_id, { total_msat: r.value.total_msat ?? r.value.amount_msat + (r.value.max_routing_fee_msat ?? 0), max_routing_fee_msat: r.value.max_routing_fee_msat ?? 0, fee_paid_msat: r.value.fee_paid_msat, readmission_msat: r.value.readmission_msat });
        if (!deliveries[r.value.message_id]) setDeliveries(r.value.message_id, deliveryFromReceipt(r.value));
        setThreads('fresh', r.value.message_id, true);
        setThreads('t', trackKey(t), (old) => mergeMessages(old ?? [], [sentFileMessage(r.value, ownId())]));
      }
      return recordFailure(t, tr('caFileNotSent'), r);
    },
  };

  const pill = () => {
    const held = props.pillStatus;
    return nodePill({
      remote: props.remote, phone: props.phone, retryAfterSecs: props.retryAfterSecs,
      ready: held ? held.ready : props.ready, error: held ? held.error : props.error,
      quiet: held?.quiet, statusChecked: !!held,
      overview: overview(), link: link(), nowMs: now(),
    });
  };

  const trackName = (t: TrackRef): string => {
    if (t.kind === 'peer') return peerName(peerById().get(t.id), t.id);
    if (t.kind === 'room') return rooms().find((r) => r.id.toLowerCase() === t.id)?.name ?? tr('caRoom');
    if (t.kind === 'bound') return boundName(t.id);
    if (t.kind === 'ai') return 'AI';
    if (t.kind === 'assistant') return ASSISTANTS[t.id].name;
    if (t.kind === 'discover') return tr('uiBrowse');
    if (t.kind === 'porch') return tr('uiPorch');
    return tr('caStartSomething');
  };
  const nameOf = (id: string) => (id.toLowerCase() === ownId().toLowerCase() ? tr('uiYou') : peerName(peerById().get(id.toLowerCase()), id));
  /** Resolve only an unambiguous mapping reported by the node. */
  const channelName = (pubkey: string) => {
    const matches = peers().filter((p) => p.ln_pubkey?.toLowerCase() === pubkey.toLowerCase());
    return matches.length === 1 ? nameOf(matches[0].node_id) : nameOf(pubkey);
  };
  /** A room is named by its other members, as the owner calls them. */
  const boundName = (id: string) => {
    const own = ownId().toLowerCase();
    return localRoom(id)?.roster.filter((p) => p !== own).map(nameOf).join(', ') || tr('caRoom');
  };
  const trackKeyName = (key: string) => {
    const [kind, id] = key.split(':');
    if (kind === 'bound') return boundName(id ?? '');
    return kind === 'room' ? rooms().find((r) => r.id.toLowerCase() === id)?.name ?? tr('caRoom') : nameOf(id ?? key);
  };
  const roomContacts = () => peers().map((p) => ({
    id: p.node_id.toLowerCase(), name: peerName(p, p.node_id),
    contact: true, connected: p.connected, rooms: p.rooms === true, session: p.session === true,
  }));
  // The Wallet pays only through the composer's own actions; its receipts go to the `wallet` key.
  const WALLET: TrackRef = { kind: 'wallet' };
  const walletActions: WalletActions = {
    readInvoice: (bolt11) => actions.readInvoice(bolt11),
    pay: (bolt11, msat) => actions.pay(WALLET, bolt11, msat),
    keysend: (pubkey, msat, memo) => actions.keysend(WALLET, pubkey, msat, memo),
    invoice: (msat, note) => actions.invoice(WALLET, msat, note),
    approve: async () => { await actions.approve(); },
  };
  const openWallet = (tab: WalletTab = 'activity') => {
    // Settings is replaced by Wallet; its hidden controls cannot receive focus on return.
    walletReturnFocus = contextOpen() ? settingsReturnFocus : document.activeElement as HTMLElement | null;
    setContextOpen(false);
    setWalletTab(tab);
    if (phoneShell()) setPhoneTab('wallet');
    void loadWallet();
  };

  const openPhoneSettings = (page: ReturnType<typeof tab>) => { if (phoneGuard.check() || walletBusy()) return; setTab(page); setContextOpen(true); };
  const selectPhoneTab = (next: PhoneTab) => {
    if (phoneGuard.check() || walletBusy() || pairingBlockingActions() > 0) return;
    if (next === 'chats' && phoneTab() === 'chats') phoneBack();
    if (next === 'wallet') { if (walletTab() === null) openWallet(); }
    else { setWalletTab(null); setPhoneTab(next); }
  };
  const openPhoneTrack = (next: TrackRef) => {
    phoneOpener = document.activeElement as HTMLElement | null;
    setPhoneTab('chats'); setTrack(next);
    queueMicrotask(() => document.querySelector<HTMLButtonElement>('[data-ios-back="thread"]')?.focus());
  };
  const closeWallet = () => { setWalletTab(null); if (phoneShell()) setPhoneTab('chats'); };

  const welcomeHome = () => <WelcomeHome overview={overview()} moneyBlocked={moneyBlocked()} walletReady={wallet() !== null && !errors.wallet}
      onShare={() => { setTab('frontdoor'); setContextOpen(true); }}
      onAddContact={() => setTrack({ kind: 'discover' })}
      onAddSats={() => openWallet('receive')} />;

  // Desktop: the money notice floats over the message list (StreamFrame) when there is one, and
  // sits in the column otherwise (start view, welcome, loading).
  const moneyNotice = () => <p class="hint money-notice" data-money-notice role="status">{!live() ? tr('waitingConnection') : tr('moneyNotReady')} {tr('moneyReadinessScope')}</p>;
  const [streamFrames, setStreamFrames] = createSignal(0);
  const streamNote = { show: () => moneyBlocked() && !phoneShell(), note: moneyNotice, frame: (d: 1 | -1) => setStreamFrames((n) => n + d) };

  return (
    <div class="cc" data-phone-shell={phoneShell() ? "true" : undefined} classList={{ 'no-context': !props.active }} data-mode={source.mode}
      data-swipe-call={!['idle', 'ended'].includes(callView().phase) || !['idle', 'ended'].includes(meetingView().phase)}>
      <Show when={props.active && !isMobilePlatform()}>
        <OwnerApprovalSheets approvals={approvals()} error={approvalsError()} now={now()}
          memory={approvalsMemory} approve={approveOwner} recheck={recheckApproval}
          blocked={contextOpen() || walletTab() !== null}
          onNotificationReview={() => {
            // Select the request without unmounting an in-flight action or owner ceremony.
            // The sheet waits behind the panel until the owner leaves it.
            if (settingsBusy() || walletBusy() || pairingBlockingActions() > 0 || approvalsMemory.busy() !== null ||
                spend()?.state === 'pending' || device()?.state === 'pending' || budget()?.waiting_for_owner || props.checkingNode) return;
            setContextOpen(false); setWalletTab(null);
          }} />
      </Show>
      <Show when={phoneShell()}>
        <header class="phone-status" data-phone-status inert={contextOpen() || phoneGuard.blocked()}>
          <button class="node-pill" data-pill={pill().tone} onClick={() => openPhoneSettings('node')} aria-haspopup="dialog">
            <span class={`dot ${pill().tone}`} classList={{ live: pill().live }} />
            <span class="what">{pill().text}</span>
          </button>
          <OnCallPill view={callView()} onReturn={() => {
            setWalletTab(null); setPhoneTab('chats');
            if (callView().peer) setTrack({ kind: 'peer', id: callView().peer!.toLowerCase() });
            queueMicrotask(() => callPanel?.focus());
          }} />
          {props.offline}
          <ChainNotice overview={overview()} />
          <CallRepairs source={source} refreshKey={callView().error} blocked={moneyBlocked()}
            onEnded={() => { void loadBudget(); void loadWallet(); }} />
          <Show when={moneyBlocked()}><p class="hint money-notice" data-money-notice role="status">{!live() ? tr('waitingConnection') : tr('moneyNotReady')} {tr('moneyReadinessScope')}</p></Show>
        </header>
      </Show>
      <Rail
        phone={phoneShell()}
        hidden={phoneShell() && (phoneTab() !== 'chats' || track() !== null)}
        listRef={el => { phoneList = el; }}
        callView={callView()}
        onReturnToCall={() => {
          const peer = callView().peer;
          setWalletTab(null);
          setContextOpen(false);
          if (peer) setTrack({ kind: 'peer', id: peer.toLowerCase() });
          queueMicrotask(() => callPanel?.focus());
        }}
        pill={pill()}
        active={props.active}
        sample={source.mode === 'sample'}
        peers={peers()}
        peersPending={!peersLoaded()}
        peersError={errors.peers}
        peersErrorInMain={!phoneShell() && !track() && !peersLoaded() && walletTab() === null}
        onReconnect={async () => { await props.onReconnect?.(); await loadPeers(); }}
        rooms={rooms()}
        nodeRooms={nodeRooms()}
        nodeKnown={overview() !== null}
        boundRooms={localRooms()}
        boundName={boundName}
        onNewRoom={() => setRoomPlan(true)}
        knocks={knocks()}
        nameOf={nameOf}
        unread={Object.entries(missedCalls.unread()).reduce((all, [key, count]) => ({ ...all, [key]: (all[key] ?? 0) + count }), { ...threads.unread })}
        openKey={openKey()}
        ownId={ownId()}
        onOpen={(next) => phoneShell() ? openPhoneTrack(next) : setTrack(next)}
        onProfile={() => {
          setTab('body');
          setContextOpen(true);
        }}
        onNode={() => {
          setTab('node');
          setContextOpen(true);
        }}
        onWallet={() => openWallet()}
        balanceMsat={wallet()?.balance_msat ?? null}
        approvalsWaiting={approvalsWaiting()}
        onApprovals={() => { setTab('node'); setContextOpen(true); }}
        behind={walletTab() !== null || contextOpen()}
      />

      <Show when={props.active} fallback={<section class="track">{props.firstRun}</section>}>
        <StreamNoteContext.Provider value={streamNote}>
        <section class="track" aria-label={tr('caTrack')} hidden={phoneShell() && (phoneTab() !== 'chats' || track() === null)} inert={walletTab() !== null || contextOpen()}>
          <Show when={track()}><button type="button" class="link ios-back" data-ios-back="thread" onClick={phoneBack}><Show when={phoneShell()}><span aria-hidden="true">‹ </span></Show>{tr('uiBack')}</button></Show>
          <Show when={!phoneShell()}>
            {props.offline}
            <ChainNotice overview={overview()} />
            <CallRepairs source={source} refreshKey={callView().error} blocked={moneyBlocked()}
              onEnded={() => { void loadBudget(); void loadWallet(); }} />
          </Show>
          <Show when={notifications && props.active && !contextOpen() && walletTab() === null}>
            <Show when={callView().phase !== 'idle' || waitingCalls().length > 0}><NotificationSettings notifications={notifications!} offer /></Show>
          </Show>
          <Show when={moneyBlocked() && !phoneShell() && streamFrames() === 0}>
            <div class="money-notice-float">{moneyNotice()}</div>
          </Show>
          <Show when={introNotice()}>
            {(n) => (
              <p class="ok-note intro-notice" data-intro-notice={n().node_id} role="status">
                {tr('caConnectedTo')}{' '}{shortId(n().node_id)}{' '}{tr('caFromTheirIntroductionNothingWasPaid')}{' '}
                <button type="button" class="link" data-intro-notice-open onClick={() => openIntroduced(n())}>
                  {tr('caOpenConversation')}</button>{' '}
                <button type="button" class="link" onClick={() => setIntroNotice(null)}>
                  {tr('ownerApprovalDismiss')}</button>
              </p>
            )}
          </Show>
          <Show when={track()} fallback={
            <Show when={peersLoaded()} fallback={
              <div class="empty-track">
                <Show when={errors.peers} fallback={<DelayedSpinner />}>
                  <SoftError message={errors.peers!} summary={tr('caCouldNotLoadContacts')} onReconnect={async () => { await props.onReconnect?.(); await loadPeers(); }} />
                </Show>
              </div>
            }>{welcomeHome()}</Show>
          }>
            {(t) => (
              <Switch>
                <Match when={t().kind === 'ai'}>
                  <AiTrack
                    source={source}
                    session={aiSession}
                    peers={peers()}
                    now={now()}
                    onPrefill={openDraft}
                    onContext={() => setContextOpen(true)}
                    head={(title, sub) => <TrackHead title={title} sub={sub} onContext={() => setContextOpen(true)} />}
                  />
                </Match>
                <Match when={t().kind === 'assistant'}>
                  <Show when={t().kind === 'assistant' ? (t() as { id: AssistantId }).id : undefined} keyed>
                    {(id) => <AiTrack
                      source={source}
                      session={createAiSession()}
                      assistant={id}
                      watchUpdate={props.watchUpdates?.[id]}
                      watchError={props.watchError}
                      peers={peers()}
                      now={now()}
                      onPrefill={() => {}}
                      onContext={() => setContextOpen(true)}
                      head={(title, sub) => <TrackHead title={title} sub={sub} onContext={() => setContextOpen(true)} />}
                    />}
                  </Show>
                </Match>
                <Match when={t().kind === 'new'}>
                  <NewTrack
                    nodeRooms={nodeRooms()}
                    moneyBlocked={moneyBlocked()}
                    ownId={ownId()}
                    source={source}
                    spend={spend()}
                    now={now()}
                    actions={actions}
                    spendError={errors.spend ?? errors.spendPoll}
                    onContext={() => setContextOpen(true)}
                    onIntroduced={(card, follow) => {
                      setIntroduced(card.node_id.toLowerCase(), card);
                      // The originating form decides whether its instance and
                      // state still match the Continue that started this work.
                      if (follow && untrack(track)?.kind === 'new') openIntroduced(card);
                      else setIntroNotice(card);
                    }}
                  />
                </Match>
                <Match when={t().kind === 'discover'}>
                  <DiscoverPanel
                    source={source}
                    now={now()}
                    onKnocked={(card) => {
                      const step: Doorstep = {
                        node_id: card.node_id,
                        network: card.network,
                        endpoint: card.endpoint,
                        reach: card.reach,
                        admission_msat: card.prices.admission_msat,
                        message_msat: card.prices.message_msat,
                        issued_at: card.issued_at,
                        expires_at: card.expires_at,
                        link: card.link,
                      };
                      setDoorstep(card.node_id.toLowerCase(), step);
                      openDoorstep(step);
                    }}
                  />
                </Match>
                <Match when={t().kind === 'bound' ? localRoom((t() as { id: string }).id) : undefined}>
                  {(room) => (
                    <RoomThread
                      room={room()}
                      ownId={ownId()}
                      nameOf={nameOf}
                      messages={threads.t[trackKey(t())] ?? []}
                      deliveries={deliveries}
                      earlier={roomPages[room().id]?.more === true}
                      loadingEarlier={roomPages[room().id]?.loading === true}
                      read={threadRead[trackKey(t())] ?? 'pending'}
                      error={threadError[trackKey(t())]}
                      onEarlier={() => loadRoomPage(room().id, roomPages[room().id]?.before ?? null)}
                      sends={roomSends[room().id] ?? []}
                      fresh={threads.fresh}
                    seenEntrances={seenEntrances}
                      info={(peer) => roomContacts().find((c) => c.id === peer)}
                      quote={(peer) => source.priceQuote(peer).catch(() => null)}
                      budgetSkip={roomBudgetSkip}
                      moneyBlocked={moneyBlocked()}
                      canSpend={roomCanSpend()}
                      spendGate={<SpendBar spend={spend()} error={errors.spend ?? errors.spendPoll} now={now()} actions={actions} />}
                      now={now()}
                      send={(legs, plaintext, text) => roomSend(room(), legs, plaintext, text)}
                      onLeave={() => {
                        leaveRoom(room().id);
                        setTrack(null);
                      }}
                      onContext={() => setContextOpen(true)}
                    />
                  )}
                </Match>
                <Match when={t().kind === 'porch'}>
                  <PorchPanel
                    source={source}
                    now={now()}
                    peers={peers()}
                    nodeReads={overview()?.capabilities?.some((c) => c === 'porch_quote_v1' || c === 'porch_read_v1') === true}
                    known={overview() !== null && (peersLoaded() || !!errors.peers)}
                    peersFailed={!!errors.peers}
                    moneyBlocked={moneyBlocked()}
                    spend={spend()}
                    spendGate={<SpendBar spend={spend()} error={errors.spend ?? errors.spendPoll} now={now()} actions={actions} />}
                    nameOf={nameOf}
                  />
                </Match>
                <Match when={t().kind === 'peer' || t().kind === 'room'}>
                  <Conversation
                    nodeRooms={nodeRooms()}
                    moneyBlocked={moneyBlocked()}
                    track={t()}
                    name={trackName(t())}
                    peer={t().kind === 'peer' ? peerById().get((t() as { id: string }).id) : undefined}
                    introduced={t().kind === 'peer' ? introduced[(t() as { id: string }).id] : undefined}
                    doorstep={t().kind === 'peer' ? doorstep[(t() as { id: string }).id] : undefined}
                    members={t().kind === 'room' ? members[(t() as { id: string }).id] ?? null : null}
                    messages={threads.t[trackKey(t())] ?? []}
                    artifacts={[...(artifacts[trackKey(t())] ?? []), ...missedCalls.records().filter(r => t().kind === 'peer' && `peer:${r.peer}` === trackKey(t()))]}
                    fresh={threads.fresh}
                    seenEntrances={seenEntrances}
                    deliveries={deliveries}
                    paid={paid}
                    allowances={allowances}
                    ownId={ownId()}
                    homeNetwork={overview()?.network ?? null}
                    nameOf={nameOf}
                    quote={quote()}
                    quoteError={quoteError()}
                    refreshPrice={() => void loadPrice(t())}
                    roomQuote={roomQuote()}
                    filePrice={filePrice()}
                    spend={spend()}
                    spendError={errors.spend ?? errors.spendPoll}
                    budget={budget()}
                    budgetError={errors.budget ?? errors.budgetPoll}
                    approvalError={approvalErrorFor(t())}
                    budgetStale={grantUnknown() || (budget() !== null && (!budgetConfirmed() || !!errors.budgetPoll))}
                    actions={actions}
                    now={now()}
                    error={threadError[trackKey(t())]}
                    read={threadRead[trackKey(t())] ?? 'pending'}
                    onReconnect={async () => { await props.onReconnect?.(); await loadThread(t()); }}
                    prefill={prefill()}
                    onPrefillUsed={() => setPrefill(null)}
                    onContext={() => setContextOpen(true)}
                  />
                </Match>
              </Switch>
            )}
          </Show>
        </section>
        </StreamNoteContext.Provider>
      </Show>

      <Show when={phoneShell()}>
        <Show when={phoneTab() === 'you'}>
          <section class="phone-page" data-phone-you inert={contextOpen()} aria-label={tr('uiYou')}>
            <h1>{tr('uiYou')}</h1>
            <button class="primary" data-phone-share onClick={() => openPhoneSettings('frontdoor')}>{tr('phoneShare')}</button>
            <button class="soft" data-phone-settings onClick={() => openPhoneSettings('body')}>{tr('uiProfileAndSettings')}</button>
            <button class="soft" data-phone-devices onClick={() => openPhoneSettings('devices')}>{tr('phoneAddDevice')}</button>
            <Show when={approvalsWaiting() > 0}><button class="soft" onClick={() => openPhoneSettings('node')}>{tr('uiApprovalsWaiting')} ({approvalsWaiting()})</button></Show>
          </section>
        </Show>
        <Show when={phoneTab() === 'calls'}>
          <section class="phone-page" data-phone-calls inert={contextOpen()} aria-label={tr('phoneCalls')}>
            <h1>{tr('phoneCalls')}</h1>
            <For each={callPeers()}>{id => <button class="track-link" onClick={() => openPhoneTrack({ kind: 'peer', id })}>
              <span class="name">{nameOf(id)}</span><span class="meta">{tr('phoneOpenChat')}</span>
            </button>}</For>
          </section>
        </Show>
        <PhoneTabs selected={phoneTab()} calls={callPeers().length > 0} onSelect={selectPhoneTab} behind={contextOpen() || phoneGuard.blocked()} />
      </Show>

      {/* Profile / settings: Body, Node, Wallet, Budget and display prefs. Always
          mounted so existing tests can open tabs; closed until the avatar is pressed. */}
      <div
        class="settings-scrim"
        classList={{ open: contextOpen() }}
        data-settings-open={contextOpen() ? 'true' : 'false'}
        onClick={() => setContextOpen(false)}
      />
      <PairingActivityProvider onActivity={active => { settingsBusy = active; }}>
      <aside
        ref={setSettingsEl}
        class="context settings-modal"
        classList={{ open: contextOpen() }}
        aria-label={tr('uiProfileAndSettings')}
        aria-hidden={contextOpen() ? 'false' : 'true'}
        aria-modal={contextOpen() ? true : undefined}
        role="dialog"
        data-settings
        data-swipe-approval={contextOpen() && ['budget', 'devices'].includes(tab())}
      >
        <div class="row settings-head">
          <Show when={tab() !== 'body'}><button type="button" class="link ios-back" data-ios-back="settings-page" onClick={() => setTab('body')}>{tr('uiBack')}</button></Show>
          <div class="tabs" role="tablist" style={{ flex: 1 }}>
            <button role="tab" aria-selected={tab() === 'general'} data-tab="general" onClick={() => { setTab('general'); setContextOpen(true); }}>{tr('uiGeneral')}</button>
            <button role="tab" aria-selected={tab() === 'body'} data-tab="body" onClick={() => { setTab('body'); setContextOpen(true); }}>{tr('uiBody')}</button>
            <button role="tab" aria-selected={tab() === 'node'} data-tab="node" onClick={() => { setTab('node'); setContextOpen(true); }}>{tr('uiNode')}</button>
            <button role="tab" aria-selected={tab() === 'devices'} data-tab="devices" onClick={() => { setTab('devices'); setContextOpen(true); }}>{tr('uiDevices')}</button>
            <button role="tab" aria-selected={tab() === 'wallet'} data-tab="wallet" onClick={() => { setTab('wallet'); setContextOpen(true); }}>{tr('uiWallet')}</button>
            <button role="tab" aria-selected={tab() === 'budget'} data-tab="budget" onClick={() => { setTab('budget'); setContextOpen(true); }}>{tr('uiBudget')}</button>
            <button role="tab" aria-selected={tab() === 'frontdoor'} data-tab="frontdoor" onClick={() => { setTab('frontdoor'); setContextOpen(true); }}>{tr('uiProfile')}</button>
          </div>
          <button class="quiet context-toggle" data-settings-close data-ios-back="settings" onClick={() => setContextOpen(false)} aria-label={tr('uiCloseSettings')}>{tr('uiClose')}</button>
        </div>
        <Switch>
          <Match when={tab() === 'general'}>
            <SettingsDisplay own={ownStun()} />
            <Show when={notifications}>{n => <NotificationSettings notifications={n()} />}</Show>
          </Match>
          <Match when={tab() === 'body'}>
            <Organism
              readiness={readinessLine(overview(), now())}
              sample={source.mode === 'sample'}
              now={now()}
              openedAt={openedAt()}
              link={link()}
              down={!!props.error || (overview() !== null && freshness(overview()!.read_at, now()).stale)}
              metabolism={nodeEnergy() ? nodeMetabolism(nodeEnergy()!.hour, nodeEnergy()!.day) : metabolism(threads.t, ownId(), now(), paid)}
              energyAt={energyAt()}
              energyReadAt={energyReadAt()}
              membrane={membrane()}
              nodeMembrane={caps().membrane}
              membraneReadAt={membraneReadAt()}
              prePaymentRefusals={caps().membrane ? prePaymentRefusals() : null}
              membraneError={errors.membrane}
              door={door()}
              doorError={errors.door}
              homeostasis={homeostasis(budget())}
              budgetReadAt={budgetReadAt()}
              nucleus={nucleus(props.ownId, overview())}
              nameOfTrack={trackKeyName}
              nameOf={nameOf}
              onSetpoints={() => setTab('budget')}
              onPauseAll={() => void actions.pauseAll()}
              resumeBlocked={moneyBlocked()}
              onResume={() => void actions.resume()}
            />
          </Match>
          <Match when={tab() === 'node'}>
            <NodePanel connection={<ConnectionCard remote={props.remote === true} link={link()} live={live()} locked={props.nodeLocked} answer={props.nodeAnswer ?? null}
              stun={stunSource()} lastCall={lastCall() && { connected: lastCall()!.connected, route: lastCall()!.route }} onCheck={props.onCheckNode} checking={props.checkingNode} />} deviceApprovals={<>
              {/* A discovery error shows on its own, even when the very first read failed. */}
              <Show when={canApprove() || (approvalsCapable() && approvalsError() !== null)}>
                <OwnerApprovals
                  onReview={!isMobilePlatform() ? id => { approvalsMemory.reviewOpener = settingsReturnFocus; approvalsMemory.setReview(id); setContextOpen(false); } : undefined}
                  approvals={approvals()}
                  error={approvalsError()}
                  recheck={recheckApproval}
                  memory={approvalsMemory}
                  now={now()}
                  mobile={isMobilePlatform()}
                  nameOf={(id) => { const p = peerById().get(id.toLowerCase()); return p ? peerName(p, p.node_id) : null; }}
                  approve={approveOwner}
                />
              </Show>
              <DeviceApprovals
                device={actions.device()}
                joinDevice={input => source.joinDevice(input)}
                remote={props.remote === true}
                mobile={isMobilePlatform()}
                showRegistered
                onRegister={async () => { const r = await act(() => source.deviceKeyRegister()); if (r.ok) setDevice(r.value); else throw r.error.message; }}
                onCancel={async () => { const r = await act(() => source.deviceKeyCancel()); if (r.ok) setDevice(r.value); else throw r.error.message; }}
              />
            </>} onForgetRemote={props.remote ? () => source.remoteAccessForget() : undefined} pairAnother={props.remote ? <PairAnotherNode
              currentNodeId={() => overview()?.node_id ?? props.ownId}
              currentHostedBy={() => props.hostedBy}
              onPreview={link => source.remoteAccessPreview(link)}
              onReplace={link => source.remoteAccessReplace(link)}
              onScan={mobileQrScannerAvailable() ? scanPairingLink : cameraQrScannerAvailable() ? scanPairingLinkWithCamera : undefined}
              mobile={isMobilePlatform()}
              phone={isMobilePlatform()}
            /> : undefined} overview={overview()} link={link()} peers={peers()} now={now()} error={props.error ?? errors.overview ?? errors.peers} onReconnect={async () => { await props.onReconnect?.(); await loadOverview(); await loadPeers(); }} />
          </Match>
          <Match when={tab() === 'devices'}>
            {/* The host offers Add a device only to a remote node (add_device::supported checks remote mode). */}
            <AddDevice api={input => source.addDevice(input)} mobile={isMobilePlatform()} local={props.remote !== true} />
            <DeviceApprovals device={actions.device()} remote={props.remote === true} mobile={isMobilePlatform()} showRegistered
              joinDevice={input => source.joinDevice(input)}
              onRegister={async () => setDevice(await source.deviceKeyRegister())}
              onCancel={async () => setDevice(await source.deviceKeyCancel())} />
          </Match>
          <Match when={tab() === 'wallet'}>
            <button type="button" class="primary soft" data-open-wallet-page onClick={() => openWallet()}>{tr('caOpenWallet')}</button>
            <WalletPanel moneyBlocked={moneyBlocked()} wallet={wallet()} error={errors.wallet} onReconnect={async () => { await props.onReconnect?.(); await loadWallet(); }} fund={props.fund?.(source, moneyBlocked)} />
          </Match>
          <Match when={tab() === 'budget'}>
            <BudgetPanel
              budget={budget()}
              error={errors.budget ?? errors.budgetPoll}
              now={now()}
              nameOf={(id, room) => (room ? rooms().find((r) => r.id.toLowerCase() === id)?.name ?? tr('caRoom') : nameOf(id))}
              actions={actions}
            />
          </Match>
          <Match when={tab() === 'frontdoor'}>
            <FrontDoorEditor source={source} now={now()} />
          </Match>
        </Switch>
      </aside>
      </PairingActivityProvider>
      <span class="sr-only" role="status" aria-live="polite" data-send-live data-send-live-seq={sendLive().seq}>{sendLive().text}</span>
      <IncomingCallAlerts view={callView()} waiting={waitingCalls()} nameOf={nameOf} />
      <div class="waiting-calls" data-waiting-calls>
        <For each={waitingCalls().map(v => `${v.peer}:${v.callId}`)}>{key => {
          onCleanup(() => waitingPanels.delete(key));
          const view = () => waitingCalls().find(v => `${v.peer}:${v.callId}` === key)!;
          return <CallPanel waiting answerBlocked={!['idle', 'ended'].includes(callView().phase) || meetingOn() || callView().pendingCount > 0 || callView().unknownCount > 0 || (!!callView().close && callView().close!.status !== 'closed')} view={view()} payment={null} approval={null} approvalOpen={false}
            spendingReady={roomCanSpend()} approveSpending={() => openCallApproval(key)}
            panelRef={el => { waitingPanels.set(key, el); }}
            blocked={moneyBlocked()} streams={{ local: null, remote: null }} nameOf={nameOf} quote={actions.callQuote}
            accept={(shown) => { if (!moneyBlocked()) void calls.acceptWaiting(key, shown); }} decline={(shown) => void calls.declineWaiting(key, shown)} ignore={() => calls.ignoreWaiting(key)} dismiss={() => calls.dismissWaiting(key)}
            hangup={() => {}} mute={() => {}} camera={() => {}} closeAgain={() => {}} endStuck={() => {}} callAgain={() => {}} />;
        }}</For>
      </div>
      <CallPanel
        panelRef={el => { callPanel = el; }}
        spendingReady={roomCanSpend()} approveSpending={openCallApproval}
        openCallSettings={() => { setTab('general'); setContextOpen(true); }}
        approvalOpen={callApproval()}
        approval={<Show when={callApproval()}>
          <div data-call-approval>
            <strong>{tr(canStillAnswer() || answerCallEnded() ? 'caApproveSpendingBeforeAnswering' : 'caApproveSpendingBeforeCalling')}</strong>
            <p class="hint">{tr(answerCallEnded() ? 'caApproveAfterEndedCall' : 'caSpendingNeedsApprovalAfterApprovalPressCallOrAccept')}</p>
            <SpendBar spend={spend()} error={errors.spend ?? errors.spendPoll} now={now()} actions={{ ...actions, moneyBlocked: callApprovalBlocked, approve: approveCallSpending }} requestBudgetMsat={callBudgetMsat()} stays={tr(answerCallEnded() ? 'caApproveAfterEndedCall' : 'caNothingIsPaidUntilYouPressCallOrAccept')} />
            <Show when={!spend()?.pending && spend()?.state !== 'pending' && spend()?.state !== 'unavailable'}>
              <Show when={callBudgetSats() !== null}>
                <label>{tr('caBudgetToRequestSats')}
                  <input type="number" min="1" max="100000" step="1" data-call-budget-sats value={callBudgetSats() ?? ''} disabled={callApproving()} onInput={e => setCallBudgetSats(e.currentTarget.value)} />
                </label>
                <p class="hint">{tr('caLargerBudgetNeedsOwner')}</p>
              </Show>
              <button type="button" class="soft" data-call-approve data-call-budget-request={callBudgetSats() !== null ? '' : undefined} disabled={callApprovalBlocked()} onClick={() => void approveCallSpending()}>{tr(callBudgetSats() !== null ? 'caAskBiggerBudget' : 'uiApproveSpending')}</button>
            </Show>
            <button type="button" class="soft" onClick={closeCallApproval}>{tr('uiClose')}</button>
          </div>
        </Show>}
        payment={<Show when={callView().callId} keyed>{(callId) =>
          <InCallPay
            callId={callId} view={callView()} nameOf={nameOf} reconciliation={lastReconciliation()}
            lightningId={peerById().get(callView().peer?.toLowerCase() ?? '')?.ln_pubkey ?? null}
            blocked={moneyBlocked() || grantUnknown() || (budget() !== null && (!budgetConfirmed() || !!errors.budgetPoll)) || !!budget()?.paused}
            pending={callView().pendingCount > 0 || (budget()?.unsettled_msat ?? 0) > 0}
            spend={spend()} spendError={errors.spend ?? errors.spendPoll} now={now()} actions={actions}
            entry={!routedCalls}
          />
        }</Show>}
        blocked={moneyBlocked()}
        routed={routedCalls}
        seal={callSeal()}
        words={callWords()}
        view={callView()}
        streams={callStreams()}
        videoCanvas={routedVideo ? callVideoCanvas() : null}
        videoStatus={routedVideo ? callVideoStatus() : null}
        nameOf={nameOf}
        quote={actions.callQuote}
        accept={(shown) => { if (!moneyBlocked()) void calls.accept(shown); }}
        decline={(shown) => void calls.decline(shown)}
        ignore={() => calls.ignore()}
        hangup={() => void calls.hangup()}
        mute={() => calls.toggleMute()}
        camera={() => void calls.toggleCamera()}
        dismiss={() => { closeCallApproval(); calls.dismiss(); }}
        closeAgain={() => void calls.closeAgain()}
        endStuck={() => void calls.endStuck()}
        callAgain={(peer, media, quote) => { if (!moneyBlocked()) void calls.place(peer, media, quote); }}
        confirmMinutes={() => { if (!moneyBlocked()) void calls.confirmMinutes(); }}
      />
      <Show when={!routedCalls}>
      <MeetingPanel
        view={meetingView()}
        streams={meetingStreams()}
        plan={meetingPlan()}
        contacts={peers().map((p) => ({ id: p.node_id.toLowerCase(), name: peerName(p, p.node_id), meetings: p.meetings === true, connected: p.connected }))}
        nodeMeets={nodeMeets()}
        ownId={ownId()}
        blocked={moneyBlocked()}
        nameOf={nameOf}
        quote={actions.callQuote}
        setPlan={setMeetingPlan}
        invite={(ids, media, quotes) => { setMeetingPlan(null); void meetings.invite(ids, media, quotes); }}
        join={(quotes) => void meetings.join(quotes)}
        decline={(quotes) => void meetings.decline(quotes)}
        leave={() => void meetings.leave()}
        mute={() => meetings.toggleMute()}
        camera={() => void meetings.toggleCamera()}
        dismiss={() => meetings.dismiss()}
      />
      </Show>
      <Show when={roomPlan() && props.active}>
        <NewRoomPanel contacts={roomContacts()} nodeRooms={nodeRooms()} onCreate={(picks) => void createRoom(picks)} onCancel={() => setRoomPlan(false)} />
      </Show>
      <Show when={props.active && walletTab()}>
        {(tab) => (
          <PairingActivityProvider onActivity={active => { walletBusy = active; }}>
          <WalletPage
            tab={tab()}
            onTab={setWalletTab}
            onClose={closeWallet}
            embedded={phoneShell()}
            wallet={wallet()}
            starter={{ nodeId: ownId(), network: overview()?.network, capabilities: overview()?.capabilities,
              api: { current: () => source.starterCurrent(ownId()), request: id => source.starterRequest(ownId(), id) } }}
            pendingResult={<Reconcile actions={actions} hasPending={(budget()?.unsettled_msat ?? 0) > 0} />}
            walletError={errors.wallet}
            moneyBlocked={moneyBlocked()}
            spend={spend()}
            spendGate={<SpendBar spend={spend()} error={errors.spend ?? errors.spendPoll} now={now()} actions={actions} />}
            now={now()}
            ownId={ownId()}
            histories={[...peers().map((p) => p.node_id.toLowerCase()), ...rooms().map((r) => r.id.toLowerCase())]}
            historiesPending={!peersLoaded() && !errors.peers}
            historiesIncomplete={!!errors.peers}
            threadMessages={Object.values(threads.t).flat()}
            nameOf={(id) => rooms().find((r) => r.id.toLowerCase() === id.toLowerCase())?.name ?? channelName(id)}
            actions={walletActions}
            reads={{ fundingAddress: () => source.fundingAddress(), invoiceStatus: (b) => source.invoiceStatus(b), messages: (id) => source.messages(id) }}
            onRefresh={() => void loadWallet()}
            onReconnect={async () => { await props.onReconnect?.(); await loadWallet(); }}
            custody={overview()?.custody_mode}
          />
          </PairingActivityProvider>
        )}
      </Show>
    </div>
  );
}

/** Standard base64 of a file's bytes, for the host's `file_send`. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The node's own STUN responder, as `/status` reports it. */
type OwnStun = { port: number; url: string | null };

/**
 * The owner's STUN server for calls. With none, calls use
 * host candidates only and connect on the same network. A STUN server learns
 * your public address each time you place or accept a call. When the node
 * reports its own responder or a configured server, calls use that by default.
 */
function CallSettings(props: { own: OwnStun | null }) {
  const [draft, setDraft] = createSignal(stunPref());
  const [error, setError] = createSignal<string | null>(null);
  const ownUrl = () => {
    const url = props.own?.url ?? '';
    return stunServer(url).length ? url : null;
  };
  const save = () => {
    const v = draft().trim();
    if (v && stunServer(v).length === 0) {
      setError(tr('extraUseStunHostOrStunHostPortTURN'));
      return;
    }
    setError(null);
    // Saving an empty field returns to the node's reported default.
    setStunPref(v);
  };
  /** What calls actually use, with the status source kept for honest labels. */
  const using = () => effectiveStun();
  return (
    <section data-call-settings>
      <h3>{tr('extraCalls')}</h3>
      <p class="hint" data-stun-note data-stun-using={using() ? effectiveStunSource() === 'own' ? 'own' : stunPref() ? 'other' : 'configured' : stunOff() ? 'off' : 'none'}>
        {using()
          ? effectiveStunSource() === 'own'
            ? tr('extraCallsAskYourOwnNodeForYourPublic', using(), stunPref() ? '' : tr('extraThisIsTheDefault'))
            : chosenStunLabel()
          : stunOff()
            ? tr('extraSTUNIsTurnedOffCallsContactNoThird')
            : tr('extraNoSTUNServerCallsContactNoThirdParty')}
      </p>
      <p class="hint" data-call-relay-limit>{tr('extraThereIsNoRelayYetSomeNetworksStrict')}</p>
      <Show when={ownUrl() && using() !== ownUrl()}>
        <div class="row">
          <button type="button" class="soft" data-stun-own onClick={() => { setDraft(ownUrl()!); setError(null); }}>
            {tr('extraUseMyNode')}{ownUrl()})
          </button>
        </div>
        <Show when={draft().trim() === ownUrl()}>
          <p class="hint" data-stun-own-confirm>{tr('extraPressSaveToUseYourNodeItThen')}</p>
        </Show>
      </Show>
      <Show when={props.own && !ownUrl()}>
        <p class="hint" data-stun-own-hint>
          {tr('extraYourNodeAnswersSTUNOnUDPPortBut', props.own!.port, props.own!.port)}
        </p>
      </Show>
      <div class="row">
        <input data-stun-input placeholder="stun:host:3478" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} aria-label={tr('extraSTUNServerForCallsOptional')} />
        <button type="button" class="soft" data-stun-save onClick={save}>{tr('extraSave')}</button>
        <Show when={using()}>
          <button type="button" class="soft" data-stun-clear onClick={() => { setDraft(''); setStunOff(); setError(null); }}>{tr('extraTurnOff')}</button>
        </Show>
      </div>
      <Show when={error()}>
        <p class="hint" role="alert" data-stun-error>{error()}</p>
      </Show>
    </section>
  );
}

function SettingsDisplay(props: { own: OwnStun | null }) {
  const themes: { id: ThemePref; label: string }[] = [
    { id: 'system', get label() { return tr('uiSystem'); } },
    { id: 'light', get label() { return tr('uiLight'); } },
    { id: 'dark', get label() { return tr('uiDark'); } },
  ];
  const denoms: { id: Denom; label: string }[] = [
    { id: 'sats', get label() { return tr('uiSats'); } },
    { id: 'btc', get label() { return tr('uiBTC'); } },
  ];
  return (
    <div class="panel settings-display" data-panel="display">
      <h2>{tr('uiDisplay')}</h2>
      <h3>{tr('uiTheme')}</h3>
      <div class="modes soft" role="radiogroup" aria-label={tr('uiTheme')} data-theme-toggle>
        <For each={themes}>
          {(t) => (
            <button
              type="button"
              role="radio"
              aria-checked={themePref() === t.id}
              data-theme-option={t.id}
              onClick={() => setThemePref(t.id)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>
      <h3>{tr('language')}</h3>
      <select data-language-pref aria-label={tr('language')} value={languagePref()} onChange={e => setLanguagePref(e.currentTarget.value as LanguagePref)}>
        <option value="system">{tr('uiSystem')}</option>
        <option value="da">Dansk</option>
        <option value="en">English</option>
      </select>
      <h3>{tr('uiAmounts')}</h3>
      <div class="modes soft" role="radiogroup" aria-label={tr('uiDenomination')} data-denom-toggle>
        <For each={denoms}>
          {(d) => (
            <button
              type="button"
              role="radio"
              aria-checked={denom() === d.id}
              data-denom-option={d.id}
              onClick={() => setDenom(d.id)}
            >
              {d.label}
            </button>
          )}
        </For>
      </div>
      <p class="hint">{tr('uiBalancesAndCostsUseThisUnitEverywhereYour')}</p>
      <CallSettings own={props.own} />
    </div>
  );
}

// ---- rail -----------------------------------------------------------------

function Rail(props: {
  phone?: boolean;
  hidden?: boolean;
  listRef?: (el: HTMLElement) => void;
  callView: CallView;
  onReturnToCall: () => void;
  pill: ReturnType<typeof nodePill>;
  active: boolean;
  sample: boolean;
  peers: Peer[];
  peersPending?: boolean;
  /** The main pane is already saying the contacts could not be read. */
  peersErrorInMain?: boolean;
  /** The node has answered, so what it does not offer is known. */
  nodeKnown?: boolean;
  peersError?: string;
  onReconnect?: () => Promise<void>;
  rooms: Room[];
  /** Our node checks room bindings: bound rooms and "New room" replace the coming-soon line. */
  nodeRooms: boolean;
  boundRooms: LocalRoom[];
  boundName: (id: string) => string;
  onNewRoom: () => void;
  /** First contacts admitted by payment this session. Not contacts, and not added. */
  knocks: string[];
  nameOf: (id: string) => string;
  unread: Unread;
  openKey: string | null;
  ownId: string | null;
  onOpen: (t: TrackRef) => void;
  /** The status pill opens Settings → Node. */
  onNode?: () => void;
  onProfile: () => void;
  onWallet: () => void;
  balanceMsat: number | null;
  /** Owner approvals this device may give, waiting now (0 hides the badge and the menu entry). */
  approvalsWaiting?: number;
  onApprovals?: () => void;
  /** Under the full-screen Wallet: out of reach. */
  behind: boolean;
}) {
  // The avatar menu: Wallet, or Profile and settings.
  const [menuOpen, setMenuOpen] = createSignal(false);
  let avatar: HTMLButtonElement | undefined;
  // Focus goes back to the avatar first, so closing what opens returns there.
  const choose = (open: () => void) => {
    setMenuOpen(false);
    avatar?.focus();
    open();
  };
  createEffect(() => {
    if (!menuOpen()) return;
    // Escape closes and puts focus back on You; opening moves focus to the first item.
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-avatar-menu] [role="menuitem"]')?.focus());
    onCleanup(onEscape(() => { setMenuOpen(false); avatar?.focus(); }));
  });
  const item = (t: TrackRef, name: string | (() => string), meta?: JSX.Element) => {
    const key = trackKey(t);
    return (
      <button
        class="track-link"
        data-track={key}
        aria-current={props.openKey === key}
        disabled={!props.active}
        onClick={() => props.onOpen(t)}
      >
        <span class="name">{typeof name === 'function' ? name() : name}</span>
        <Show when={(props.unread[key] ?? 0) > 0} fallback={meta}>
          <span class="badge" aria-label={tr('uiNew', props.unread[key])}>{props.unread[key]}</span>
        </Show>
      </button>
    );
  };

  return (
    <nav class={props.phone ? 'phone-chat-list' : 'rail'} hidden={props.hidden} ref={props.listRef} tabindex={props.phone ? -1 : undefined} data-phone-list={props.phone ? '' : undefined} classList={{ 'rail-setup': !props.active }} aria-label={tr(props.phone ? 'phoneChats' : 'uiTracks')} inert={props.behind}>
      <Show when={props.phone}><h1>{tr('phoneChats')}</h1></Show>
      <Show when={!props.phone}>
      <div class="mark">
        Bit<span>Sov</span>
      </div>
      <OnCallPill view={props.callView} onReturn={props.onReturnToCall} />
      <button class="node-pill" title={tr('uiOpenNodeSettings', props.pill.text)} aria-haspopup="dialog" data-pill={props.pill.tone} onClick={() => (props.onNode ?? props.onProfile)()} disabled={!props.active}>
        <span class={`dot ${props.pill.tone}`} classList={{ live: props.pill.live }} />
        <span class="what">{props.pill.text}</span>
        <Show when={props.active}>
          {/* Contact counts are in node settings; they are not node-readiness steps. */}
          {/* Says "this opens something" without adding words to the status. */}
          <svg class="pill-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </Show>
      </button>

      </Show>
      <div class="track-group">
        <h2>{tr('uiContacts')}</h2>
        <Show when={props.active} fallback={<p class="track-empty">{tr('uiAvailableAfterSetup')}</p>}>
          <Show when={props.peersError && !props.peersErrorInMain}>
            <SoftError message={props.peersError!} summary={tr('caCouldNotLoadContacts')} onReconnect={props.onReconnect} />
          </Show>
          <For each={props.peers} fallback={
            <Show when={!props.peersPending && !props.peersError} fallback={
              <Show when={props.peersPending && !props.peersError}><DelayedSpinner /></Show>
            }><p class="track-empty">{tr('uiNoContactsYet')}</p></Show>
          }>
            {(p) =>
              item({ kind: 'peer', id: p.node_id.toLowerCase() }, () => peerName(p, p.node_id), <span class={`dot ${p.connected ? 'ok' : ''}`} title={p.connected ? tr('uiConnected') : tr('uiOffline')} />)
            }
          </For>
        </Show>
      </div>

      <div class="track-group" data-rooms-soon={props.active && props.nodeRooms ? undefined : ''}>
        <h2>{tr('uiRooms')}</h2>
        <Show
          when={props.active && props.nodeRooms}
          fallback={
            <p class="track-empty" data-rooms-coming-soon>
              {!props.active ? tr('uiRoomAvailabilityIsCheckedAfterSetup') : props.nodeKnown === false ? tr('caRoomsAfterBoxAnswers') : tr('uiThisNodeDoesNotSupportRoomsYet')}
            </p>
          }
        >
          <For each={props.boundRooms}>
            {(r) => item({ kind: 'bound', id: r.id }, props.boundName(r.id), <span class="meta">{r.roster.length}</span>)}
          </For>
          <button class="track-link new-track" data-room-new onClick={() => props.onNewRoom()}>
            {tr('uiNewRoom')}
          </button>
        </Show>
        <Show when={showLegacyRoomsUi && props.active && props.rooms.length > 0}>
          <For each={props.rooms}>
            {(r) => item({ kind: 'room', id: r.id.toLowerCase() }, r.name)}
          </For>
        </Show>
      </div>

      <Show when={props.active && props.knocks.length > 0}>
        <div class="track-group" data-door-group>
          <h2>{tr('uiAtYourDoor')}</h2>
          <For each={props.knocks}>
            {(id) => (
              <button
                class="track-link knock"
                data-door-track={`peer:${id}`}
                aria-current={props.openKey === `peer:${id}`}
                title={tr('uiPaidYourDoorPriceNotAContact')}
                onClick={() => props.onOpen({ kind: 'peer', id })}
              >
                <span class="name id">{shortId(id)}</span>
                <Show when={(props.unread[`peer:${id}`] ?? 0) > 0} fallback={<span class="meta">{tr('uiPaid')}</span>}>
                  <span class="badge">{props.unread[`peer:${id}`]}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="track-group" data-assistants>
        <h2>{tr('uiAssistants')}</h2>
        <Show when={props.active}>
          <For each={Object.entries(ASSISTANTS) as [AssistantId, typeof ASSISTANTS[AssistantId]][]}>
            {([id, assistant]) => item({ kind: 'assistant', id }, assistant.name, <span class="meta">{tr('uiReadOnly')}</span>)}
          </For>
        </Show>
        <Show when={props.active}>{item({ kind: 'ai' }, () => tr('uiAskYourNode'), <span class="meta">{tr('uiLocal')}</span>)}</Show>
      </div>

      <div class="track-group">
        <h2>{tr('uiBrowse')}</h2>
        <Show when={props.active}>
          <button
            class="track-link"
            data-track="discover"
            aria-current={props.openKey === 'discover'}
            onClick={() => props.onOpen({ kind: 'discover' })}
          >
            <span class="name">{tr('uiProfiles')}</span>
            <span class="meta">{tr('uiPasteACard')}</span>
          </button>
          <button
            class="track-link"
            data-track="porch"
            aria-current={props.openKey === 'porch'}
            onClick={() => props.onOpen({ kind: 'porch' })}
          >
            <span class="name">{tr('uiPorch')}</span>
            <span class="meta">{tr('uiCardsPagesPaid')}</span>
          </button>
        </Show>
      </div>

      <div class="rail-foot">
        <Show when={props.active}>
          <button class="track-link new-track" data-track="new" aria-label={tr('uiNew58')} aria-current={props.openKey === 'new'} onClick={() => props.onOpen({ kind: 'new' })}>
            {tr('uiNew59')}
          </button>
        </Show>
        <Show when={props.sample}>
          <span class="mode-tag" data-sample>{tr('uiSampleDataNoNode')}</span>
        </Show>
        <Show when={!props.phone}><div class="avatar-menu-wrap">
          <Show when={menuOpen()}>
            <div class="avatar-scrim" onClick={() => setMenuOpen(false)} />
            <div class="avatar-menu" role="menu" aria-label={tr('uiYou')} data-avatar-menu>
              <button type="button" role="menuitem" class="avatar-menu-item wallet" data-open-wallet onClick={() => choose(props.onWallet)}>
                <span class="name">{tr('uiWallet')}</span>
                <Show when={props.balanceMsat !== null}>
                  <span class="meta sats" data-avatar-balance>{fmtAmount(props.balanceMsat!, true)}</span>
                </Show>
              </button>
              <Show when={(props.approvalsWaiting ?? 0) > 0 && props.onApprovals}>
                <button type="button" role="menuitem" class="avatar-menu-item" data-open-approvals onClick={() => choose(props.onApprovals!)}>
                  <span class="name">{tr('uiApprovalsWaiting')}</span>
                  <span class="meta" data-approvals-count>{props.approvalsWaiting}</span>
                </button>
              </Show>
              <button type="button" role="menuitem" class="avatar-menu-item" data-open-settings onClick={() => choose(props.onProfile)}>
                <span class="name">{tr('uiProfileAndSettings')}</span>
              </button>
            </div>
          </Show>
          <button
            ref={avatar}
            type="button"
            class="profile-avatar"
            data-profile
            disabled={!props.active}
            aria-label={tr('uiYouWalletProfileAndSettings')}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            title={tr('uiWalletProfileAndSettings')}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span class="avatar-mark" aria-hidden="true">BS</span>
            <span class="avatar-label">{tr('uiYou')}</span>
            <Show when={(props.approvalsWaiting ?? 0) > 0}>
              <span class="approvals-badge" data-approvals-badge aria-label={tr('uiApprovalWaiting', props.approvalsWaiting ?? 0, props.approvalsWaiting === 1 ? '' : tr('pluralApprovalSuffix'))}>{props.approvalsWaiting}</span>
            </Show>
          </button>
        </div></Show>
      </div>
    </nav>
  );
}

// ---- tracks ---------------------------------------------------------------

function TrackHead(props: {
  title: string;
  sub?: JSX.Element;
  extra?: JSX.Element;
  onContext: () => void;
  onContact?: () => void;
  verified?: boolean;
  keyChanged?: boolean;
}) {
  return (
    <header class="track-head">
      <Show
        when={props.onContact}
        fallback={<h1>{props.title}</h1>}
      >
        <button
          type="button"
          class="track-title-btn"
          data-contact-open
          onClick={() => props.onContact?.()}
          aria-label={props.keyChanged
            ? `${tr('uiContact', props.title)}, ${tr('uiKeyChanged')}`
            : props.verified
              ? `${tr('uiContact', props.title)}, ${tr('uiVerified')}`
              : tr('uiContact', props.title)}
        >
          <h1>{props.title}</h1>
          <Show when={props.keyChanged}>
            <span class="contact-pill warn" data-contact-pill="key-changed">{tr('uiKeyChanged')}</span>
          </Show>
          <Show when={props.verified && !props.keyChanged}>
            <span class="contact-pill ok" data-contact-pill="verified">{tr('uiVerified')}</span>
          </Show>
        </button>
      </Show>
      <div class="sub">{props.sub}</div>
      {props.extra}
      <button
        type="button"
        class="quiet context-toggle icon-btn"
        onClick={() => props.onContext()}
        title={tr('uiSettings')}
        aria-label={tr('uiSettings')}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="sr-only">{tr('uiSettings')}</span>
      </button>
    </header>
  );
}

function Bolt() {
  return (
    <svg class="bolt" viewBox="0 0 9 12" aria-hidden="true">
      <path d="M5.5 0 0 7h3.5L3 12l6-7.5H5.2z" />
    </svg>
  );
}

function Conversation(props: {
  nodeRooms: boolean;
  moneyBlocked: boolean;
  track: TrackRef;
  name: string;
  peer: Peer | undefined;
  /** K1: the verified card this conversation was opened from, if any. */
  introduced?: Introduction;
  /** Front-door Knock marker — not an Introduction. */
  doorstep?: Doorstep;
  members: string[] | null;
  messages: Message[];
  artifacts: Artifact[];
  fresh: Record<string, true>;
  seenEntrances: Set<string>;
  deliveries: Deliveries;
  paid: Record<string, number>;
  allowances: Record<string, { total_msat: number; max_routing_fee_msat: number; fee_paid_msat?: number; readmission_msat?: number }>;
  ownId: string;
  /** This node's Bitcoin network, when the host knows it. */
  homeNetwork: string | null;
  nameOf: (id: string) => string;
  quote: PriceQuote | null;
  quoteError?: string;
  refreshPrice: () => void;
  roomQuote: RoomQuote | null;
  filePrice: PaymentQuote | null;
  spend: SpendView | null;
  spendError: string | undefined;
  budget: BudgetView | null;
  budgetError: string | undefined;
  approvalError?: string;
  budgetStale: boolean;
  actions: Actions;
  now: number;
  error: string | undefined;
  /** This chat's current history read: only `ok` may say it is empty. */
  read: ThreadRead;
  onReconnect: () => void;
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onContext: () => void;
}) {
  /** We have a budget line for them: we paid them before. The only contact status said in an empty chat. */
  const knownContact = () => {
    const t = props.track;
    return t.kind === 'peer' && (props.budget?.rows ?? []).some((r) => !r.room && r.target.toLowerCase() === t.id.toLowerCase());
  };
  let stream: HTMLDivElement | undefined;
  // A request card's Pay: hands the invoice to the composer's Pay review. Never pays.
  const [payRequest, setPayRequest] = createSignal<{ seq: number; bolt11: string } | null>(null);
  let payRequestSeq = 0;
  const [contactOpen, setContactOpen] = createSignal(false);
  createEffect(() => {
    if (props.track.kind === 'peer') reconcileKeyChange(props.track.id);
  });
  const peerVerify = () => {
    if (props.track.kind !== 'peer') return { verified: false, keyChanged: false };
    const st = verifyState(props.track.id);
    return { verified: st === 'verified', keyChanged: st === 'key-changed' };
  };
  // Invoice payments made in this thread, by payment hash: a card they paid shows it.
  // Only this session's records; after a restart the node's duplicate refusal remains.
  const paidInvoices = createMemo(() => {
    const out = new Map<string, PaymentStatus>();
    for (const a of props.artifacts) {
      if (a.type !== 'payment' || !a.invoice) continue;
      const hash = invoicePaymentHash(a.invoice);
      if (hash && out.get(hash) !== 'settled') out.set(hash, a.receipt.status);
    }
    return out;
  });
  const cost = () =>
    costToSend(props.track, props.quote, {
      name: props.track.kind === 'peer' ? props.name : undefined,
      room: props.roomQuote,
      nowMs: props.now,
    });
  // Protocol payloads belong to their own views, not the chat stream (a call's minute blocks included).
  const items = createMemo(() => streamItems(props.messages.filter((m) => !isCallTrafficKind(m.kind) && !isPorchKind(m.kind) && !(props.track.kind === 'peer' && roomOf(m, props.ownId))), props.artifacts));
  // Solid's For keys by identity. Primitive ids keep rows mounted when reads replace objects.
  const keyedItems = createMemo(() => new Map(items().map((item) => [
    item.type === 'message' ? `message:${item.message.id}` : `artifact:${item.artifact.id}`, item,
  ])));

  createEffect(
    on(
      () => props.messages.length + props.artifacts.length,
      () => queueMicrotask(() => stream?.scrollTo?.({ top: stream.scrollHeight })),
    ),
  );

  const sub = () =>
    props.track.kind === 'peer' ? (
      <span class="row" style={{ gap: 'var(--s-2)' }}>
        <span class={`dot ${props.peer?.connected ? 'ok' : ''}`} />
        <span class="id" title={(props.track as { id: string }).id}>{shortId((props.track as { id: string }).id)}</span>
      </span>
    ) : (
      <span class="id">
        {props.members === null ? tr('chatReadingMembers') : tr('chatMembers', props.members.length, tr(props.nodeRooms ? 'chatLegacyRoom' : 'chatRoomsUnavailable'))}
      </span>
    );

  return (
    <>
      <TrackHead
        title={props.name}
        sub={sub()}
        extra={
          <Show when={props.track.kind === 'peer' && props.peer ? props.track.id : null}>
            {(peer) => <CallButtons peer={peer()} name={props.name} blocked={props.moneyBlocked} actions={props.actions} offline={props.peer?.connected === false} />}
          </Show>
        }
        onContext={props.onContext}
        onContact={props.track.kind === 'peer' && props.peer ? () => setContactOpen(true) : undefined}
        verified={peerVerify().verified}
        keyChanged={peerVerify().keyChanged}
      />
      <Show when={props.track.kind === 'peer' && props.peer ? props.peer : null}>
        {(p) => (
          <ContactPanel
            open={contactOpen()}
            peer={p()}
            doorName={null}
            onClose={() => setContactOpen(false)}
          />
        )}
      </Show>
      <StreamFrame>
      <div class="stream" ref={stream} data-stream>
        <div class="chat-column">
        <Show when={props.introduced}>
          {(c) => (
            <p class="day" data-introduced={c().node_id}>
              {tr('chatIntroduction', props.name, fmtAmount(allIn(c().admission_msat)), feeCeiling(routingFee(c().admission_msat)), fmtAmount(allIn(c().message_msat)), feeCeiling(routingFee(c().message_msat)))}
            </p>
          )}
        </Show>
        <Show when={props.doorstep}>
          {(c) => (
            <p class="day" data-doorstep={c().node_id}>
              {tr('chatDoorstep', props.name, fmtAmount(allIn(c().admission_msat)), fmtAmount(allIn(c().message_msat)))}
            </p>
          )}
        </Show>
        <Show when={props.track.kind === 'room'}>
          <p class="day" data-room-day-notice>
            {tr(props.nodeRooms ? 'chatLegacyNotice' : 'chatUnsupportedRoom')} {tr('chatLegacyMembers')}
          </p>
        </Show>
        <For
          each={[...keyedItems().keys()]}
          fallback={
            // Unknown stays unknown: while the history is being read nothing is said, and a failed
            // read shows only its error (below). Only a read that came back empty says "no messages".
            <Show when={props.read === 'ok'} fallback={<Switch>
              <Match when={props.read === 'pending'}><div class="empty-track" data-thread-loading><DelayedSpinner /></div></Match>
              {/* Refused while the node is getting ready: no error text comes with it, and a blank chat says nothing. */}
              <Match when={props.read === 'failed' && !props.error}><p class="hint" role="status" data-thread-not-read>{tr('caChatNotReadYet')}</p></Match>
            </Switch>}>
              <div class="empty-track" data-thread-empty={props.track.kind === 'room' ? 'room' : knownContact() ? 'known' : 'unknown'}>
                <h2>{tr('chatEmpty')}</h2>
                <Show when={props.track.kind === 'room'}>
                  <p class="hint">
                    {tr(props.nodeRooms ? 'chatLegacyNotice' : 'chatUnsupportedRoom')} {tr('chatLegacyPayment')}
                  </p>
                </Show>
                {/* Only a budget line (we have paid them before) is said; whether they would need a first
                    contact is the node's to say, on the door card, never guessed here. */}
                <Show when={props.track.kind === 'peer' && knownContact()}>
                  <p class="hint">{tr('chatEachMessage', props.name)}</p>
                </Show>
              </div>
            </Show>
          }
        >
          {(key, i) => {
            const item = () => keyedItems().get(key)!;
            const message = () => { const row = item(); return row.type === 'message' ? row.message : null; };
            const artifact = () => { const row = item(); return row.type === 'artifact' ? row.artifact : null; };
            const prev = () => items()[i() - 1];
            const newDay = () => !prev() || day(prev()!.at) !== day(item().at);
            return (
              <>
                <Show when={newDay()}>
                  <p class="day">{day(item().at)}</p>
                </Show>
                <Switch>
                  <Match when={message()}>
                    {(m) => (
                      <MessageView
                        m={m()}
                        out={isOutgoing(m(), props.ownId)}
                        room={props.track.kind === 'room'}
                        fresh={!!props.fresh[m().id]}
                        seenEntrances={props.seenEntrances}
                        delivery={props.deliveries[m().id]}
                        paid={props.paid[m().id]}
                        allowance={props.allowances[m().id]}
                        nameOf={props.nameOf}
                        now={props.now}
                        homeNetwork={props.homeNetwork}
                        moneyBlocked={props.moneyBlocked}
                        onPay={props.track.kind === 'peer' ? (bolt11) => setPayRequest({ seq: ++payRequestSeq, bolt11 }) : undefined}
                        readInvoice={props.track.kind === 'peer' ? props.actions.readInvoice : undefined}
                        paidInvoices={paidInvoices()}
                        voiceUrl={props.actions.voiceUrl}
                        fileFetch={props.actions.fileFetch}
                        fileSave={props.actions.fileSave}
                      />
                    )}
                  </Match>
                  <Match when={artifact()}>
                    {(a) => <ArtifactView callActions={props.actions} moneyBlocked={props.moneyBlocked} a={a()} nameOf={props.nameOf} offlineOf={(id) => props.peer?.node_id === id && props.peer.connected === false} delivery={a().type === 'file' ? props.deliveries[(a() as { receipt: { message_id: string } }).receipt.message_id] : undefined} onRetry={(id, approved) => props.actions.retryDelivery(props.track, id, approved)} onStop={(pendingId) => props.actions.stopRetrying(props.track, pendingId)} onRestore={(id) => props.actions.restoreUnsent(props.track, id)} onDiscard={(id) => props.actions.discardUnsent(props.track, id)} />}
                  </Match>
                </Switch>
              </>
            );
          }}
        </For>
        <Show when={props.error}>
          <SoftError message={props.error!} onReconnect={props.onReconnect} />
        </Show>
        </div>
      </div>
      </StreamFrame>

      <Composer
        admissionResume={props.artifacts.flatMap((a) => a.type === 'restored' ? [a.op] : a.type === 'failed' && !a.confirmedBy && a.op ? [a.op] : [])
          .find((op) => op.state === 'admission_resumable' && props.track.kind === 'peer' && op.peer === props.track.id)}
        ownId={props.ownId}
        moneyBlocked={props.moneyBlocked}
        track={props.track}
        name={props.name}
        cost={cost()}
        quote={props.quote}
        quoteError={props.quoteError}
        refreshPrice={props.refreshPrice}
        roomQuote={props.roomQuote}
        filePrice={props.filePrice}
        // Admission is per direction: messages they sent us do not open their
        // door for ours. A first contact is our first outgoing message.
        firstContact={props.track.kind === 'peer' && !props.messages.some((m) => isOutgoing(m, props.ownId))}
        spend={props.spend}
        spendError={props.spendError}
        budget={props.budget}
        budgetError={props.budgetError}
        approvalError={props.approvalError}
        budgetStale={props.budgetStale}
        actions={props.actions}
        nameOf={props.nameOf}
        now={props.now}
        prefill={props.prefill}
        onPrefillUsed={props.onPrefillUsed}
        payRequest={payRequest()}
        hasPending={
          props.artifacts.some(
            (a) =>
              a.type === 'undelivered' ||
              (a.type === 'restored' && ['dispatching', 'unknown', 'paid', 'paid_undelivered'].includes(a.op.state)) ||
              (a.type === 'failed' &&
                ['spend_unknown', 'payment_unknown', 'failed_paid', 'payment_settled_undelivered'].includes(a.error.code))
          ) ||
          Boolean(props.spend?.pending) ||
          Boolean(props.budget && props.budget.unsettled_msat > 0)
        }
      />
    </>
  );
}

/**
 * Invoice payee naming is intentionally conservative: this helper does not
 * consume the node-reported GET /peers ln_pubkey mapping used by in-call Pay.
 * Invoice review therefore displays the decoded Lightning key, not a contact name.
 */
const contactLightningId = (_peer: string): string | null => null;

/**
 * Payee line: never asserts that the chat contact owns the invoice. An
 * invoice's payee is only ever the host's decode (`InvoiceAmount.payee`).
 */
function PayeeLine(props: { payee: string; peer: string; name: string }) {
  const v = () => payeeView(props.payee, contactLightningId(props.peer), props.name);
  return (
    <span class="payee" classList={{ unverified: !v().verified }} data-payee={v().verified ? 'verified' : 'unverified'} title={props.payee}>
      {v().verified ? tr('uiPaysSLightningNode', v().text) : tr('uiPays', v().text)}
    </span>
  );
}

/**
 * A received message whose whole body is a payable invoice. Display only:
 * Pay opens the composer's amount-first review, and only its confirm pays.
 */
type PaymentStatus = Extract<Artifact, { type: 'payment' }>['receipt']['status'];

function RequestCard(props: { inv: InvoiceAmount; peer: string; name: string; blocked: boolean; paid?: PaymentStatus; onPay: (bolt11: string) => void }) {
  // A failed attempt may be tried again; a settled or unresolved one may not.
  const done = () => (props.paid && props.paid !== 'failed' ? props.paid : null);
  const purpose = () => (props.inv.description === null ? null : cleanPurpose(props.inv.description));
  return (
    <div class="request-card" data-request-card data-request-msat={props.inv.amount_msat} data-request-status={done() ?? 'open'}>
      <span class="kind">{tr('chatPaymentRequestFrom')} {props.name}</span>
      <span class="sats big">{sats(props.inv.amount_msat, true)} <span class="unit">{satUnit(props.inv.amount_msat)}</span></span>
      <Show when={purpose()} fallback={<span class="hint">{tr('chatNoPurposeGiven')}</span>}>
        <span class="purpose" data-request-purpose>{tr('chatFor')} {purpose()}</span>
      </Show>
      <PayeeLine payee={props.inv.payee} peer={props.peer} name={props.name} />
      <Show
        when={done()}
        fallback={
          <>
            <span class="hint">{tr('chatExpiresAt')} {clock(props.inv.expires_at_ms)}{tr('chatNothingIsPaidUntilYouConfirm')}</span>
            <button type="button" class="primary money" data-request-pay disabled={props.blocked} onClick={() => props.onPay(props.inv.bolt11)}>
              {tr('uiPay')}
            </button>
          </>
        }
      >
        {(status) => (
          <span class="request-paid" data-request-paid={status()}>
            {status() === 'settled' ? tr('chatPaidYouPaidThisInvoice') : tr('chatPaymentInProgressCheckItsReceiptBelowBefore')}
          </span>
        )}
      </Show>
    </div>
  );
}

function MessageView(props: {
  m: Message;
  out: boolean;
  room: boolean;
  fresh: boolean;
  seenEntrances: Set<string>;
  delivery: Delivery | undefined;
  paid: number | undefined;
  allowance?: { total_msat: number; max_routing_fee_msat: number; fee_paid_msat?: number; readmission_msat?: number };
  nameOf: (id: string) => string;
  now?: number;
  homeNetwork?: string | null;
  moneyBlocked?: boolean;
  /** Present in a peer thread: a received invoice may be paid from its card. */
  onPay?: (bolt11: string) => void;
  /** The host's decode; a card shows only what it returns. */
  readInvoice?: (bolt11: string) => Promise<Outcome<InvoiceAmount>>;
  /** This thread's invoice payments by payment hash. */
  paidInvoices?: Map<string, PaymentStatus>;
  voiceUrl?: (messageId: string) => Promise<string>;
  fileFetch?: (messageId: string) => Promise<VoiceBlob>;
  fileSave?: (messageId: string) => Promise<FileSaveResult>;
}) {
  const entrance = createMessageEntrance(props.m.id, props.fresh, props.seenEntrances);
  const amount = () => (props.paid ?? props.m.payment_amount_msat ?? 0) + (props.allowance?.readmission_msat ?? 0);
  const paidLabel = () => paidAmount(amount(), props.allowance?.fee_paid_msat);
  // Only a received chat message in a peer thread can be a request card.
  const request = createMemo(() =>
    props.out || props.room || !props.onPay || props.m.kind === 200
      ? null
      : readChatInvoice(props.m.plaintext, props.now ?? Date.now(), props.homeNetwork ?? null),
  );
  // The shape filter passed: ask the host. Nothing is shown as payable until it answers.
  const [hostRead] = createResource(
    () => {
      const r = request();
      return r?.ok && props.readInvoice ? r.invoice.bolt11 : null;
    },
    (bolt11) => props.readInvoice!(bolt11),
  );
  const hostVerdict = (): { ok: true; inv: InvoiceAmount } | { ok: false; reason: NotPayable } | null => {
    const r = request();
    if (!r?.ok) return null;
    const read = hostRead.loading ? undefined : hostRead();
    if (read === undefined) return null;
    if (!read.ok) return { ok: false, reason: 'invalid' };
    const problem = hostReadProblem(read.value, props.now ?? Date.now(), props.homeNetwork ?? null);
    return problem ? { ok: false, reason: problem } : { ok: true, inv: read.value };
  };
  const payable = () => {
    const v = hostVerdict();
    return v?.ok ? v.inv : null;
  };
  const notPayable = () => {
    const r = request();
    if (r && !r.ok) return r.reason;
    const v = hostVerdict();
    return v && !v.ok ? v.reason : null;
  };
  return (
    <article class={`msg ${props.out ? 'out' : 'in'}`} classList={{ fresh: entrance.fresh() }} onAnimationEnd={entrance.finish} data-message={props.m.id}>
      <Show when={!props.out && props.room}>
        <span class="who">{props.nameOf(props.m.sender)}</span>
      </Show>
      <Show
        when={payable()}
        fallback={
          <div class="bubble" classList={{ file: props.m.kind === 200 }} data-kind={props.m.kind}>
            <Show when={props.m.kind === 200} fallback={props.m.plaintext ?? tr('extraEncryptedContentNotAvailableOnThisDevice')}>
              <Show
                when={!props.out && props.fileFetch && props.fileSave}
                fallback={
                  <Show when={props.voiceUrl && isVoiceNote(props.m.kind, props.m.plaintext)} fallback={<span class="file-name">{fileNameOf(props.m.plaintext) ?? tr('extraFile')}</span>}>
                    <VoiceNote id={props.m.id} name={fileNameOf(props.m.plaintext) ?? tr('fileNoun')} load={props.voiceUrl!} />
                  </Show>
                }
              >
                <ReceivedFile
                  id={props.m.id}
                  name={fileNameOf(props.m.plaintext) ?? tr('fileNoun')}
                  voice={isVoiceNote(props.m.kind, props.m.plaintext) ? props.voiceUrl : undefined}
                  loadFile={props.fileFetch!}
                  save={props.fileSave!}
                />
              </Show>
            </Show>
          </div>
        }
      >
        {(inv) => <RequestCard inv={inv()} peer={props.m.sender} name={props.nameOf(props.m.sender)} blocked={!!props.moneyBlocked} paid={props.paidInvoices?.get(inv().payment_hash)} onPay={props.onPay!} />}
      </Show>
      <Show when={notPayable()}>
        {(reason) => <p class="hint request-note" data-request-plain={reason()}>{NOT_PAYABLE_NOTE[reason()]}</p>}
      </Show>
      <div class="stamp">
        <Show when={props.paid !== undefined || props.m.payment_amount_msat != null}>
          <span
            class="sats-meta"
            title={props.out ? paidLabel() : tr('extraToYou', fmtAmount(amount()))}
          >
            <Bolt />
            <span class={props.out ? "money-text" : "sats"}>{props.out ? paidLabel() : fmtAmount(amount(), true)}</span>
          </span>
          <Show when={props.out && props.allowance?.readmission_msat}>
            <span data-readmission-paid>{tr('extraInclAdmissionAgain')} {sats(props.allowance!.readmission_msat!)} {satUnit(props.allowance!.readmission_msat!)}</span>
          </Show>
        </Show>
        <span>{clock(props.m.timestamp)}</span>
        <Show when={props.out && props.delivery}>
          <DeliveryMark d={props.delivery!} />
        </Show>
      </div>
    </article>
  );
}

function CallNetworkNote(props: { onOpenSettings?: () => void }) {
  return <Show when={!effectiveStun()}>
    <p class="hint call-network-note" data-call-network-note>
      {tr('uiCallsMayNotConnectAcrossNetworksYet')} {stunOff() ? tr('uiSTUNIsTurnedOff') : tr('uiNoSTUNServerIsSet')} {tr('uiChooseOneInSettingsGeneralCalls')}
      <Show when={props.onOpenSettings}>
        {' '}<button type="button" class="link" data-call-settings-link onClick={() => props.onOpenSettings!()}>{tr('uiOpenCallSettings')}</button>
      </Show>
    </p>
  </Show>;
}

/** The chosen server's address, with the same IP disclosure wherever calls show it. */
const chosenStunLabel = () => tr('extraCallsAskForYourPublicAddressSoThat', effectiveStun().replace(/^stun:/i, ''));
const callStunLabel = () => effectiveStun()
  ? effectiveStunSource() === 'own' ? tr('uiUsesTheSTUNServerToFindARoute', effectiveStun()) : chosenStunLabel()
  : stunOff() ? tr('uiSTUNIsTurnedOffSoCallsConnectOnly') : tr('uiNoSTUNServerIsSetSoCallsConnect');

/**
 * Call and video buttons. The price is read (never paid) first and shown on
 * the button: offer + hangup, with room for one fresh admission on recovery.
 */
function CallButtons(props: { peer: string; name: string; blocked: boolean; actions: Actions; callbackMedia?: CallMedia; offline?: boolean }) {
  const [quote, setQuote] = createSignal<CallQuote | null>(null);
  const [why, setWhy] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  // Only the latest read counts: one begun while they were offline can answer after the one begun when they came back.
  let dialogRead = 0;
  // An unconnected contact's node gives no live call price: read it again when they are back.
  createEffect(on([() => props.peer, () => props.offline], ([peer]) => {
    const read = ++dialogRead;
    onCleanup(() => { dialogRead++; });
    setRefreshing(false);
    setQuote(null);
    setWhy(null);
    void props.actions.callQuote(peer).then((r) => {
      if (props.peer !== peer || read !== dialogRead) return;
      if (r.ok) setQuote(r.value);
      else setWhy(r.error.message);
    });
  }));
  const cost = () => {
    const q = quote();
    return q && callCost(q) !== null ? 2 * callCost(q)! : null;
  };
  // M6: a node-routed call is placed only with the callee's per-minute price to agree to,
  // and only from a session whose node keeps a reservation for its minutes.
  const noMinutePrice = () => nodeRoutedAudio() && cost() !== null && ((quote()?.block_msat ?? null) === null || (quote()?.reservation_max_msat ?? null) === null);
  const noMinutesPaid = () => nodeRoutedAudio() && cost() !== null && !noMinutePrice() && quote()?.minutes_payable !== true;
  const off = () => props.blocked || cost() === null || props.actions.callActive() || noMinutePrice() || noMinutesPaid();
  const title = () =>
    why() ?? (noMinutePrice() ? tr('caMinutesNoPrice') : noMinutesPaid() ? tr('caMinutesOwnerSession') : quote() && cost() === null ? (props.offline ? tr('caContactOfflineCannotRing', props.name) : tr('uiSNodeDoesNotTakeCallsYet', possessive(props.name))) : cost() !== null
      ? tr('uiUpToToRingTheirCallPricePlus', fmtAmount(cost()!), fmtAmount(quote()!.offer_msat! + quote()!.offer_max_routing_fee_msat), feeCeiling(quote()!.offer_max_routing_fee_msat), fmtAmount(signalCost(quote()!)), fmtAmount(callCost(quote()!)!), callStunLabel())
      : tr('uiReadingTheirCallPrice'));
  const priceReady = () => !refreshing() && why() === null;
  const place = (media: CallMedia) => { const q = quote(); if (q && !off() && priceReady()) props.actions.placeCall(props.peer, media, q); };
  // A call pays and rings someone, so one tap only asks: the call/video button
  // opens a small confirm with the price, and Ring places it. A mis-tap on the
  // header costs nothing.
  const [armed, setArmed] = createSignal<CallMedia | null>(null);
  let ringBtn: HTMLButtonElement | undefined;
  let wrap: HTMLDivElement | undefined;
  createEffect(on(() => props.peer, () => setArmed(null), { defer: true }));
  createEffect(() => { if (off()) setArmed(null); });
  const arm = (media: CallMedia) => {
    if (off()) return;
    if (armed() === media) { disarm(false); return; }
    setArmed(media);
    if (nodeRoutedAudio()) {
      // Re-read the minutes consent for each opening, including after a node restart.
      const read = ++dialogRead;
      setRefreshing(true);
      setWhy(null);
      void props.actions.callQuote(props.peer).then((r) => {
        if (read !== dialogRead) return;
        if (r.ok) setQuote(r.value);
        else setWhy(r.error.message || tr('caCallPriceUnreadNothingPaid'));
        setRefreshing(false);
        queueMicrotask(() => { if (read === dialogRead && armed()) ringBtn?.focus(); });
      });
    } else queueMicrotask(() => ringBtn?.focus());
  };
  const disarm = (refocus = true) => {
    const media = armed();
    dialogRead++;
    setRefreshing(false);
    setArmed(null);
    if (refocus && media) wrap?.querySelector<HTMLButtonElement>(`[data-call="${media}"]`)?.focus();
  };
  createEffect(() => {
    if (!armed()) return;
    // Anything else pressed or focused (the contact name, settings, You, the
    // composer) dismisses the confirm: it must never sit, Ring enabled, over
    // another sheet or modal.
    const onOutside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && wrap?.contains(t)) return;
      disarm(false);
    };
    for (const type of ['pointerdown', 'click', 'focusin']) document.addEventListener(type, onOutside, true);
    onCleanup(onEscape(() => disarm()));
    onCleanup(() => {
      for (const type of ['pointerdown', 'click', 'focusin']) document.removeEventListener(type, onOutside, true);
    });
  });
  const callWord = (media: CallMedia) => (media === 'video' ? tr('uiVideoCall') : tr('uiCall'));
  return (
    <div class="call-buttons" data-call-buttons ref={wrap}>
      <button type="button" class={props.callbackMedia ? "soft call-button" : "soft call-button icon-btn"} data-call={props.callbackMedia ?? 'audio'} data-call-back={props.callbackMedia ? '' : undefined} disabled={off()} title={title()} aria-label={props.callbackMedia ? tr('incomingCallBack') : tr('uiCall95', props.name, cost() !== null ? tr('uiUpTo', fmtAmount(cost()!)) : '')} aria-haspopup="dialog" aria-expanded={armed() === (props.callbackMedia ?? 'audio')} onClick={() => arm(props.callbackMedia ?? 'audio')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
        <Show when={props.callbackMedia}>{tr('incomingCallBack')}</Show>
      </button>
      {/* Node-routed video, when this build has it: the same price and the same path as the audio. */}
      <Show when={!props.callbackMedia && nodeRoutedVideo()}>
      <button type="button" class="soft call-button icon-btn" data-call="video" disabled={off()} title={title()} aria-haspopup="dialog" aria-expanded={armed() === 'video'} onClick={() => arm('video')} aria-label={tr('uiVideoCall')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3z" /></svg>
      </button>
      </Show>
      {/* Video and meetings are app-to-app media: hidden while calls are node-routed (M6). */}
      <Show when={!props.callbackMedia && !nodeRoutedAudio()}>
      <button type="button" class="soft call-button icon-btn" data-call="video" disabled={off()} title={title()} aria-haspopup="dialog" aria-expanded={armed() === 'video'} onClick={() => arm('video')} aria-label={tr('uiVideoCall98', props.name, cost() !== null ? tr('uiUpTo', fmtAmount(cost()!)) : '')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3z" /></svg>
      </button>
      <button type="button" class="soft call-button icon-btn quiet" data-call="meeting" disabled={off()} title={tr('uiStartAMeetingWithAndUpToMore', props.name, MAX_PARTICIPANTS - 2)} aria-label={tr('uiStartAMeetingWith', props.name)} onClick={() => props.actions.planMeeting(props.peer)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14a5 5 0 0 1 4 5" /></svg>
      </button>
      </Show>
      <Show when={armed()}>
        {(media) => (
          <div class="call-confirm" role="dialog" aria-label={`${callWord(media())} ${props.name}?`} data-call-confirm-box={media()}>
            <p class="call-confirm-text">
              <strong>{callWord(media())} {props.name}?</strong>
              <Show when={priceReady() && cost() !== null}>{' '}<span class="hint">{tr('uiUpTo105')} {fmtAmount(cost()!)}{tr('uiNothingIsPaidUntilYouPressRing')}</span></Show>
            </p>
            <Show when={!priceReady()}><p class="hint" role="status">{why() ?? tr('uiReadingTheirCallPrice')}</p></Show>
            <Show when={priceReady() && nodeRoutedAudio() && quote()?.block_msat != null ? quote() : null}>{(q) => <>
              <MinutesConsent quote={q()} />
              <RingBudgetNote grant={props.actions.callGrant?.() ?? null} peer={props.peer} name={props.name} quote={q()} callLimitMinutes={props.actions.callLimitMinutes?.() ?? null} />
            </>}</Show>
            {/* The route finder's address is technical: only under Details. */}
            <details class="quiet-detail" data-call-stun-detail>
              <summary>{tr('uiDetails')}</summary>
              <p class="hint" data-call-stun-source>{callStunLabel()}</p>
            </details>
            <div class="call-confirm-actions">
              <button type="button" class="soft" data-call-confirm-cancel onClick={() => disarm()}>{tr('uiCancel')}</button>
              <button ref={ringBtn} type="button" class="primary soft money" data-call-confirm={media()} disabled={off() || !priceReady()} onClick={() => { if (off() || !priceReady()) return; const m = media(); setArmed(null); place(m); }}>{tr('uiRing')}</button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The call panel's title: the same word as the pill. */
/** What the card says about the far picture, when there is something to say. */
function videoStatusLine(status: VideoStatus | null | undefined): string | null {
  if (!status) return null;
  if (status.failed) return tr('caVideoUnavailable');
  if (status.peerVideo === false) return tr('caVideoPeerNoVideo');
  if (status.sendingPaused || status.peerPaused) return tr('caVideoPaused');
  if (!status.peerCamera) return tr('caVideoPeerCameraOff');
  return null;
}

const CALL_TITLE = CALL_STATE_WORD;
const END_REASON: Record<string, string> = {
  get hangup() { return tr('callHungUp'); }, get declined() { return tr('callDeclined'); },
  get busy() { return tr('callBusy'); }, get timeout() { return tr('callNoAnswer'); }, get failed() { return tr('callFailed'); },
  get unpaid() { return tr('caCallEndedUnpaid'); },
};

/**
 * M6 consent before Ring: the callee's per-minute price and the most any node
 * may hold (240 minutes). The caller's node's own limit (`max_call_minutes`)
 * shows on its reservation once it rings, for the owner to confirm.
 */
function MinutesConsent(props: { quote: CallQuote }) {
  return (
    <>
      <p class="hint" data-call-minute-price>{tr('uiCallMinutePrice', fmtAmount(props.quote.block_msat!), fmtAmount(props.quote.block_max_routing_fee_msat ?? 0))}</p>
      <Show when={props.quote.reservation_max_msat != null}>
        {/* The short promise up front; the full rules (limits, 4 hours) stay one tap away, word for word. */}
        <p class="hint" data-call-reservation-max>{tr('uiCallReservationShort', fmtAmount(props.quote.reservation_max_msat!))}</p>
        <details class="quiet-detail" data-call-reservation-detail>
          <summary>{tr('uiDetails')}</summary>
          <p class="hint">{tr('uiCallReservationMax', fmtAmount(props.quote.reservation_max_msat!))}</p>
        </details>
      </Show>
    </>
  );
}

/**
 * M6: the running cost of an outgoing node-routed call, and its summary once
 * it ended. Every amount is the node's (its reservation on the call status);
 * a node without a reservation is described by its block receipts, "up to".
 */
function CallMinutesLine(props: { minutes: MinutesView; ended: boolean; confirm?: () => void }) {
  const m = () => props.minutes;
  const hold = () => m().reservation;
  return (
    <Switch>
      {/* The node's exact hold, under its own call limit: no minute is paid before the owner confirms it. */}
      <Match when={!props.ended && !m().confirmed && !m().stop && hold() && !hold()!.closed ? hold() : null}>
        {(h) => (
          <div data-call-minutes="confirm">
            <p class="hint" data-call-hold>{tr('uiMinutesHold', fmtAmount(h().reserved_msat), String(h().max_call_minutes), fmtAmount(h().per_block_msat), fmtAmount(h().per_block_fee_msat))}</p>
            <Show when={props.confirm}>
              {/* The call only connects once the hold is confirmed: say so next to the button, in plain words. */}
              <p class="hint" aria-live="polite" data-call-hold-needed>{tr('uiMinutesConfirmNeeded')}</p>
              <button type="button" class="primary money" data-call-minutes-confirm disabled={m().confirming} onClick={() => props.confirm?.()}>{tr('uiMinutesConfirmHold')}</button>
            </Show>
            <Show when={m().holdError}><p class="hint" role="status" data-call-hold-error>{m().holdError}</p></Show>
          </div>
        )}
      </Match>
      <Match when={props.ended && hold()}>
        {(h) => (
          <Show when={h().closed} fallback={<p class="hint" data-call-minutes="held">{tr('uiMinutesSummaryHeld', fmtAmount(h().spent_msat), fmtAmount(h().remaining_msat))}</p>}>
            <p class="hint" data-call-minutes="released">{tr('uiMinutesSummaryReleased', fmtAmount(h().spent_msat), fmtAmount(h().released_msat))}</p>
          </Show>
        )}
      </Match>
      <Match when={props.ended && m().receiptsMsat > 0}>
        <p class="hint" data-call-minutes="receipts">{tr('uiMinutesSummaryNoReservation', fmtAmount(m().receiptsMsat))}</p>
      </Match>
      <Match when={props.ended}>{null}</Match>
      <Match when={hold()}>
        {(h) => (
          <p class="hint" data-call-minutes="running">
            {m().blocks > 0 || h().spent_msat > 0
              ? tr('uiMinutesRunning', fmtAmount(h().per_block_msat), fmtAmount(h().per_block_fee_msat), fmtAmount(h().spent_msat), fmtAmount(h().remaining_msat))
              : tr('uiMinutesReserved', fmtAmount(h().reserved_msat))}
            <Show when={m().paying}>{' '}{tr('uiMinutesPaying')}</Show>
          </p>
        )}
      </Match>
      <Match when={m().receiptsMsat > 0}>
        <p class="hint" data-call-minutes="running">{tr('uiMinutesNoReservation', fmtAmount(m().agreedBlockMsat), fmtAmount(m().receiptsMsat))}</p>
      </Match>
      <Match when={m().reservationMaxMsat !== null}>
        <p class="hint" data-call-minutes="reserving">{tr('uiMinutesReserving', fmtAmount(m().reservationMaxMsat!))}</p>
      </Match>
    </Switch>
  );
}

/** The route label's words. They claim only what this call's key exchange has shown. */
function sealLabel(state: SealState | null) {
  switch (state) {
    case 'setting_up': return 'caCallSealSettingUp' as const;
    case 'sealed': return 'caCallSealed' as const;
    case 'not_sealed': return 'caCallNotSealed' as const;
    default: return 'caNodeRoutedCallLabel' as const;
  }
}

/** The call card: incoming (accept/decline with price), ringing, live (mute, camera, duration, hang up), ended. */
function CallPanel(props: {
  waiting?: boolean;
  answerBlocked?: boolean;
  payment: JSX.Element;
  panelRef: (el: HTMLElement) => void;
  approvalOpen: boolean;
  approval: JSX.Element;
  spendingReady?: boolean;
  approveSpending?: () => void;
  blocked: boolean;
  /** M6: audio goes through both nodes; no direct connection, STUN or recovery notes. */
  routed?: boolean;
  seal?: SealState | null;
  words?: string[] | null;
  view: CallView;
  streams: { local: MediaStream | null; remote: MediaStream | null };
  /** Node-routed video: where the far picture is drawn, and what to say about it. */
  videoCanvas?: HTMLCanvasElement | null;
  videoStatus?: VideoStatus | null;
  nameOf: (id: string) => string;
  quote: (peer: string) => Promise<Outcome<CallQuote>>;
  accept: (shown: CallQuote) => void;
  decline: (shown: CallQuote) => void;
  /** Stop ringing here: nothing sent or paid. */
  ignore: () => void;
  hangup: () => void;
  mute: () => void;
  camera: () => void;
  dismiss: () => void;
  /** H2: ask the host again to end this call's admission. */
  closeAgain: () => void;
  /** H2: end the earlier call the host still holds open to this contact. */
  endStuck: () => void;
  callAgain: (peer: string, media: CallMedia, quote: CallQuote) => void;
  /** M6 A2: confirm the node's hold for this outgoing call before its first minute is paid. */
  confirmMinutes?: () => void;
  /** Opens Settings → General, where the STUN server is chosen. */
  openCallSettings?: () => void;
}) {
  const [tick, setTick] = createSignal(Date.now());
  /** The price on Accept and Decline: a press pays at most this, and neither works without it. */
  const [shown, setShown] = createSignal<CallQuote | null>(null);
  const [noPrice, setNoPrice] = createSignal(false);
  const [again, setAgain] = createSignal<CallQuote | null>(null);
  const [againError, setAgainError] = createSignal<string | null>(null);
  createEffect(on(() => props.view.callId, () => { setAgain(null); setAgainError(null); }));
  const offerAgain = async () => {
    const call = props.view.callId;
    const peer = props.view.peer;
    if (!peer) return;
    const q = await props.quote(peer);
    if (props.view.callId !== call || props.view.phase !== 'ended') return;
    if (q.ok && callCost(q.value) !== null && props.routed && ((q.value.block_msat ?? null) === null || (q.value.reservation_max_msat ?? null) === null)) setAgainError(tr('caMinutesNoPrice'));
    else if (q.ok && callCost(q.value) !== null && props.routed && q.value.minutes_payable !== true) setAgainError(tr('caMinutesOwnerSession'));
    else if (q.ok && callCost(q.value) !== null) setAgain(q.value);
    else setAgainError(q.ok ? tr('uiTheirNodeDoesNotTakeCallsYet') : q.error.message);
  };
  let panel: HTMLElement | undefined;
  createEffect(on(() => props.view.phase === 'incoming' ? props.view.callId : null, (callId) => {
    if (!callId) return;
    queueMicrotask(() => {
      if (props.view.phase === 'incoming' && props.view.callId === callId && panel?.isConnected) panel.focus();
    });
  }));
  createEffect(() => {
    // Also count down a phone call's stop while it is still connecting.
    if (!['live', 'reconnecting'].includes(props.view.phase) && !(props.view.stopped && props.view.stopped.endsAt !== null)) return;
    setTick(Date.now());
    const t = setInterval(() => setTick(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  createEffect(on(() => (props.view.phase === 'incoming' ? props.view.callId : null), (callId) => {
    setShown(null);
    setNoPrice(false);
    const peer = props.view.peer;
    if (callId && peer) void props.quote(peer).then((r) => {
      // A waiting card can be gone by now, and its view with it.
      if ((props.view as CallView | undefined)?.callId !== callId) return;
      if (r.ok && answerCost(r.value) !== null) setShown(r.value);
      else setNoPrice(true);
    });
  }));
  const v = () => props.view;
  const who = () => (v().peer ? props.nameOf(v().peer!) : '');
  /** The M6 paid-minutes line is on the card (same condition as its render below). */
  const minutesShown = () => !!(props.routed && v().outgoing && v().minutes);
  /**
   * The ended call can cost nothing more, on positive evidence only: no signal payment in flight or unknown,
   * the host confirmed it ended every admission (`closed`; not yet started, closing, refused or unknown never count),
   * and any minutes hold is closed at the node with nothing left in it (unresolved minute payments stay in `remaining_msat`).
   * Without that evidence (a peer-closed call, minutes with no reservation) the card says nothing rather than too much.
   */
  const nothingMore = () => {
    const c = v();
    if (c.phase !== 'ended' || c.callId === null || c.stuck || c.pendingCount > 0 || c.unknownCount > 0) return false;
    if (c.close?.status !== 'closed') return false;
    const m = c.minutes;
    if (!m) return true;
    const hold = m.reservation;
    return !m.paying && !!hold && hold.closed && hold.remaining_msat === 0;
  };
  return (
    <Show when={v().phase !== 'idle' || props.approvalOpen}>
      <aside ref={el => { panel = el; props.panelRef(el); }} tabindex="-1" class="call-panel" data-call-panel={v().phase} data-call-approval-open={props.approvalOpen ? '' : undefined} role="dialog" aria-label={props.approvalOpen ? tr('uiCallSpendingApproval') : `${CALL_TITLE[v().phase]} ${who()}`}>
        <header>
          <strong data-call-title aria-live="polite">{CALL_TITLE[v().phase]}{v().media === 'video' ? tr('uiVideo') : ''}</strong>
          <span class="who">{who()}</span>
          <Show when={(v().phase === 'live' || v().phase === 'reconnecting') && v().liveAt !== null}>
            <span class="duration" data-call-duration>{duration(Math.max(0, tick() - v().liveAt!))}</span>
          </Show>
        </header>
        <Show when={props.waiting && props.answerBlocked && v().phase === 'incoming'}><p class="hint">{tr('incomingWaiting')}</p></Show>
        <Show when={noPrice() && v().phase === 'incoming'}><p class="hint" role="status" data-call-answer-price>{tr('caCallAnswerNoPrice')}</p></Show>
        {/* What answering can cost this owner, in words: the answer, their own hangup, and only a reconnect beyond that (each one signal, all-in).
            Kept one tap away under Details: the ringing card itself carries no price. */}
        <Show when={v().phase === 'incoming' && shown() ? answerCost(shown()!) : null}>
          {(m) => <details class="quiet-detail" data-call-answer-detail>
            <summary>{tr('uiDetails')}</summary>
            <p class="hint" data-call-answer-cost>{tr('caCallAnswerCostNote', fmtAmount(m()))}</p>
          </details>}
        </Show>
        {/* Decline is the free local ignore: nothing is sent or paid, so their ring runs out by itself. */}
        <Show when={v().phase === 'incoming' && !v().silenced}>
          <p class="hint" data-call-decline-note>{tr('caCallDeclineFreeNote')}</p>
        </Show>
        <Show when={v().phase === 'incoming' && props.spendingReady === false}>
          <p class="hint" role="status" data-call-spend-needed>
            {tr('caAnswerNeedsSpendingApproval')}{' '}
            <button type="button" class="link" data-call-spend-approve disabled={props.blocked || v().silenced} onClick={() => props.approveSpending?.()}>{tr('uiApproveSpending')}</button>
          </p>
        </Show>
        {props.approval}
        {/* No surprise camera: before Accept, a video call says the camera comes on, and how to turn it off. */}
        <Show when={v().phase === 'incoming' && v().media === 'video'}>
          <p class="hint" data-call-camera-notice>{tr('uiIncomingVideoCameraNote')}</p>
        </Show>
        {/* Across networks a call needs a STUN server: said where it matters, while a call is being set up or has failed to connect. */}
        <Show when={!props.routed && (['calling', 'ringing', 'connecting'].includes(v().phase) || (v().phase === 'ended' && (v().reason === 'failed' || v().reason === 'timeout')))}>
          <CallNetworkNote onOpenSettings={props.openCallSettings} />
        </Show>
        {/* While reconnecting: what is happening, and when the call ends if it does not come back (display only). */}
        <Show when={v().phase === 'reconnecting'}>
          <p class="hint" role="status" data-call-reconnecting>
            {tr('uiConnectionLostReconnecting')}
            <Show when={v().dropAt !== null}>{' '}{tr('uiIfItIsnTBackIn')} <span data-call-drop-in>{Math.max(0, Math.ceil((v().dropAt! - tick()) / 1000))}</span> {tr('uiSTheCallEnds')}</Show>
            <Show when={v().recoveryUsedBefore}>{' '}{tr('uiThisCallAlreadyUsedItsOneRecoveryWaiting')}</Show>
          </p>
        </Show>
        <Show when={v().media === 'video' && (v().phase === 'live' || v().phase === 'connecting' || v().phase === 'reconnecting')}>
          <div class="call-videos">
            <Show when={props.videoCanvas} fallback={<MediaView stream={props.streams.remote} video muted={false} kind="remote" />}>
              {(canvas) => { canvas().classList.add('call-video', 'remote'); canvas().dataset.callMedia = 'remote'; return <>{canvas()}</>; }}
            </Show>
            {/* Your own picture, named and shown as in a mirror; with the camera off it says so instead of going black. */}
            <div class="call-self" data-call-self data-camera-off={v().camera ? undefined : ''}>
              <MediaView stream={props.streams.local} video muted kind="local" />
              <span class="call-self-label" data-call-self-label>{v().camera ? tr('uiYou') : `${tr('uiYou')} · ${tr('uiCallSelfCameraOff')}`}</span>
            </div>
          </div>
        </Show>
        <Show when={props.routed && v().media === 'video' && videoStatusLine(props.videoStatus)}>
          {(line) => <p class="hint" role="status" data-call-video-status>{line()}</p>}
        </Show>
        <Show when={v().media === 'audio'}>
          <MediaView stream={props.streams.remote} video={false} muted={false} kind="remote" />
        </Show>
        {/* The host reports each signal's ceiling, not settled fees: after the call, "up to" is the honest total. */}
        <Show when={v().phase === 'ended'} fallback={
          <Show when={v().paidMsat > 0 && !minutesShown()}>
            <p class="hint" data-call-paid>{tr('uiSignalCostCap')} {fmtAmount(v().paidMsat)} {tr('uiIncludesMaximumRoutingFeesSettledAmountMayBe')}</p>
          </Show>
        }>
          <Switch>
            {/* Something is still in flight: never "paid nothing" (or a final total) until it settles. */}
            <Match when={v().pendingCount > 0}>
              <p class="hint" data-call-paid="pending">
                {v().paidMsat > 0 ? tr('uiThisCallPaidUpToSoFar', fmtAmount(v().paidMsat)) : ''}
                {v().unknownCount > 0 ? tr('uiCheckPendingResult', v().unknownCount === 1 ? tr('uiOneSignalSResultIsNotKnownYet') : tr('uiSignalsResultsAreNotKnownYet', v().unknownCount)) : ''}
                {v().pendingCount === 1 ? tr('uiAPaymentForThisCallIsStillSettling') : tr('uiPaymentsForThisCallAreStillSettling', v().pendingCount)}{tr('uiUpTo126')} {fmtAmount(v().pendingMsat)}{tr('uiTheTotalUpdatesWhen')} {v().pendingCount === 1 ? tr('uiItFinishes') : tr('uiTheyFinish')}{tr('uiMediaWasNotBilled')}
              </p>
            </Match>
            <Match when={v().unknownCount > 0}>
              <p class="hint" data-call-paid="unknown">
                {v().paidMsat > 0 ? tr('uiThisCallPaidUpTo', fmtAmount(v().paidMsat)) : tr('uiNoPaymentFromThisCallIsConfirmed')}{' '}
                {v().unknownCount === 1 ? tr('uiOneSignalSResultIsNotKnownYet') : tr('uiSignalsResultsAreNotKnownYet', v().unknownCount)} {tr('uiUpTo133')} {fmtAmount(v().paidMsat + v().unknownMsat)} {tr('uiInAllIf')} {v().unknownCount === 1 ? tr('itPronoun') : tr('theyPronoun')} {tr('uiWentThroughCheckPendingResultMediaWasNot')}
              </p>
            </Match>
            <Match when={v().paidMsat > 0}>
              <p class="hint" data-call-paid="settled">{tr('uiThisCallPaidUpTo136')} {fmtAmount(v().paidMsat)}{tr('uiEachSignalSPricePlusItsRoutingFee')}</p>
            </Match>
            {/* A call that started (it has an id) and paid nothing; pre-flight refusals already say "Nothing was paid". */}
            <Match when={v().callId !== null}>
              <p class="hint" data-call-paid="nothing">{tr('uiThisCallPaidNothing')}</p>
            </Match>
          </Switch>
        </Show>
        <Show when={v().phase === 'ended' ? v().connection : null}>
          {(connection) => <p class="hint" data-call-connection>{tr('uiConnection')} {connection().local === 'srflx' ? 'srflx(STUN)' : connection().local} {tr('uiLocal140')} {connection().remote === 'srflx' ? 'srflx(STUN)' : connection().remote} {tr('uiRemote')}</p>}
        </Show>
        <Show when={v().phase === 'ended'}>
          <p class="hint" data-call-ended>{v().stuck
            ? tr('uiACallToIsStillClosingAtYour', who())
            : v().minutes?.stop?.limit?.code === 'budget_exhausted' ? tr('caCallEndedContactLimit')
            : v().minutes?.stop?.limit?.code === 'ceiling_exhausted' ? tr('caCallEndedTotalLimit')
            : v().minutes?.stop?.limit?.code === 'grant_exhausted' ? tr('caCallEndedGrantLimit')
            : v().error ?? END_REASON[v().reason ?? 'hangup']}</p>
          <Show when={!v().stuck ? v().minutes?.stop?.detail : null}>
            {(detail) => <details class="quiet-detail" data-call-end-detail>
              <summary>{tr('uiDetails')}</summary>
              <p class="hint">{detail()}</p>
            </details>}
          </Show>
          <Show when={!v().stuck ? v().minutes?.stop?.limit : null}>
            {(limit) => <p class="hint" data-call-budget-limit={limit().code}>
              {hostText(limit().message)}{' '}
              {limit().code === 'budget_exhausted' ? tr('caCallContactBudgetSettings')
                : limit().code === 'ceiling_exhausted' ? tr('caCallTotalBudgetSettings')
                : limit().code === 'grant_exhausted' ? tr('caCallNodeGrantApproval') : ''}
            </p>}
          </Show>
          <Show when={v().reason === 'failed' && !props.routed}>
            {/* A connectivity failure only ('failed': the connection closed, was lost, or never connected); no relay exists yet. No money claim here. */}
            <p class="hint" data-call-no-relay>{tr('uiSomeNetworksNeedARelayToConnectA')}</p>
          </Show>
        </Show>
        <Show when={v().phase === 'ended' && v().close && (v().close!.status !== 'closed' || !!v().close!.message) ? v().close : null}>
          {(close) => (
            <p class={close().status === 'refused' || close().status === 'unknown' ? 'err-note' : 'hint'} role={close().status === 'closing' ? 'status' : 'alert'} data-call-close={close().status}>
              {close().status === 'closing' ? tr('uiEndingTheCallAtYourNode') : close().message}
            </p>
          )}
        </Show>
        {/* Display only: the browser reports no network. Recovery itself stays ICE-driven. */}
        <Show when={v().offline && v().phase !== 'ended' && v().phase !== 'idle'}>
          <p class="hint" role="status" data-call-offline>{tr('uiYouAreOfflineTheCallReconnectsByItself')}</p>
        </Show>
        {/* Phones: the call is out of view or its microphone is silenced, and ends unless that clears; or it ended for that. */}
        <Show when={v().stopped}>
          {(stop) => (
            <p class="err-note" role={stop().endsAt === null ? 'alert' : 'status'} data-call-stopped={stop().cause}>
              {stop().endsAt === null
                ? tr(stop().cause === 'background' ? 'caCallStoppedBackground' : 'caCallStoppedMicrophone')
                : tr(stop().cause === 'background' ? 'caCallStoppingBackground' : 'caCallStoppingMicrophone', Math.max(0, Math.ceil((stop().endsAt! - tick()) / 1000)))}
            </p>
          )}
        </Show>
        <Show when={v().phase !== 'ended' && v().error}>
          {/* Only a recovery that could not start is framed as one (the call still waits); any other error (a camera, say) as it is. */}
          <p class="hint" data-call-error>{v().recoveryError === RECOVERY_CLOSING ? tr('caRecoveryClosing') : v().phase === 'reconnecting' && v().recoveryError !== null ? tr('uiRecoveryCouldNotStartStillWaitingForThe', v().recoveryError ?? '') : v().error}</p>
        </Show>
        {/* M6: the call's paid minutes, from the node's own figures; after the call, what was paid and released. */}
        <Show when={props.routed && v().outgoing && v().minutes ? v().minutes : null}>
          {(m) => <CallMinutesLine minutes={m()} ended={v().phase === 'ended'} confirm={props.confirmMinutes} />}
        </Show>
        {/* Said only once nothing about this call can still be paid: every payment settled, the host closed it, and any minutes hold is settled. */}
        <Show when={nothingMore()}>
          <p class="hint" data-call-nothing-more>{tr('uiCallNothingMore')}</p>
        </Show>
        {props.payment}
        {/* M6 P3: after the call, the app's own record of it, to copy next to the node journal. Display only. */}
        <CallReportCopy view={v()} routed={!!props.routed} />
        {/* Said in words, not only by the pressed look: what the other person gets while the microphone or camera is off. */}
        <Show when={v().phase === 'live' || v().phase === 'connecting' || v().phase === 'reconnecting'}>
          <Show when={v().muted}><p class="hint" role="status" data-call-mic-off>{tr('uiMicOffNote')}</p></Show>
          <Show when={v().media === 'video' && !v().camera}><p class="hint" role="status" data-call-camera-off>{tr('uiCameraOffNote')}</p></Show>
        </Show>
        <div class="call-actions">
          <Switch>
            <Match when={v().phase === 'incoming'}>
              {/* No price on either button: Accept stays bounded by the quote read for it (`shown`), and Decline is the free local ignore. */}
              <button type="button" class="primary soft money" data-call-accept disabled={props.blocked || props.answerBlocked || props.view.silenced || !shown()} onClick={() => { const q = shown(); if (q) props.accept(q); }}>{tr('uiAccept')}</button>
              <button type="button" class="soft" data-call-decline data-call-ignore disabled={props.view.silenced} onClick={() => props.ignore()}>{tr('uiDecline')}</button>
            </Match>
            <Match when={v().phase === 'ended'}>
              <Show when={v().stuck}>
                <button type="button" class="soft money" data-call-end-stuck onClick={() => props.endStuck()}>{tr('uiEndThatCall')}</button>
              </Show>
              <Show when={v().close?.status === 'refused' && !v().stuck}>
                <button type="button" class="soft money" data-call-close-retry onClick={() => props.closeAgain()}>{tr('uiTryEndingItAgain')}</button>
              </Show>
              <Show when={v().outgoing && v().close?.status === 'closed' && !v().stuck && v().pendingCount === 0 && v().unknownCount === 0}>
                <Show when={again()} fallback={<button type="button" class="soft" data-call-again disabled={props.blocked} onClick={() => void offerAgain()}>{tr('uiCallAgain')}</button>}>
                  {(q) => <>
                    <Show when={props.routed && q().block_msat != null}><MinutesConsent quote={q()} /></Show>
                    <button type="button" class="primary money" data-call-again-confirm disabled={props.blocked} onClick={() => props.callAgain(v().peer!, v().media, q())}>{tr('uiRingUpTo')} {fmtAmount(2 * callCost(q())!)}</button>
                  </>}
                </Show>
                <Show when={againError()}><p class="hint" role="status">{againError()}</p></Show>
              </Show>
              <button type="button" class="soft" data-call-dismiss disabled={v().pendingCount > 0} title={v().pendingCount > 0 ? tr('uiClosesOnceThePaymentHasSettled') : undefined} onClick={() => props.dismiss()}>{tr('uiClose')}</button>
            </Match>
            <Match when={v().phase !== 'idle'}>
              <Show when={v().phase === 'live' || v().phase === 'connecting' || v().phase === 'reconnecting'}>
                <button type="button" class="soft" data-call-mute aria-pressed={v().muted} onClick={() => props.mute()}>{tr('uiMute')}</button>
                <Show when={v().media === 'video'}>
                  <button type="button" class="soft" data-call-camera aria-pressed={v().camera} onClick={() => props.camera()}>{tr('uiCamera')}</button>
                </Show>
              </Show>
              <button type="button" class="danger soft" data-call-hangup onClick={() => props.hangup()}>
                {v().recoveryError === RECOVERY_CLOSING ? tr('uiEndCall') : v().phase === 'calling' ? tr('uiCancel') : tr('uiHangUp')}
              </button>
            </Match>
          </Switch>
        </div>
        {/* M6: the honest label for a node-routed call, from ringing until it ends. It stays visible until the apps encrypt end to end. */}
        <Show when={props.routed && v().phase !== 'idle' && v().phase !== 'ended'}>
          {/* A video call says the boxes can see it too; a build with sealing on has no video, so its label is unchanged. */}
          <p class="hint" data-call-route="node" data-call-seal={props.seal ?? undefined}>{props.seal == null && v().media === 'video' ? tr('caNodeRoutedVideoLabel') : tr(sealLabel(props.seal ?? null))}</p>
          <Show when={import.meta.env.VITE_CALL_SEAL === 'sealed' && props.seal === 'sealed' && props.words?.length === 4 && props.words}>
            {(words) => <div data-call-words>
              <PairWords words={words()} />
              <p class="hint">{tr('caCallCompareWords')}</p>
            </div>}
          </Show>
        </Show>
        {/* A short card while the call lasts: the longer notes wait behind Details (display only; same texts and amounts). */}
        <Show when={v().phase !== 'ended' && (!props.routed || v().phase !== 'idle')}>
          <details class="quiet-detail" data-call-details>
            <summary>{tr('uiDetails')}</summary>
            {/* Not on the ended card: it promises a recovery that can no longer happen. */}
            <Show when={!props.routed}>
              <p class="hint" data-call-recovery-note>{tr('uiTheConnectionMayRecoverOnItsOwnA')}</p>
            </Show>
            {/* With the paid minutes as the cost line, the signal cap is the detail. */}
            <Show when={v().paidMsat > 0 && minutesShown()}>
              <p class="hint" data-call-paid>{tr('uiSignalCostCap')} {fmtAmount(v().paidMsat)} {tr('uiIncludesMaximumRoutingFeesSettledAmountMayBe')}</p>
            </Show>
            <Show when={v().connection}>
              {(connection) => <p class="hint" data-call-connection>{tr('uiConnection')} {connection().local === 'srflx' ? 'srflx(STUN)' : connection().local} {tr('uiLocal140')} {connection().remote === 'srflx' ? 'srflx(STUN)' : connection().remote} {tr('uiRemote')}</p>}
            </Show>
          </details>
        </Show>
      </aside>
    </Show>
  );
}

const LEG_STATE: Record<LegState, string> = {
  get waiting() { return tr('caWaiting'); }, get placing() { return tr('caPreparing'); }, get ringing() { return tr('callRinging'); }, get incoming() { return tr('caRingingYou'); }, get connecting() { return tr('callConnecting'); }, get live() { return tr('callLive'); }, get reconnecting() { return tr('callReconnecting'); }, get ended() { return tr('caEnded'); }, get nolink() { return tr('caNoLink'); },
};

/**
 * Meetings: the planner (pick up to 3 contacts, all-in price before anyone is
 * rung), the invite card (join price), and the meeting itself (one tile per
 * other participant; a missing pair shows "No link" and the rest goes on).
 */
function MeetingPanel(props: {
  view: MeetingView;
  streams: { local: MediaStream | null; remote: Record<string, MediaStream> };
  plan: string[] | null;
  contacts: { id: string; name: string; meetings: boolean; connected: boolean }[];
  /** Our own node takes meeting legs. */
  nodeMeets: boolean;
  ownId: string;
  /** Money is not ready: nobody can be invited. */
  blocked: boolean;
  nameOf: (id: string) => string;
  quote: (peer: string) => Promise<Outcome<CallQuote>>;
  setPlan: (ids: string[] | null) => void;
  /** `quotes` are exactly the prices shown: the engine never pays above them. */
  invite: (ids: string[], media: CallMedia, quotes: ShownQuotes) => void;
  join: (quotes: ShownQuotes) => void;
  decline: (quotes: ShownQuotes) => void;
  leave: () => void;
  mute: () => void;
  camera: () => void;
  dismiss: () => void;
}) {
  // Read-only call quotes, read afresh each time the planner or an invite card
  // opens. What is shown is what binds: the engine pays at most these.
  // `undefined` = still reading, `null` = no call price.
  const [quotes, setQuotes] = createStore<Record<string, CallQuote | null | undefined>>({});
  let generation = 0;
  const refresh = (ids: string[]) => {
    const g = ++generation;
    setQuotes(reconcile(Object.fromEntries(ids.map((id) => [id, undefined]))));
    ids.forEach((id) => void props.quote(id).then((r) => { if (g === generation) setQuotes(id, r.ok ? r.value : null); }));
  };
  const planning = () => props.plan !== null && (props.view.phase === 'idle' || props.view.phase === 'ended');
  createEffect(on(planning, (open) => { if (open) refresh(props.contacts.map((c) => c.id)); }));
  // The planner is a dialog: focus moves in when it opens, and Escape cancels it (nobody is rung).
  // Keyed on the open/closed boolean only: toggling a participant changes the plan
  // but must not re-run this and pull focus away from the checkbox just pressed.
  const planOpen = createMemo(planning);
  createEffect(on(planOpen, (open) => {
    if (!open) return;
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-meeting-panel="planning"] input:not(:disabled), [data-meeting-panel="planning"] [data-meeting-cancel]')?.focus());
    // Only while it is the top layer: Escape in Settings opened over it closes Settings, not the plan.
    onCleanup(onEscape(() => props.setPlan(null)));
  }));
  createEffect(on(() => (props.view.phase === 'invited' ? props.view.id : null), (id) => {
    if (id) refresh(untrack(() => props.view.roster).filter((x) => x !== props.ownId.toLowerCase()));
  }));
  const shown = (ids: string[]): ShownQuotes => Object.fromEntries(ids.map((id) => [id, quotes[id] ?? null]));
  const priced = (id: string) => { const q = quotes[id]; return !!q && callCost(q) !== null; };
  const contact = (id: string) => props.contacts.find((c) => c.id === id);
  // Only a connected contact whose node advertises meetings is ever rung with a leg.
  const meets = (id: string) => props.nodeMeets && contact(id)?.meetings === true;
  const pickable = (id: string) => !props.blocked && meets(id) && priced(id);
  const toggle = (id: string) => {
    const plan = props.plan ?? [];
    props.setPlan(plan.includes(id) ? plan.filter((x) => x !== id) : plan.length < MAX_PARTICIPANTS - 1 ? [...plan, id] : plan);
  };
  const planCost = () => (props.plan?.length && !props.blocked && props.plan.every(meets) ? inviteCost(props.plan.map((id) => quotes[id] ?? null)) : null);
  const joinPrice = () => joinCost(props.view.roster, props.ownId.toLowerCase(), shown(props.view.roster));
  const declinePrice = () => declineCost(props.view, shown(props.view.legs.map((l) => l.peer)));
  const price = (m: number | null) => (m === null ? '' : ` · ${sats(m)} ${satUnit(m)}`);
  const v = () => props.view;
  const host = () => (v().roster[0] ? props.nameOf(v().roster[0]) : '');
  const others = () => v().roster.slice(1).filter((id) => id !== props.ownId.toLowerCase()).map(props.nameOf).join(', ');
  return (
    <>
      <Show when={planning()}>
        <aside class="call-panel meeting-panel" data-meeting-panel="planning" role="dialog" aria-label={tr('caPlanAMeeting')}>
          <header><strong>{tr('caMeeting')}</strong><span class="who">{tr('caYouAndUpTo')}{' '}{MAX_PARTICIPANTS - 1}{' '}{tr('caContacts')}</span></header>
          <ul class="meeting-legs">
            <For each={props.contacts}>
              {(c) => (
                <li>
                  <label>
                    <input type="checkbox" data-meeting-pick={c.id} checked={props.plan?.includes(c.id) ?? false}
                      disabled={!pickable(c.id) || (!(props.plan?.includes(c.id)) && (props.plan?.length ?? 0) >= MAX_PARTICIPANTS - 1)}
                      onChange={() => toggle(c.id)} />
                    <span classList={{ muted: !pickable(c.id) }}>{c.name}</span>
                  </label>
                  <Switch>
                    <Match when={props.nodeMeets && !c.connected}><span class="hint" data-meeting-pick-note={c.id}>{' '}{tr('caNotConnected')}</span></Match>
                    <Match when={props.nodeMeets && !c.meetings}><span class="hint" data-meeting-pick-note={c.id}>{' '}{tr('caNeedsUpdate')}</span></Match>
                    <Match when={quotes[c.id] === undefined}><span class="hint" data-meeting-pick-note={c.id}>{' '}{tr('roomReadingPrice')}</span></Match>
                    <Match when={!priced(c.id)}><span class="hint" data-meeting-pick-note={c.id}>{' '}{tr('caDoesNotTakeCalls')}</span></Match>
                  </Switch>
                </li>
              )}
            </For>
          </ul>
          <Show when={!props.nodeMeets}><p class="hint" data-meeting-node-update>{tr('caYourNodeNeedsAnUpdateBeforeItCanHold590')}</p></Show>
          <Show when={props.blocked}><p class="hint" data-meeting-blocked>{tr('caPaymentsAreNotReadyYetSoNobodyCanBe')}</p></Show>
          <p class="hint" data-meeting-note>{tr('caYouRingEachPersonYouPickTheirCallPrice')}</p>
          <div class="call-actions">
            <button type="button" class="primary soft money" data-meeting-invite disabled={planCost() === null} onClick={() => props.invite(props.plan!, 'audio', shown(props.plan!))}
              aria-label={tr('caInviteExtra500', planCost() !== null ? tr('uiUpTo', fmtAmount(planCost()!)) : '')}>
              {tr('caInvite')}{price(planCost())}
            </button>
            <button type="button" class="soft" data-meeting-invite-video disabled={planCost() === null} onClick={() => props.invite(props.plan!, 'video', shown(props.plan!))}
              aria-label={tr('caVideoInvite', planCost() !== null ? tr('uiUpTo', fmtAmount(planCost()!)) : '')}>
              {tr('caVideoInvite597')}{price(planCost())}
            </button>
            <button type="button" class="soft" data-meeting-cancel onClick={() => props.setPlan(null)}>{tr('cancel')}</button>
          </div>
        </aside>
      </Show>
      <Show when={v().phase !== 'idle' && !planning()}>
        <aside class="call-panel meeting-panel" data-meeting-panel={v().phase} role="dialog" aria-label={tr('caMeetingPhase', tr(({ idle: 'caMeetingIdle', invited: 'caMeetingInvited', active: 'caMeetingActive', ended: 'caMeetingEndedPhase' } as const)[v().phase]))}>
          <header>
            <strong data-meeting-title>{v().phase === 'invited' ? tr('caMeetingInvite') : v().phase === 'ended' ? tr('caMeetingEnded') : tr('caMeetingPeople', v().roster.length)}</strong>
            <span class="who">{v().phase === 'invited' ? tr('caInvitesYouWith', host(), others() || tr('caNobodyElse')) : ''}</span>
          </header>
          <Show when={v().phase === 'active' || (v().phase === 'ended' && v().legs.length > 0)}>
            <ul class="meeting-legs">
              <For each={v().legs}>
                {(l) => (
                  <li data-meeting-leg={l.peer} data-leg-state={l.state}>
                    <strong>{props.nameOf(l.peer)}</strong> <span class="hint">{LEG_STATE[l.state]}{l.error && (l.state === 'nolink' || l.state === 'ended') ? ` · ${l.error}` : ''}</span>
                    <MediaView stream={props.streams.remote[l.peer] ?? null} video={v().media === 'video'} muted={false} kind="remote" />
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={v().phase === 'invited'}>
            <p class="hint" data-meeting-ignore>{tr('caIgnoreItNothingIsPaidAndTheInviteEnds')}</p>
          </Show>
          {/* Receipts carry each signal's ceiling, not settled fees: "up to" is the honest total. */}
          <Switch>
            {/* Something is still in flight: never "paid nothing" (or a final total) until it settles. */}
            <Match when={v().pendingCount > 0}>
              <p class="hint" data-meeting-paid="pending">
                {v().paidMsat > 0 ? tr('caPaidUpToSoFarForThisMeetingS', fmtAmount(v().paidMsat)) : ''}
                {v().unknownCount > 0 ? tr('uiCheckPendingResult', v().unknownCount === 1 ? tr('uiOneSignalSResultIsNotKnownYet') : tr('uiSignalsResultsAreNotKnownYet', v().unknownCount)) : ''}
                {v().pendingCount === 1 ? tr('caAPaymentForThisMeetingIsStillSettling') : tr('caPaymentsForThisMeetingAreStillSettling', v().pendingCount)}{tr('uiUpTo126')}{' '}{fmtAmount(v().pendingMsat)}{tr('uiTheTotalUpdatesWhen')}{' '}{v().pendingCount === 1 ? tr('uiItFinishes') : tr('uiTheyFinish')}{tr('caMediaIsNotBilled')}</p>
            </Match>
            <Match when={v().unknownCount > 0}>
              <p class="hint" data-meeting-paid="unknown">
                {v().paidMsat > 0 ? tr('caPaidUpToForThisMeetingSSignals', fmtAmount(v().paidMsat)) : tr('caNoPaymentForThisMeetingIsConfirmed')}{' '}
                {v().unknownCount === 1 ? tr('uiOneSignalSResultIsNotKnownYet') : tr('uiSignalsResultsAreNotKnownYet', v().unknownCount)}{' '}{tr('uiUpTo133')}{' '}{fmtAmount(v().paidMsat + v().unknownMsat)}{' '}{tr('uiInAllIf')}{' '}{v().unknownCount === 1 ? tr('itPronoun') : tr('theyPronoun')}{' '}{tr('caWentThroughCheckPendingResultMediaIsNotBilled')}</p>
            </Match>
            <Match when={v().paidMsat > 0}>
              <p class="hint" data-meeting-paid="settled">{tr('caPaidUpTo')}{' '}{fmtAmount(v().paidMsat)}{' '}{tr('caForThisMeetingSSignalsEachSignalSPrice')}</p>
            </Match>
            <Match when={v().phase === 'ended'}>
              <p class="hint" data-meeting-paid="nothing">{tr('caThisMeetingPaidNothing')}</p>
            </Match>
          </Switch>
          <Show when={v().phase === 'ended' && v().error}>
            <p class="hint" data-meeting-ended>{v().error}</p>
          </Show>
          <div class="call-actions">
            <Switch>
              <Match when={v().phase === 'invited'}>
                <button type="button" class="primary soft money" data-meeting-join disabled={props.blocked || joinPrice() === null} onClick={() => props.join(shown(v().roster))}
                  aria-label={tr('caJoinExtra506', joinPrice() !== null ? tr('uiUpTo', fmtAmount(joinPrice()!)) : '')}>
                  {tr('caJoin')}{price(joinPrice())}
                </button>
                <button type="button" class="soft" data-meeting-decline disabled={props.blocked || declinePrice() === null} onClick={() => props.decline(shown(v().roster))}
                  aria-label={tr('caDecline', declinePrice() !== null ? tr('uiUpTo', fmtAmount(declinePrice()!)) : '')}>
                  {tr('uiDecline')}{declinePrice() !== null ? tr('caUpTo', sats(declinePrice()!), satUnit(declinePrice()!)) : ''}
                </button>
              </Match>
              <Match when={v().phase === 'active'}>
                <button type="button" class="soft" data-meeting-mute aria-pressed={v().muted} onClick={() => props.mute()}>{tr('uiMute')}</button>
                <Show when={v().media === 'video'}>
                  <button type="button" class="soft" data-meeting-camera aria-pressed={v().camera} onClick={() => props.camera()}>{tr('uiCamera')}</button>
                </Show>
                <button type="button" class="danger soft" data-meeting-leave onClick={() => props.leave()}>{tr('roomLeave')}</button>
              </Match>
              <Match when={v().phase === 'ended'}>
                <button type="button" class="soft" data-meeting-dismiss disabled={v().pendingCount > 0} title={v().pendingCount > 0 ? tr('uiClosesOnceThePaymentHasSettled') : undefined} onClick={() => props.dismiss()}>{tr('uiClose')}</button>
              </Match>
            </Switch>
          </div>
        </aside>
      </Show>
    </>
  );
}

/** Inline player for a voice note. Loads on first tap (read-only), then plays in place. */
/** Host error for a message whose file is not audio (act.rs NOT_A_VOICE_NOTE). */
const NOT_A_VOICE_NOTE = 'not a voice note';
const FILE_TOO_LARGE = 'file over 1.4 MB';
/** The response passed the read limit; the file's own size is unknown (act.rs). */
const FILE_RESPONSE_TOO_LARGE = 'response too large to load safely';
const FILE_NOT_STORED = 'not stored';

/** One native save dialog across all bubbles (host also guards). */
let saveDialogOpen = false;

type FileMeta = { filename: string; mime_type: string; size_bytes: number };

/** A received kind-200 file: size/type, optional safe image preview, Save via native dialog. */
function ReceivedFile(props: {
  id: string;
  name: string;
  voice?: (messageId: string) => Promise<string>;
  loadFile: (messageId: string) => Promise<VoiceBlob>;
  save: (messageId: string) => Promise<FileSaveResult>;
}) {
  const [meta, setMeta] = createSignal<FileMeta | null>(null);
  const [err, setErr] = createSignal<'gone' | 'large' | 'response' | 'save' | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [preview, setPreview] = createSignal<string | null>(null);

  /** Fetch only for a likely safe image preview — never for voice, never for every bubble. */
  const loadPreview = async () => {
    if (props.voice || meta() || err() || preview()) return;
    if (!looksLikeSafeImageName(props.name)) return;
    setBusy(true);
    try {
      const blob = await props.loadFile(props.id);
      setMeta({ filename: blob.filename, mime_type: blob.mime_type, size_bytes: blob.size_bytes });
      const mime = safeImageMime(blob.mime_type);
      if (mime) setPreview(dataImageUrl(blob.data_b64, mime));
    } catch (e) {
      const s = String(e);
      if (s.includes(FILE_TOO_LARGE)) setErr('large');
      else if (s.includes(FILE_RESPONSE_TOO_LARGE)) setErr('response');
      else if (s.includes(FILE_NOT_STORED)) setErr('gone');
      // Other preview failures leave Save available.
    } finally {
      setBusy(false);
    }
  };

  onMount(() => { void loadPreview(); });

  const onSave = async () => {
    if (err() === 'large' || err() === 'response' || err() === 'gone' || busy() || saveDialogOpen) return;
    saveDialogOpen = true;
    setBusy(true);
    try {
      const r = await props.save(props.id);
      if (r.saved) {
        setSaved(true);
        setMeta({ filename: r.filename, mime_type: r.mime_type, size_bytes: r.size_bytes });
        if (err() === 'save') setErr(null);
      }
    } catch (e) {
      const s = String(e);
      if (s.includes(FILE_TOO_LARGE)) setErr('large');
      else if (s.includes(FILE_RESPONSE_TOO_LARGE)) setErr('response');
      else if (s.includes(FILE_NOT_STORED)) setErr('gone');
      else setErr('save');
    } finally {
      setBusy(false);
      saveDialogOpen = false;
    }
  };

  return (
    <div class="received-file" data-received-file={props.id}>
      <Show when={props.voice}>
        <VoiceNote id={props.id} name={props.name} load={props.voice!} />
      </Show>
      <Show when={!props.voice}>
        <span class="file-name" data-file-name>{props.name}</span>
      </Show>
      <Show when={preview()}>
        <img class="file-preview" data-file-preview src={preview()!} alt="" />
      </Show>
      <p class="file-meta" data-file-meta>
        <Show when={err() === 'large' || err() === 'response'} fallback={
          <Show when={meta()} fallback={busy() ? '…' : ''}>
            {(b) => <>{kb(b().size_bytes)} · {shortMime(b().mime_type)}</>}
          </Show>
        }>
          {err() === 'large' ? tr('caOver14MBNotSaved') : tr('caResponseTooLargeNotSaved')}</Show>
        <Show when={err() === 'gone'}>{' '}{tr('caNotStored')}</Show>
        <Show when={err() === 'save'}>{' '}{tr('caCouldNotSave')}</Show>
      </p>
      <Show when={err() !== 'large' && err() !== 'response' && err() !== 'gone'}>
        <button type="button" class="link" data-file-save disabled={busy() || saved()} onClick={() => void onSave()}>
          {saved() ? tr('caSaved641') : busy() ? '…' : tr('extraSave')}
        </button>
      </Show>
    </div>
  );
}

function shortMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m.startsWith('image/')) return m.slice(6) || tr('caImageExtra517');
  if (m.startsWith('audio/')) return m.slice(6) || tr('caAudio');
  if (m.startsWith('text/')) return m.slice(5) || tr('caText');
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/octet-stream') return tr('fileNoun');
  return m || tr('fileNoun');
}

function VoiceNote(props: { id: string; name: string; load: (messageId: string) => Promise<string> }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Why it cannot play: the file is gone, too large, or not audio despite its name.
  const [missing, setMissing] = createSignal<'gone' | 'large' | 'response' | 'not_audio' | null>(null);
  const open = async () => {
    setBusy(true);
    try {
      setUrl(await props.load(props.id));
    } catch (e) {
      const s = String(e);
      setMissing(s.includes(NOT_A_VOICE_NOTE) ? 'not_audio' : s.includes(FILE_TOO_LARGE) ? 'large' : s.includes(FILE_RESPONSE_TOO_LARGE) ? 'response' : 'gone');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="voice-note" data-voice-note={props.id}>
      <Show
        when={url()}
        fallback={
          <button type="button" class="voice-play" data-voice-play disabled={busy() || missing() !== null} onClick={() => void open()}>
            {missing() === 'not_audio'
              ? tr('caFileNotAudioNotPlayed', props.name)
              : missing() === 'large' ? tr('caVoiceNoteOver14MB')
              : missing() === 'response' ? tr('caVoiceNoteResponseTooLarge')
              : missing() === 'gone' ? tr('caVoiceNoteNotStoredOnThisDevice') : busy() ? tr('chatLoading') : tr('caVoiceNote')}
          </button>
        }
      >
        <audio controls autoplay preload="auto" src={url()!} data-voice-audio />
      </Show>
    </span>
  );
}

/** A send whose money is not settled either way, named on its card. Never "not sent". */
const FAILURE_LABEL: Partial<Record<ActionError['code'], string>> = {
  get spend_unknown() { return tr('caOutcomeUnknownPending'); },
  get payment_unknown() { return tr('caPaymentUnknownNotResent'); },
  get failed_paid() { return tr('caPaidRefusedByTheirNode649'); },
};

const DELIVERY_TEXT: Record<Delivery['status'], string> = {
  get accepted() { return tr('chatDelivered'); },
  get sent() { return tr('extraSent'); },
  get queued() { return tr('chatQueued'); },
  get delivered() { return tr('chatDelivered'); },
  get rejected() { return tr('chatRejected'); },
};

/** Single ✓ when acked/delivered; other states keep one short word (details in title). */
function DeliveryMark(props: { d: Delivery }) {
  const tick = () => props.d.status === 'accepted' || props.d.status === 'delivered';
  const label = () => {
    const base = DELIVERY_TEXT[props.d.status];
    return props.d.reason ? `${base}: ${props.d.reason}` : base;
  };
  return (
    <span class="delivery" data-delivery={props.d.status} title={label()} aria-label={label()}>
      <Show when={!tick()}>
        {DELIVERY_TEXT[props.d.status]}
        <Show when={props.d.reason}>: {props.d.reason}</Show>
      </Show>
    </span>
  );
}

/**
 * The membrane in the stream. A stranger who paid to reach you, a verified sender
 * refused at your door, or your send refused at theirs. Stated as facts; no
 * button that would admit, add or pay.
 */
function DoorView(props: { card: DoorCard; at: number; nameOf: (id: string) => string }) {
  const c = props.card;
  const amt = (msat: number) => (
    <>
      <span class="sats">{sats(msat, true)}</span> {satUnit(msat)}
    </>
  );
  return (
    <div class="door-card" data-door={`${c.side}-${c.verdict}`} data-code={c.side === 'out' ? c.code : undefined} classList={{ refused: c.verdict === 'refused' }} role="note">
      <p class="door-rule">
        <span>{clock(props.at)}{' '}{tr('caDoor')}</span>
      </p>
      <Switch>
        <Match when={c.side === 'in' && c.verdict === 'admitted' && (c as Extract<DoorCard, { verdict: 'admitted' }>)}>
          {(x) => (
            <>
              <p class="door-head">
                <span class="id" title={x().sender}>{shortId(x().sender)}</span>{' '}{tr('uiPaid')}{' '}<Show when={x().paid_msat !== null} fallback={tr('caYourPriceLower')}>{amt(x().paid_msat!)}</Show>{' '}{tr('caToReachYou')}</p>
              <p class="door-proof">{tr('caSettledRecipientBoundSingleUse')}</p>
              <p class="door-note">{tr('caNotAContactAndNotAddedNothingIsKept')}</p>
            </>
          )}
        </Match>
        <Match when={c.side === 'in' && c.verdict === 'refused' && (c as Extract<DoorCard, { side: 'in'; verdict: 'refused' }>)}>
          {(x) => (
            <>
              <p class="door-head">
                {tr('caRefusedAtYourDoor')}{' '}{gateWords(x().code)}
              </p>
              <p class="door-proof">
                <Show when={x().required_msat !== null}>{tr('caNeeded656')}{' '}{amt(x().required_msat!)}</Show>
                <Show when={x().required_msat !== null && x().paid_msat !== null}> · </Show>
                <Show when={x().paid_msat !== null}>{tr('uiPaid')}{' '}{amt(x().paid_msat!)}</Show>
              </p>
              <p class="door-note">{tr('caSignedBy')}{' '}{props.nameOf(x().sender)}{tr('caNothingWasStoredOrDelivered')}</p>
            </>
          )}
        </Match>
        <Match when={c.side === 'out' && (c as Extract<DoorCard, { side: 'out' }>)}>
          {(x) => (
            <>
              <Show
                when={x().code === 'readmission_capped'}
                fallback={
                  <>
                    <p class="door-head">{tr('caNotSentTheirPriceIsAboveYourCap')}</p>
                    <p class="door-proof">{x().detail}</p>
                    <p class="door-note">{tr('caNothingWasPaidReopenTheTrackToReadTheir')}</p>
                  </>
                }
              >
                <p class="door-head">{tr('caNotSentTheyAskForAdmissionAgain')}</p>
                <p class="door-proof">{x().detail}</p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function ArtifactView(props: { callActions?: Actions; moneyBlocked: boolean; a: Artifact; delivery?: Delivery; nameOf: (id: string) => string; /** The same offline signal the header call buttons get, so Call back re-reads the price when they are back. */ offlineOf?: (id: string) => boolean; onRetry?: (id: string, approvedMsat?: number) => Promise<unknown>; onStop?: (pendingId: string | null) => Promise<unknown>; onRestore?: (id: string) => void; onDiscard?: (id: string) => void }) {
  return (
    <Switch>
      <Match when={props.a.type === 'missed-call' && props.a}>
        {a => {
          const call = () => a() as Extract<Artifact, { type: 'missed-call' }>;
          return <article class="msg in" data-missed-call={call().id}>
            <div class="bubble">{tr('incomingMissed')}</div>
            <time class="stamp" datetime={new Date(call().at).toISOString()}>{clock(call().at)}</time>
            <Show when={props.callActions}>{actions => <CallButtons peer={call().peer} name={props.nameOf(call().peer)}
              blocked={props.moneyBlocked} actions={actions()} callbackMedia={call().media} offline={props.offlineOf?.(call().peer) ?? false} />}</Show>
          </article>;
        }}
      </Match>
      <Match when={props.a.type === 'unsent' && props.a}>
        {(a) => {
          const u = () => a() as Extract<Artifact, { type: 'unsent' }>;
          return (
            <article class="msg out unsent" data-unsent={u().why}>
              <div class="bubble">{u().text}</div>
              <div class="stamp">
                <span class="sats" data-unsent-reason>{u().why === 'held' ? tr('chatWaitingForPaymentCheck') : tr('chatNotSentNothingPaid')}{u().reason}</span>
              </div>
              <div class="unsent-actions">
                <button type="button" class="link" data-unsent-restore onClick={() => props.onRestore?.(u().id)}>{tr('chatPutBackInTheBox')}</button>
                <button type="button" class="link" data-unsent-discard onClick={() => props.onDiscard?.(u().id)}>{tr('chatDiscard')}</button>
              </div>
            </article>
          );
        }}
      </Match>
      <Match when={props.a.type === 'sending' && props.a}>
        {(a) => {
          const m = () => a() as Extract<Artifact, { type: 'sending' }>;
          return (
            <article class="msg out sending" data-sending={m().waiting ? 'waiting' : ''} aria-busy="true">
              <div class="bubble">{m().text}</div>
              <div class="stamp">
                <span class="sats" data-sending-cap={m().capMsat}>{m().waiting ? (m().waitWord === 'allowed' ? tr('chatSendsWhenAllowed') : tr('chatSendsWhenApproved')) : tr('chatSending')} {tr('chatUpTo')} {fmtAmount(m().capMsat, true)}</span>
              </div>
            </article>
          );
        }}
      </Match>
      <Match when={props.a.type === 'invoice' && props.a}>
        {(a) => {
          const inv = () => (a() as Extract<Artifact, { type: 'invoice' }>).invoice;
          const qr = createMemo(() => {
            try {
              return qrSvg(inv().bolt11.toUpperCase());
            } catch {
              return null;
            }
          });
          return (
            <div class="artifact out" data-artifact="invoice">
              <span class="kind">{tr('chatInvoiceYouReceive')}</span>
              <span class="sats big">{sats(inv().amount_msat, true)} <span class="unit">{satUnit(inv().amount_msat)}</span></span>
              <Show when={inv().note}>
                <span class="hint">{inv().note}</span>
              </Show>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label={tr('chatInvoiceAsAQRCode')}>
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <code class="address" data-bolt11>{inv().bolt11}</code>
              <span class="hint">{tr('chatExpiresAt')} {clock(inv().expires_at_ms)}{tr('chatPayingItSendsSatsToYourNode')}</span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'payment' && props.a}>
        {(a) => {
          const r = () => (a() as Extract<Artifact, { type: 'payment' }>).receipt;
          return (
            <div class="artifact out payment-line" data-artifact="payment" data-status={r().status} data-pay-method={r().method}>
              <span class="stamp">
                <Bolt />
                <Show
                  when={r().status !== 'failed'}
                  fallback={<span class="err-note">{tr('chatPaymentOf')} <span class="sats">{sats(r().amount_msat, true)}</span> {satUnit(r().amount_msat)} {tr('chatFailed')}</span>}
                >
                  <span>{tr('chatYouSent')} <span class="sats">{sats(r().amount_msat, true)}</span> {satUnit(r().amount_msat)}{r().method === 'keysend' ? tr('chatDirectKeysend') : ''}</span>
                </Show>
                <span class="hint">{clock(r().paid_at_ms)}</span>
              </span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'file' && props.a}>
        {(a) => {
          const r = () => (a() as Extract<Artifact, { type: 'file' }>).receipt;
          return (
            <div class="artifact out" data-artifact="file">
              <span class="kind">{tr('extraFile')}</span>
              <span class="file-name">{r().filename} <span class="hint">{kb(r().size_bytes)}</span></span>
              <span class="stamp">
                <Bolt />
                <span class="sats">{sats((r().total_msat ?? r().amount_msat + (r().max_routing_fee_msat ?? 0)), true)}</span>
                <span>{satUnit((r().total_msat ?? r().amount_msat + (r().max_routing_fee_msat ?? 0)))} {tr('chatAllInCeiling')}{feeCeiling(r().max_routing_fee_msat ?? 0)}) · {clock(r().sent_at_ms)}</span>
                <Show when={props.delivery}>
                  <DeliveryMark d={props.delivery!} />
                </Show>
              </span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'door' && props.a}>
        {(a) => <DoorView card={(a() as Extract<Artifact, { type: 'door' }>).door} at={a().at} nameOf={props.nameOf} />}
      </Match>
      <Match when={props.a.type === 'failed' && props.a}>
        {(a) => {
          const f = () => a() as Extract<Artifact, { type: 'failed' }>;
          return (
            <div class="artifact out failed" data-artifact="failed" data-code={f().error.code}>
              <span class="kind">{f().action}</span>
              <span>{f().error.message}</span>
              <Show when={f().text !== undefined}>
                {/* The whole message stays readable here; no resend while the payment result is open. */}
                <blockquote class="failed-text" data-failed-text>{f().text}</blockquote>
                <Show when={!provenUnpaid(f().error.code) && f().error.code !== 'payment_settled_undelivered' && f().error.code !== 'failed_paid' && !f().confirmedBy && (!f().op || OPEN_OP.has(f().op!.state))}>
                  <span class="hint" data-failed-check>{tr('chatCheckPendingResultBeforeSendingItAgain')}</span>
                </Show>
              </Show>
              <Show when={!f().confirmedBy && f().op && !OPEN_OP.has(f().op!.state) && f().op}>
                {(op) => <span class="hint" data-failed-op={op().state}>{opStateText(op(), tr('chatThisAppSRecordOfThePaymentNamed'))}</span>}
              </Show>
              <Show when={f().confirmedBy}>
                <span class="hint" data-failed-confirmed={f().confirmedBy}>{tr('chatThePaymentNamedHereNowHasAReceipt')}</span>
              </Show>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'restored' && props.a}>
        {(a) => {
          const op = () => (a() as Extract<Artifact, { type: 'restored' }>).op;
          return (
            <div class="artifact out failed" data-artifact="restored" data-op-state={op().state}>
              <span class="kind">{tr('chatMessageSentBeforeThisAppRestarted')}</span>
              <span>{tr('uiUpTo105')} {sats(op().cap_msat)} {satUnit(op().cap_msat)}{tr('chatThisAppKeepsNoCopyOfTheWords')}</span>
              <span class="hint" data-restored-state>{opStateText(op())}</span>
            </div>
          );
        }}
      </Match>
      <Match when={props.a.type === 'undelivered' && props.a}>
        {(a) => <UndeliveredView moneyBlocked={props.moneyBlocked} a={a() as Extract<Artifact, { type: 'undelivered' }>} onRetry={props.onRetry} onStop={props.onStop} />}
      </Match>
    </Switch>
  );
}

/**
 * Paid, not delivered: the amount, what not to do, and the one safe retry.
 * When admission may be due again, the retry waits for the owner to approve
 * the shown price; stopping retries releases the message without paying more.
 */
function UndeliveredView(props: {
  moneyBlocked: boolean;
  a: Extract<Artifact, { type: 'undelivered' }>;
  onRetry?: (id: string, approvedMsat?: number) => Promise<unknown>;
  onStop?: (pendingId: string | null) => Promise<unknown>;
}) {
  const [busy, setBusy] = createSignal(false);
  usePairingActivity(() => busy() || !!props.a.ownerApproval);
  const copy = () => undeliveredCopy(props.a.paid);
  const run = async (f: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    await f();
    setBusy(false);
  };
  return (
    <div class="artifact out failed" data-artifact="undelivered" data-paid-msat={props.a.paid.paid_msat}>
      <span class="kind">{copy().title}</span>
      <span data-undelivered-line>{copy().body}</span>
      <details class="quiet-detail" data-undelivered-detail>
        <summary>{tr('uiDetails')}</summary>
        <p>{copy().detail}</p>
      </details>
      <Show when={props.a.paid.retry && props.onRetry}>
        <Show
          when={props.a.admission}
          fallback={
            <button type="button" class="link" data-retry-delivery disabled={props.moneyBlocked || busy()} onClick={() => void run(() => props.onRetry!(props.a.id))}>
              {busy() ? tr('caRetrying') : tr('caRetryDelivery')}
            </button>
          }
        >
          {(adm) => (
            <>
              <p class="hint" data-admission-price={adm().total_msat} data-admission-line>{admissionCopy(adm()).body}</p>
              <details class="quiet-detail" data-admission-detail>
                <summary>{tr('uiDetails')}</summary>
                <p>{admissionCopy(adm()).detail}</p>
              </details>
              <button type="button" class="link" data-retry-approve disabled={props.moneyBlocked || busy()} onClick={() => void run(() => props.onRetry!(props.a.id, adm().total_msat))}>
                {busy() ? tr('caChecking') : props.a.ownerApproval ? tr('caCheckApprovalAndRetry') : admissionCopy(adm()).action}
              </button>
            </>
          )}
        </Show>
      </Show>
      <Show when={props.onStop}>
        <button type="button" class="link" data-stop-retrying disabled={busy()} onClick={() => void run(() => props.onStop!(props.a.pendingId))}>
          {tr('uiStopRetrying')}</button>
      </Show>
      <Show when={props.a.ownerApproval}>
        {(approval) => <div data-retry-owner><p>{tr('caApproveAtYourNodeThenCheck')}</p><OperatorDetails><code class="address">{approval().owner_command}</code></OperatorDetails></div>}
      </Show>
      <Show when={props.a.note}>
        <p class="hint" data-retry-note>{props.a.note}</p>
      </Show>
    </div>
  );
}

/**
 * What an approval action's own result says (#227). `requestId`: the node
 * request it made or continued; `grantedOp`: the grant op of the window this
 * very call armed. Only these bind an Approve & send; nothing observed later
 * does. `bindable`: the host reports these ids at all (absent on older hosts).
 */
export type ApprovalResult = { ok: boolean; requestId: string | null; grantedOp: string | null; bindable: boolean; waiting: boolean; readsFrom?: number };
/**
 * A Touch ID contact approval. `envelopeId`: the node envelope the action
 * itself returned (relation_envelope_id_v1); null without one. `readsFrom`:
 * only budget reads stamped at or after this started after the approval
 * returned, so only they can confirm or replace that envelope.
 */
export type TouchApproval = { ok: boolean; envelopeId: string | null; readsFrom: number };
const approvalResult = (r: Outcome<SpendView | BudgetView>): ApprovalResult => r.ok
  ? {
      ok: true, requestId: r.value.request_id ?? null, grantedOp: r.value.granted_op ?? null, bindable: 'granted_op' in r.value,
      // Taken, but still waiting for the owner at the node (a budget request, or a pending spend request).
      waiting: 'waiting_for_owner' in r.value ? r.value.waiting_for_owner === true : (r.value as SpendView).state === 'pending',
    }
  : { ok: false, requestId: null, grantedOp: null, bindable: false, waiting: false };

/** How long an Approve & send press waits for its approval before it ends unsent. */
const CONTINUE_MS = 10 * 60_000;
/** The draft was paid for: it now lives on the undelivered card, not in the composer. */
const paidUndelivered = (r: Outcome<unknown>) => !r.ok && r.error.code === 'payment_settled_undelivered';
/** Outcomes where sats may have moved or the result is not known: never "try again". */
/** Each composer instance's id: text goes back only into the instance it was typed in. */
let composerSeq = 0;
/** How far before a press a node timestamp may be and still be that send's echo (clock skew). */
const ECHO_SKEW_MS = 120_000;
/** Op states whose result the host has not established. */
const OPEN_OP = new Set<OperationState>(['dispatching', 'unknown']);
/** Op states the host still treats as unfinished: restored after a restart, each said as it is. */
const RESTORE_OP = new Set<OperationState>(['dispatching', 'unknown', 'paid', 'paid_undelivered', 'admission_resumable']);
/**
 * The host's record of an operation, in accounting terms only (`paid_msat`
 * absent: amount not known). `settled` also covers a paid message whose
 * retries were stopped, so it never says "sent" or "delivered".
 */
export function opStateText(op: OpView, subject = tr('caThisAppSRecord')): string {
  const paid = op.paid_msat === null ? tr('caAnUnknownAmount') : `${sats(op.paid_msat)} ${satUnit(op.paid_msat)}`;
  switch (op.state) {
    case 'dispatching': case 'unknown': return tr('caTheResultIsNotKnownYetCheckPendingResult', subject);
    case 'admission_resumable': return tr('caAdmissionPaidMessageNotSentSendTheSameMessage', subject, paid);
    case 'unpaid': return tr('caNotPaidNothingLeftYourWalletForIt', subject);
    case 'paid': return tr('caPaidDeliveryNotConfirmedYetCheckPendingResult', subject, paid);
    case 'paid_undelivered': return tr('caPaidNotDeliveredCheckPendingResultToRetryDelivery', subject, paid);
    case 'failed_paid': return tr('caPaidTheirNodeRefusedIt', subject, paid);
    case 'settled': return tr('caPaidFinishedDeliveryIsNotConfirmedHere', subject, paid);
    case 'closed': return tr('caClosed', subject);
    default: return tr('caCouldNotBeRead', subject);
  }
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

/** `sats` or `BTC`: the unit typed amounts are read in. */
const unitName = () => (denom() === 'btc' ? 'BTC' : 'sats');

/** Amount first: one big field in the chosen denomination. Refuses, never rounds, a finer amount. */
function AmountField(props: { data: 'pay' | 'request'; label: string; value: string; onInput: (v: string) => void; cleared?: boolean }) {
  /** Why the typed amount cannot be used, before any review. */
  const problem = (): string | null => {
    if (props.value.trim() === '') return null;
    if (ambiguousThousands(props.value, denom())) return tr('amountUseSpaces');
    const msat = parseAmount(props.value, denom());
    if (msat === null) return tr('uiUseDigitsAndOneDotAtMostDecimals', denom() === 'btc' ? 11 : 3);
    return inPaymentBounds(msat) ? null : tr('uiBetweenAnd', fmtAmount(MIN_PAYMENT_MSAT), fmtAmount(MAX_PAYMENT_MSAT));
  };
  const invalid = () => problem() !== null;
  return (
    <>
      <label class="amount-field" classList={{ invalid: invalid() }}>
        <input
          ref={(el) => queueMicrotask(() => el.isConnected && el.focus())}
          data-pay-amount={props.data === 'pay' ? '' : undefined}
          data-request-amount={props.data === 'request' ? '' : undefined}
          class="amount-input"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          aria-label={tr('uiIn', props.label, unitName())}
          aria-invalid={invalid()}
        />
        <span class="amount-unit">{unitName()}</span>
      </label>
      <Show when={props.cleared}><p class="hint" role="status" data-amount-cleared>{tr('amountDraftCleared')}</p></Show>
      <Show when={invalid()}>
        <p class="hint" data-amount-invalid>{problem()}</p>
      </Show>
    </>
  );
}

type Reconciliation = PaymentFacts & { text: string; pendingId: string | null };

/** A direct payment owned by one call card; never enters the call engine. */
function InCallPay(props: {
  callId: string;
  reconciliation: Reconciliation | null;
  view: CallView;
  nameOf: (id: string) => string;
  lightningId: string | null;
  blocked: boolean;
  pending: boolean;
  spend: SpendView | null;
  spendError: string | undefined;
  now: number;
  actions: Actions;
  /** False on a node-routed call: no Pay button on the short call card. Receipts and the pending check stay. */
  entry?: boolean;
}) {
  // The keyed parent remounts for a new call. A late receipt stays with this call.
  const peer = props.view.peer!;
  const [expanded, setExpanded] = createSignal(false);
  const [amount, setAmount, amountCleared] = createAmountDraft({ clearOnUnitChange: true });
  const [busy, setBusy] = createSignal(false);
  const [approving, setApproving] = createSignal(false);
  const [result, setResult] = createSignal<{ state: 'sent' | 'failed' | 'unknown' | 'checked'; text: string } | null>(null);
  const destination = createMemo(() => props.lightningId && /^(02|03)[0-9a-f]{64}$/i.test(props.lightningId) ? props.lightningId.toLowerCase() : null);
  const live = () => props.view.callId === props.callId && props.view.peer === peer && props.view.phase === 'live';
  const open = () => spendLine(props.spend, props.now).open;
  const msat = () => {
    const parsed = parseAmount(amount(), denom());
    return parsed !== null && inPaymentBounds(parsed) ? parsed : null;
  };
  const blocked = () => props.blocked || props.pending || busy() || result()?.state === 'unknown';
  // A successful check from wallet/chat has the same authority as this card's
  // check. Only a new check clears an existing unknown; old checks cannot clear
  // a later payment, and a failed check never changes this signal.
  createEffect(on(() => props.reconciliation, checked => {
    if (checked?.fenceCleared && result()?.state === 'unknown') setResult({ state: 'checked', text: checked.text });
  }, { defer: true }));
  usePairingActivity(() => expanded() || busy() || approving());
  // Their hangup ended the call while a minute was being paid, and nothing was
  // ended at the host for it: its pending record holds every paid action. The
  // same check as the link below runs once by itself. The line and an action stay
  // until the host has let go of that record. End answers for itself.
  const [minuteSettled, setMinuteSettled] = createSignal(false);
  // The pending record to stop retrying: the check found the minute paid, not delivered.
  const [minuteStopId, setMinuteStopId] = createSignal<string | null>(null);
  const minuteOpen = () => props.view.callId === props.callId && props.view.phase === 'ended'
    && (props.view.minutes?.lostMinute === true || props.view.minutes?.undeliveredMinute === true) && !minuteSettled()
    && (props.view.close === null || props.view.close.status === 'refused');
  // The record a check on this card showed, else the one the host named when the minute came back undelivered.
  const minuteStop = () => minuteStopId() ?? props.view.minutes?.undeliveredPendingId ?? null;
  // The line asks to stop retrying only when that action is on the card.
  const minuteUndelivered = () => minuteStop() !== null;
  const minuteClosed = (text: string) => {
    if (!minuteOpen()) return;
    setMinuteSettled(true);
    setResult({ state: 'checked', text });
  };
  // The call's view updates about once a second after it ends; this runs for one
  // of those only. A failed check stays failed until the owner asks again.
  let minuteCheckStarted = false;
  createEffect(() => {
    if (!minuteOpen() || minuteCheckStarted) return;
    minuteCheckStarted = true;
    void props.actions.reconcile();
  });
  // Any card's check or dismissal counts here. The line goes only when the host has
  // let go of the record: a payment known and still held keeps it, with its action.
  // Only a record shown while the line is up is this minute's: one checked or
  // stopped earlier in the call never is.
  createEffect(on(() => props.reconciliation, (checked) => {
    if (checked?.fenceCleared) {
      setMinuteStopId(null);
      minuteClosed(checked.text);
    } else if (checked?.pendingId && minuteOpen()) setMinuteStopId(checked.pendingId);
  }, { defer: true }));
  createEffect(on(props.actions.pendingRevision, () => setMinuteStopId(null), { defer: true }));
  // A new unit or mapping requires a new amount; never reinterpret a visible draft.
  createEffect(on(destination, () => setAmount(''), { defer: true }));
  createEffect(() => { if (!live()) { setExpanded(false); setAmount(''); } });
  const pay = async () => {
    const dest = destination();
    const value = msat();
    if (!live() || !expanded() || blocked() || !open() || !dest || value === null) return;
    // Consume the displayed amount synchronously, before the host can yield.
    setBusy(true);
    setExpanded(false);
    setAmount('');
    setResult(null);
    try {
      const r = await props.actions.keysend({ kind: 'peer', id: peer }, dest, value, '');
      if (r.ok) {
        setResult(r.value.status === 'settled'
          ? { state: 'sent', text: tr('uiSentTo', fmtAmount(r.value.amount_msat), props.nameOf(peer)) }
          : r.value.status === 'failed'
            ? { state: 'failed', text: tr('uiPaymentOfFailedNoAmountOrRoutingFee', fmtAmount(r.value.amount_msat)) }
            : { state: 'unknown', text: tr('uiPaymentInProgressSettlementIsNotConfirmedCheck') });
      } else {
        setResult(provenUnpaid(r.error.code)
          ? { state: 'failed', text: tr('uiPaymentNotSent', r.error.message) }
          : { state: 'unknown', text: tr('uiPaymentOutcomeUnknownCheckPendingResultBeforePaying', r.error.message) });
      }
    } catch {
      setResult({ state: 'unknown', text: tr('uiPaymentOutcomeUnknownCheckPendingResultBeforePaying169') });
    } finally { setBusy(false); }
  };
  return <section class="in-call-pay" data-in-call-pay aria-label={tr('uiDirectPaymentDuringCall')}>
    <Show when={live() && props.entry !== false}>
      <button type="button" class="soft money" data-call-pay aria-expanded={expanded()} disabled={blocked() || !destination()} onClick={() => setExpanded(!expanded())}>{tr('uiPay')}</button>
      <Show when={!destination()}><p class="hint">{tr('uiTheirLightningPaymentAddressIsUnavailableYourNode')}</p></Show>
      <Show when={props.pending}><p class="hint">{tr('uiCheckPendingResultBeforePaying')}</p></Show>
      <Show when={expanded()}>
        <div class="pay-flow">
          <strong>{tr('uiPay')} {props.nameOf(peer)}</strong>
          <p class="hint">{tr('uiDirectPaymentToTheirNodeSReportedLightning')}</p>
          <AmountField data="pay" label={tr('uiAmountToPay', props.nameOf(peer))} value={amount()} onInput={setAmount} cleared={amountCleared()} />
          <Show when={msat() !== null}>
            <dl class="pay-review">
              <dt>{tr('uiAmount')}</dt><dd>{fmtAmount(msat()!)}</dd>
              <dt>{tr('uiNetworkFee')}</dt><dd data-call-pay-fee>{tr('uiUpTo178')} {fmtAmount(routingFee(msat()!))}</dd>
              <dt>{tr('uiTotalAtMost')}</dt><dd data-call-pay-total>{fmtAmount(allIn(msat()!))}</dd>
            </dl>
          </Show>
          <SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} hasPending={props.pending} stays={tr('uiYourAmountStaysHereAfterApprovalPressConfirm')} />
          <Show when={!open() && props.spend?.state !== 'pending' && props.spend?.state !== 'unavailable'}>
            <button type="button" class="soft" data-call-pay-approve disabled={blocked() || approving()} onClick={async () => {
              if (blocked() || approving()) return;
              setApproving(true);
              try { await props.actions.approve(); } finally { setApproving(false); }
            }}>{tr('uiApproveSpending')}</button>
          </Show>
          <button type="button" class="primary soft money" data-call-pay-confirm disabled={blocked() || !live() || !open() || !destination() || msat() === null} onClick={() => void pay()}>{tr('uiConfirmAndPay')}</button>
          <button type="button" class="link" onClick={() => setExpanded(false)}>{tr('uiCancel')}</button>
        </div>
      </Show>
    </Show>
    <Show when={busy()}><p class="hint" role="status" data-call-pay-status="sending">{tr('uiSendingPayment')}</p></Show>
    <Show when={result()}>{(r) => <p class={r().state === 'failed' ? 'err-note' : 'hint'} role="status" data-call-pay-status={r().state}>{r().text}</p>}</Show>
    <Show when={minuteOpen()}><p class="err-note" role="alert" data-call-lost-minute>{tr(minuteUndelivered() ? 'caUndeliveredMinuteWarning' : 'caLostMinuteWarning')}</p></Show>
    <Show when={props.pending || result()?.state === 'unknown' || minuteOpen()}>
      <Reconcile actions={props.actions} hasPending={!(minuteOpen() && minuteStop())} stopId={minuteOpen() ? minuteStop() : null} onGone={minuteClosed} onChecked={(text) => {
        if (result()?.state === 'unknown') setResult({ state: 'checked', text });
      }} />
    </Show>
  </section>;
}

type Mode = 'message' | 'pay' | 'request' | 'file';
/** An invoice review: only the host's decode, paid as its canonical string. */
const invoiceReview = (read: InvoiceAmount): PayReview => ({ kind: 'invoice', bolt11: read.bolt11, msat: read.amount_msat, payee: read.payee });

type PayReview =
  | { kind: 'invoice'; bolt11: string; msat: number; payee: string }
  | { kind: 'keysend'; pubkey: string; msat: number; memo: string };

/**
 * The + menu and the emoji picker are drawn fixed, outside the composer's scroll box, so a
 * tall composer keeps scrolling while either is open and neither is clipped by it. Each sits
 * above its button inside the visual viewport and follows the button while the composer,
 * the chat or the viewport moves. While the button is scrolled out of the composer, the
 * overlay waits at the composer's edge. Placement only: it never sends, pays or approves.
 */
function followAnchor(pop: HTMLElement, anchor: HTMLElement, align: 'start' | 'end'): () => void {
  const gap = 8, edge = 8;
  const place = () => {
    if (!pop.isConnected || !anchor.isConnected) return;
    const root = document.documentElement;
    const layoutH = root.clientHeight || window.innerHeight, layoutW = root.clientWidth || window.innerWidth;
    const vv = window.visualViewport;
    const viewTop = Math.max(0, vv?.offsetTop ?? 0), viewLeft = Math.max(0, vv?.offsetLeft ?? 0);
    const viewBottom = Math.min(layoutH, viewTop + (vv?.height ?? layoutH));
    const viewRight = Math.min(layoutW, viewLeft + (vv?.width ?? layoutW));
    const a = anchor.getBoundingClientRect();
    const box = anchor.closest('.composer')?.getBoundingClientRect();
    const top = Math.min(box ? Math.min(Math.max(a.top, box.top), box.bottom) : a.top, viewBottom);
    pop.style.setProperty('--overlay-room', `${Math.max(0, top - gap - viewTop - edge)}px`);
    pop.style.bottom = `${layoutH - (top - gap)}px`;
    const w = pop.offsetWidth;
    const want = align === 'start' ? a.left : a.right - w;
    pop.style.left = `${Math.max(viewLeft + edge, Math.min(want, viewRight - edge - w))}px`;
  };
  place();
  const vv = window.visualViewport;
  document.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
  vv?.addEventListener('resize', place);
  vv?.addEventListener('scroll', place);
  const composer = anchor.closest('.composer');
  const ro = typeof ResizeObserver === 'function' && composer ? new ResizeObserver(place) : null;
  if (ro && composer) ro.observe(composer);
  return () => {
    document.removeEventListener('scroll', place, { capture: true });
    window.removeEventListener('resize', place);
    vv?.removeEventListener('resize', place);
    vv?.removeEventListener('scroll', place);
    ro?.disconnect();
    for (const name of ['--overlay-room', 'bottom', 'left']) pop.style.removeProperty(name);
  };
}

function Composer(props: {
  admissionResume?: OpView;
  ownId: string;
  moneyBlocked: boolean;
  track: TrackRef;
  name: string;
  cost: ReturnType<typeof costToSend>;
  quote: PriceQuote | null;
  quoteError?: string;
  refreshPrice: () => void;
  roomQuote: RoomQuote | null;
  filePrice: PaymentQuote | null;
  firstContact: boolean;
  spend: SpendView | null;
  spendError: string | undefined;
  budget?: BudgetView | null;
  budgetError?: string;
  approvalError?: string;
  budgetStale?: boolean;
  actions: Actions;
  nameOf: (id: string) => string;
  now: number;
  prefill?: Prefill | null;
  onPrefillUsed?: () => void;
  /** A request card's Pay: prefill this invoice and show its review. Never pays. */
  payRequest?: { seq: number; bolt11: string } | null;
  hasPending?: boolean;
}) {
  const [mode, setMode] = createSignal<Mode>('message');
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [firstSpendOpen, setFirstSpendOpen] = createSignal(false);
  const sendReasonId = createUniqueId();
  // B2: the owner's pick of starting preset, and of a first contact's budget.
  const [presetPick, setPresetPick] = createSignal<PresetId | null>(readSpendPreset(props.ownId));
  const [firstPick, setFirstPick] = createSignal<number | null>(null);
  const [drafted, setDrafted] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [paidLine, setPaidLine] = createSignal<string | null>(null);
  const [raisedFrom, setRaisedFrom] = createSignal<number | null>(null);
  createEffect(on(draft, (text) => { if (text.trim()) setPaidLine(null); }));
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  // pay
  const [payKind, setPayKind] = createSignal<'invoice' | 'keysend'>('invoice');
  const [bolt11, setBolt11] = createSignal('');
  // The host's decode of the pasted invoice: its amount, payee and canonical form.
  const [invoiceRead, setInvoiceRead] = createSignal<InvoiceAmount | null>(null);
  const invoiceMsat = () => invoiceRead()?.amount_msat ?? null;
  const [pubkey, setPubkey] = createSignal('');
  const [amount, setAmount, amountCleared] = createAmountDraft();
  const [memo, setMemo] = createSignal('');
  /** The typed amount as exact msat in the current denomination, or null when not exact or outside 1 sat to 1 BTC. */
  const amountMsat = () => {
    const msat = parseAmount(amount(), denom());
    return msat !== null && inPaymentBounds(msat) ? msat : null;
  };
  // The one confirm step: exactly what Pay will send, frozen when shown.
  // Any edit, mode, track or denomination change drops it; nothing is paid
  // until its own button is pressed.
  const [review, setReview] = createSignal<PayReview | null>(null);
  const [paying, setPaying] = createSignal(false);
  // The invoice a request card handed over: its review opens once its amount is read.
  let reviewWhenRead: string | null = null;
  // The invoice just created here, offered to send in chat as an ordinary message.
  const [created, setCreated] = createSignal<InvoiceView | null>(null);
  // file
  const [file, setFile] = createSignal<File | null>(null);
  let fileInput: HTMLInputElement | undefined;
  let draftInput: HTMLTextAreaElement | undefined;
  const [emojiOpen, setEmojiOpen] = createSignal(false);
  let plusBtn: HTMLButtonElement | undefined;
  let plusMenu: HTMLDivElement | undefined;
  let emojiBtn: HTMLButtonElement | undefined;
  let emojiPicker: HTMLDivElement | undefined;
  createEffect(() => {
    if (!emojiOpen()) return;
    if (emojiPicker && emojiBtn) onCleanup(followAnchor(emojiPicker, emojiBtn, 'start'));
    // Escape closes the picker and returns focus to the emoji button; opening moves focus into
    // it without scrolling, since the picker is already placed where it can be seen.
    queueMicrotask(() => emojiPicker?.querySelector<HTMLElement>('[data-emoji-pick]')?.focus({ preventScroll: true }));
    onCleanup(onEscape(() => { setEmojiOpen(false); emojiBtn?.focus(); }));
  });
  // voice note: recorded here, then sent exactly like a chosen file
  const [recording, setRecording] = createSignal<{ rec: Recording; startedAt: number } | null>(null);
  const [recordedMs, setRecordedMs] = createSignal(0);
  const [starting, setStarting] = createSignal(false);
  const voiceFile = () => {
    const f = file();
    return f && isVoiceNote(200, f.name) ? f : null;
  };
  const voicePreview = createMemo(() => {
    const f = voiceFile();
    if (!f) return null;
    const url = URL.createObjectURL(f);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  // Bumped when the track changes or the composer goes away: a microphone
  // prompt answered after that must not start recording for another contact.
  let voiceGeneration = 0;
  // Bumped by the owner's own attachment edits (a pick, Remove, Close). A clip
  // that finishes after one of them must not replace or reopen that choice.
  // Attach's own switch to the file panel is not an edit.
  let attachmentEdit = 0;
  const dropRecording = () => {
    voiceGeneration++;
    const r = untrack(recording);
    setRecording(null);
    r?.rec.cancel();
  };
  onCleanup(dropRecording);
  // Leaving the window stops an active recording (clip stays as an unsent
  // preview). If the mic prompt is still open (`starting`), bump generation so
  // a late grant does not start capture while the user is not looking. Do not
  // bump merely because recording is null — stopRecording clears it before
  // awaiting onstop, and blur+visibilitychange would then drop the clip.
  const onLeave = () => {
    if (untrack(recording)) {
      void stopRecording();
    } else if (untrack(starting)) {
      voiceGeneration++;
    }
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') onLeave(); };
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onVisibility);
  onCleanup(() => {
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onVisibility);
  });
  createEffect(() => {
    const r = recording();
    if (!r) return;
    const tick = setInterval(() => setRecordedMs(Date.now() - r.startedAt), 250);
    onCleanup(() => clearInterval(tick));
  });
  const stopRecording = async () => {
    const r = untrack(recording);
    if (!r) return;
    // Capture before await: a track switch bumps voiceGeneration and must not
    // land this clip as the new track's unsent preview.
    const generation = voiceGeneration;
    const edit = attachmentEdit;
    setRecording(null);
    const clip = await r.rec.stop();
    if (generation !== voiceGeneration || edit !== attachmentEdit) return;
    composerRevision++;
    if (!clip) {
      setNote(tr('uiNothingWasRecorded'));
      return;
    }
    if (clip.size > FILE_MAX_BYTES) {
      setNote(tr('uiThatClipIsOver14MBToo'));
      return;
    }
    if (fileInput) fileInput.value = '';
    setFile(clip);
    setMode('file');
  };
  const startVoice = async () => {
    if (untrack(recording) || untrack(starting)) return;
    setNote(null);
    setStarting(true);
    const generation = voiceGeneration;
    try {
      const rec = await startRecording(() => void stopRecording());
      if (generation !== voiceGeneration) {
        // The track changed (or the composer closed) while the prompt was open.
        rec.cancel();
        return;
      }
      setRecordedMs(0);
      setRecording({ rec, startedAt: Date.now() });
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr('uiThisWindowCannotRecordAudio'));
    } finally {
      setStarting(false);
    }
  };
  // Inputs and navigation remain usable during a send. Only the submitted
  // revision may be cleared by its completion (including track A -> B -> A).
  let composerRevision = 0;
  // Optimistic messages go out one after another, in the order pressed: a
  // second Send while the first is in flight queues behind it instead of
  // being ignored. Each keeps the ceiling it was pressed on.
  // The app-level queue holds press order, holds and the way back for text;
  // this composer only presses into it and lends it its box.
  const queue = props.actions.queue;
  const boxId = ++composerSeq;
  onCleanup(queue.attach({ id: boxId, key: () => trackKey(props.track), revision: () => composerRevision, draft, setDraft, note, setNote }));
  const pressedAt = (revision: number): PressedAt => ({ box: boxId, revision });
  // Going offline invalidates undispatched approvals, not unchanged inputs
  // belonging to an operation that already reached the host and succeeds.
  let approvalRevision = 0;
  // `recipient`: approved on the owner's other device (owner_device_approval_v1);
  // the wait is for the node's first-contact grant (single use, ≤ 120 s).
  const [ownerWait, setOwnerWait] = createSignal<{ approval: OwnerContactApproval; revision: number; send: () => Promise<void>; recipient?: string; message?: { track: TrackRef; text: string } } | null>(null);
  // Owner approval v1: the request is out; the owner's other device approves it.
  const [deviceWait, setDeviceWait] = createSignal<{ view: ApprovalView; revision: number; peer: string; cap: number; budget?: number; send: () => Promise<void>; message?: { track: TrackRef; text: string } } | null>(null);
  const contactWaiting = () => ownerWait() !== null || deviceWait() !== null;
  // A tripped spend breaker: from the last refused send, else the grant's standing pause.
  const [breakerFromSend, setBreakerFromSend] = createSignal<BreakerReason | null>(null);
  const breaker = (): BreakerReason | null => breakerFromSend() ?? (props.budget?.node_grant?.breakers?.paused ? 'grant_paused' : null);
  const noteBreaker = (r: Outcome<unknown>) => setBreakerFromSend(r.ok ? null : breakerReason(r.error.code));
  usePairingActivity(() => busy() || paying() || review() !== null || contactWaiting());
  /** A first-contact message whose approval request is still being made (no wait object yet). */
  let requesting: { track: TrackRef; text: string } | null = null;
  /** Bumped when the owner leaves: every approval continuation checks it after each await and stops. */
  let leaveGeneration = 0;
  /** `leaving`: the owner moved away (another chat, another page); the waiting text is kept on its chat. */
  const cancelOwner = (leaving = false) => {
    if (leaving) leaveGeneration++;
    const pending = untrack(ownerWait);
    const device = untrack(deviceWait);
    const asking = requesting;
    requesting = null;
    setOwnerWait(null);
    // A device request has no cancel at the node: stop waiting here; it expires by itself.
    setDeviceWait(null);
    if (pending && !pending.recipient) void props.actions.ownerCancel(pending.approval.id);
    const message = pending?.message ?? device?.message ?? asking;
    if (leaving && message) props.actions.keepUnsent(message.track, message.text, tr('uiYouLeftBeforeTheOwnerApprovedThisFirst'));
  };
  /** Approved on the other device: wait for the node's grant for this recipient, then send at once. */
  const deviceApproved = (w: NonNullable<ReturnType<typeof deviceWait>>, view: ApprovalView) => {
    setDeviceWait(null);
    if (!view.grant_op) {
      setOwnerExpired(true);
      setNote(tr('uiContactApprovalExpiredNothingWasSentAskAgain'));
      return;
    }
    setOwnerWait({
      approval: {
        id: view.grant_op,
        request: { client_id: view.client_id, grant_op_id: view.grant_op, recipient: w.peer, max_total_msat: w.cap, contact_budget_msat: w.budget ?? 0 },
        owner_command: '',
        approval_window_secs: 120,
        ready: false,
        expires_at_ms: Date.now() + 120_000,
      },
      revision: w.revision,
      send: w.send,
      recipient: w.peer,
      ...(w.message ? { message: w.message } : {}),
    });
  };
  // The box owner may approve at the box console instead of on the other device
  // (`konsensus approve first-contact --op <budget op>`). Watch for that grant
  // too, for exactly this contact and cap; the node still consumes it once.
  createEffect(() => {
    const w = deviceWait();
    if (!w) return;
    let stopped = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (stopped || polling) return;
      polling = true;
      const r = await props.actions.ownerStatus('', w.peer, w.cap);
      polling = false;
      if (stopped || deviceWait() !== w || !r.ok || !r.value.ready) return;
      // The host now holds that grant for this exact send; it goes as approved.
      setDeviceWait(null);
      await w.send();
    }, 2000);
    onCleanup(() => { stopped = true; window.clearInterval(timer); });
  });
  onCleanup(() => cancelOwner(true));
  createEffect(() => { if (props.moneyBlocked) { approvalRevision++; cancelOwner(); } });
  const [ownerCountdown, setOwnerCountdown] = createSignal(0);
  const [ownerExpired, setOwnerExpired] = createSignal(false);
  createEffect(() => {
    const pending = ownerWait();
    if (!pending) return;
    const remote = pending.approval.approval_window_secs !== undefined;
    let deadline = pending.approval.expires_at_ms;
    let delay = 1000;
    let nextPoll = Date.now() + delay;
    let polling = false;
    const expire = () => {
      cancelOwner();
      setOwnerExpired(true);
      setNote(tr('uiContactApprovalExpiredNothingWasSentGetA'));
    };
    const tick = async () => {
      if (ownerWait() !== pending) return;
      setOwnerCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      if (remote && Date.now() >= deadline) { expire(); return; }
      if (polling || Date.now() < nextPoll) return;
      polling = true;
      const result = await props.actions.ownerStatus(pending.approval.id, pending.recipient);
      polling = false;
      if (ownerWait() !== pending) return;
      if (composerRevision !== pending.revision) { cancelOwner(); return; }
      if (remote && Date.now() >= deadline) { expire(); return; }
      if (!result.ok) {
        if (result.error.code === 'owner_contact_expired') { expire(); return; }
        cancelOwner();
        setNote(result.error.message);
      } else {
        deadline = Math.min(deadline, result.value.expires_at_ms);
        if (remote && Date.now() >= deadline) { expire(); return; }
        if (result.value.ready) {
          setOwnerWait(null);
          // Approved: from here it is a queued send like any other (its own
          // bubble, the box free, the same hold), in turn behind earlier ones.
          await pending.send();
        } else {
          // A device-approved grant is valid briefly: keep checking every second.
          delay = remote && !pending.recipient ? Math.min(delay * 2, 10000) : 1000;
          nextPoll = Date.now() + delay;
        }
      }
    };
    setOwnerCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    const timer = setInterval(() => void tick(), 1000);
    onCleanup(() => clearInterval(timer));
  });
  // Budget refreshes replace the object every three seconds. Only an actual
  // authority/mode change invalidates a pending owner request.
  const ownerContext = createMemo(() => `${mode()}:${firstPick()}:${props.budget?.paused ?? false}`);
  createEffect(on(ownerContext, () => { composerRevision++; cancelOwner(); }, { defer: true }));

  const room = () => props.track.kind === 'room';
  const modes = (): Mode[] => (room() ? ['message'] : ['message', 'pay', 'request', 'file']);
  // A new track starts in message mode with a clean composer.
  createEffect(
    on(
      () => trackKey(props.track),
      () => {
        cancelOwner(true);
        setOwnerExpired(false);
        setBreakerFromSend(null);
        composerRevision++;
        setMode('message');
        setNote(null);
        setDraft('');
        setPaidLine(null);
        setRaisedFrom(null);
        setDoor(null);
        dropRecording();
        setFile(null);
        if (fileInput) fileInput.value = '';
        setBolt11('');
        setInvoiceRead(null);
        reviewWhenRead = null;
        setCreated(null);
        setPubkey('');
        setAmount('');
        setMemo('');
        setDrafted(false);
        setFirstPick(null);
      },
      { defer: true },
    ),
  );
  createEffect(on([mode, payKind, bolt11, invoiceRead, pubkey, amount, memo, denom, () => trackKey(props.track)], () => setReview(null), { defer: true }));
  // A draft from the AI track: fill this composer once. Sending is still the
  // owner's press, with the cost shown and the spend approval unchanged.
  createEffect(
    on(
      () => [props.prefill?.seq, trackKey(props.track)] as const,
      () => {
        const p = props.prefill;
        // AI drafts are for one peer; an Unsent card can be in a room too.
        if (!p || p.key !== trackKey(props.track) || (room() && !p.unsentId)) return;
        if (p.unsentId && (draft().trim() || mode() !== 'message')) {
          // Never over a newer message: the Unsent card stays until the box is free.
          setNote(tr('uiSendOrClearTheMessageInTheBox'));
          props.onPrefillUsed?.();
          return;
        }
        cancelOwner();
        setOwnerExpired(false);
        composerRevision++;
        setMode(p.mode);
        setNote(null);
        if (p.mode === 'message') setDraft(p.text);
        const draftAmount = p.sats === null ? '' : amountText(Math.round(p.sats * 1000), denom());
        if (p.mode === 'pay') {
          setPayKind('keysend');
          setAmount(draftAmount);
          setMemo('');
        }
        if (p.mode === 'request') {
          setAmount(draftAmount);
          setMemo(p.text);
        }
        setDrafted(true);
        if (p.unsentId) props.actions.discardUnsent(props.track, p.unsentId);
        props.onPrefillUsed?.();
      },
    ),
  );

  // A request card's Pay: the Pay composer with that invoice. Its review opens
  // when the host has read the amount; paying is still the review's confirm.
  createEffect(
    on(
      () => props.payRequest?.seq,
      () => {
        const p = props.payRequest;
        if (!p || room()) return;
        cancelOwner();
        setOwnerExpired(false);
        composerRevision++;
        setNote(null);
        setMode('pay');
        setPayKind('invoice');
        reviewWhenRead = p.bolt11;
        // Re-set even when unchanged, so the amount is read (and reviewed) again.
        setBolt11('');
        setBolt11(p.bolt11);
      },
      { defer: true },
    ),
  );

  const line = () => spendLine(props.spend, props.now);
  const spends = () => mode() !== 'request';
  const target = () => (props.track as { id: string }).id;
  /** One contact, and this Mac approves with Touch ID. */
  const touchable = () => spends() && !room() && props.actions.device()?.state === 'registered';
  const budget = () => props.budget ?? null;
  /** The book's rolling limits apply even when a separate spending window supplies authority. */
  const appBudgetRemaining = () => {
    const b = budget();
    if (!b) return null;
    const used = b.accounted_msat ?? b.spent_msat + b.unsettled_msat;
    const ceiling = b.autopay.state === 'open' ? Math.min(b.ceiling_msat, b.autopay.ceiling_msat ?? 0) : b.ceiling_msat;
    const row = b.rows.find(row => row.target.toLowerCase() === target().toLowerCase() && row.room === room());
    const contact = row?.limit_msat == null ? null
      : Math.max(0, row.limit_msat - (row.accounted_msat ?? row.spent_msat + (row.unsettled_msat ?? 0)));
    return { total: Math.max(0, ceiling - used), contact };
  };
  /** The current node grant covers this contact and the displayed send ceiling. */
  const liveGrantRemaining = (): number | null => {
    const b = budget();
    const g = b?.node_grant;
    const peer = target().toLowerCase();
    const now = Math.max(props.now, Date.now());
    const cost = shown().msat;
    if (props.budgetStale || !g || b?.paused || b?.waiting_for_owner || props.spend?.state === 'pending' ||
        props.actions.noEnvelopeFor()?.toLowerCase() === peer || g.expires_at_ms <= now || cost === null ||
        messagePerPaymentMax(g) < cost || (g.envelopes && (g.envelopes[peer] ?? 0) <= now)) return null;
    let remaining = Math.min(g.remaining_msat, g.recipient_left_msat_by_recipient?.[peer] ?? Infinity);
    if (b.autopay.state === 'open') {
      const local = appBudgetRemaining()!;
      remaining = Math.min(remaining, local.total, local.contact ?? Infinity);
    }
    return remaining >= cost ? remaining : null;
  };
  /** The next tap here needs a new contact approval, not an already live grant. */
  const needsTouch = () =>
    touchable() && !budget()?.paused && props.spend?.state !== 'pending' && liveGrantRemaining() === null &&
    (!(line().open || ((mode() === 'message' || mode() === 'file') && budget()?.autopay.state === 'open')) ||
      props.actions.noEnvelopeFor()?.toLowerCase() === target().toLowerCase() ||
      !!budget()?.node_grant?.envelopes && (budget()!.node_grant!.envelopes![target().toLowerCase()] ?? 0) <= Math.max(props.now, Date.now()));
  /**
   * Messages go through the budget unless the owner opened the ten-minute
   * window by hand with no budget approval, or the host has no budget to show.
   */
  const viaBudget = () => {
    const b = budget();
    // Messages and files share budget / window rules; pay & request stay manual.
    if ((mode() !== 'message' && mode() !== 'file') || !b) return false;
    return b.paused || b.waiting_for_owner || b.autopay.state === 'open' || (!line().open && !(touchable() && liveGrantRemaining() !== null));
  };
  // A known contact the node would not re-admit from the budget after a
  // reconnect (its grant does not budget them yet): the door card, once more.
  const [readmitFor, setReadmitFor] = createSignal<string | null>(null);
  const readmit = () => !room() && readmitFor() === target();
  // Genome quoted_readmission_v1: after a reconnect or restart the contact
  // asks for admission again and the node kept their signed quote. The
  // owner sees it here, inside the all-in cost, and sends
  // once more at that price (the same message keeps its operation).
  const [readmitQuote, setReadmitQuote] = createSignal<{ peer: string; price: AdmissionPrice } | null>(null);
  // Whatever the mode: Send in chat shows (and caps) a message from Request.
  const readmitPrice = (): AdmissionPrice | null => {
    const q = readmitQuote();
    return q && !room() && q.peer === target() ? q.price : null;
  };
  // Is this send a first contact? While the budget decides, exactly when it
  // has no line for this peer, whatever the thread holds: inbound history
  // does not open their door for us (merge-gate finding 7). Otherwise, when
  // we have never sent to them. (A cost-free stand: `shown` depends on this.)
  const doorWanted = () => {
    if (room() || props.admissionResume) return false;
    if (readmit()) return true;
    const kind = budgetStand(budget(), target(), false, null).kind;
    if (kind === 'first') return true;
    if (kind === 'ok' || kind === 'contact_used' || kind === 'total_used') return false;
    return props.firstContact;
  };
  // A resume replaces a held charge. Only the host knows its fee allowance,
  // so let it check the replacement against the book rather than counting
  // the full cap twice here. Approval, pause and grant gates still apply.
  const stand = () => budgetStand(budget(), target(), room(), mode() === 'message' && props.admissionResume ? 0 : shown().msat, readmit());
  createEffect(() => {
    if (props.moneyBlocked) { setDoor(null); return; }
    if (room() || !doorWanted() || (mode() !== 'message' && mode() !== 'file') || !(stand().kind === 'first' || (stand().kind === 'off' && firstSpendOpen()))) return;
    const peer = target();
    if (untrack(door)?.peer === peer) return;
    const request = { peer, quote: null, loading: true };
    setDoor(request);
    void props.actions.doorQuote(peer).then((quote) => {
      if (untrack(door) === request) setDoor({ peer, quote });
    }).catch((error) => {
      if (untrack(door) === request) setDoor({ peer, quote: null, error });
    });
  });
  const needsFirstSpend = () => viaBudget() && stand().kind === 'off' && !needsTouch();
  createEffect(() => { if (!needsFirstSpend()) setFirstSpendOpen(false); });
  createEffect(on(() => trackKey(props.track), () => setFirstSpendOpen(false), { defer: true }));
  createEffect(on(mode, () => setFirstSpendOpen(false), { defer: true }));
  const presetChosen = () => {
    const b = budget();
    const id = presetPick() ?? b?.preset ?? 'careful';
    return b?.presets.find((p) => p.id === id) ?? b?.presets[0] ?? null;
  };
  const blocked = (): string | null => {
    if (room() && props.roomQuote && props.roomQuote.unreachable.length > 0) {
      const names = props.roomQuote.unreachable.map(props.nameOf).join(', ');
      return tr('uiNotEveryMemberIsAConnectedPeerYour', names);
    }
    return null;
  };

  // Read the invoice amount as it is pasted: the cost is shown before paying.
  createEffect(
    on(bolt11, (text) => {
      setInvoiceRead(null);
      const value = text.trim();
      if (!value) return;
      void props.actions.readInvoice(value).then((r) => {
        if (bolt11().trim() !== value) return;
        const fromCard = reviewWhenRead === value;
        reviewWhenRead = null;
        if (r.ok) {
          setInvoiceRead(r.value);
          setNote(null);
          // Same as pressing Pay: the review, with the host's reading of the invoice.
          if (fromCard && mode() === 'pay' && payKind() === 'invoice' && !props.moneyBlocked && line().open && !busy()) {
            setReview(invoiceReview(r.value));
          }
        } else setNote(r.error.message);
      });
    }),
  );

  // The door card (genome first_contact_grant_v1): before a first paid message
  // to a stranger, read the stranger's own signed quote once. Its total is the
  // cap the owner confirms; the node pays that very invoice. A missing or
  // expired first-contact quote disables Send and offers a read-only retry.
  const [door, setDoor] = createSignal<{ peer: string; quote: FirstContactQuote | null; loading?: boolean; error?: unknown } | null>(null);
  const doorQuote = (): FirstContactQuote | null => {
    const d = door();
    return d && !room() && d.peer === target() ? d.quote : null;
  };

  const priceProblem = (): string | null => {
    if (props.admissionResume && mode() === 'message') return null;
    if (ownerExpired()) return tr('uiContactApprovalExpiredGetAFreshQuote');
    if (!room()) {
      if (props.quoteError) return props.quoteError;
      if (!props.quote) return tr('uiPriceLoading');
      if (props.quote.send_unavailable) return isChainUnavailable(props.quote.send_unavailable) ? tr('chainUnavailable') : peerNotReadyMessage(props.quote.send_unavailable, props.name) ?? tr('uiPriceUnavailable', props.quote.send_unavailable);
    }
    if (readmitPrice()) return Number.isSafeInteger(readmitPrice()!.total_msat) && readmitPrice()!.total_msat > 0 ? null : tr('uiPriceUnavailableInvalidPrice');
    if (room()) return props.cost ? null : tr('uiPriceLoading');
    if (doorWanted() && door()) {
      const d = door()!;
      if (d.loading) return tr('uiPriceLoading');
      if (!d.quote) return isChainUnavailable(d.error) ? tr('chainUnavailable') : peerNotReadyMessage(d.error, props.name) ?? tr('uiPriceUnavailableFirstContactQuoteUnavailable');
      if (!Number.isSafeInteger(d.quote.total_msat) || d.quote.total_msat <= 0) return tr('uiPriceUnavailableInvalidPrice');
      if (d.quote.expires_at * 1000 <= props.now) return tr('uiPriceUnavailableFirstContactQuoteExpired');
      return null;
    }
    const q = props.quote!;
    if (q.peer_msat === null) return tr('uiPriceUnavailablePeerHasNotSharedAPrice');
    if (!Number.isSafeInteger(q.peer_msat) || q.peer_msat < 0) return tr('uiPriceUnavailableInvalidPeerPrice');
    if (q.peer_stale) return tr('uiPriceUnavailablePeerPriceIsStale');
    if (!Number.isSafeInteger(q.max_routing_fee_msat) || q.max_routing_fee_msat! < 0)
      return tr('uiPriceUnavailableRoutingFeeAllowanceMissing');
    if (!props.cost || !Number.isSafeInteger(props.cost.msat)) return tr('uiPriceUnavailableInvalidPrice');
    return null;
  };
  const paymentResult = (result: Outcome<unknown>) => {
    if (!result.ok) {
      if (['spend_unknown', 'payment_unknown', 'failed_paid', 'payment_settled_undelivered'].includes(result.error.code))
        setPaidLine(tr('uiPaidAmountUnknownCheckPaymentResult'));
      return;
    }
    const receipt = result.value as SendReceipt;
    setPaidLine(paidAmount(receipt.amount_msat + (receipt.readmission_msat ?? 0), receipt.fee_paid_msat));
  };
  // Display only: the parts of the ceiling when they provably add up to it.
  const breakdown = () =>
    mode() !== 'message' || props.admissionResume || room() || doorWanted() || readmitPrice() || paidLine() || priceProblem()
      ? null
      : priceBreakdown(props.quote, messageShown().msat);
  const priceLine = () => {
    if (!draft().trim()) return null;
    if (paidLine()) return paidLine();
    if (priceProblem()) return priceProblem();
    const cap = messageShown().msat;
    if (cap === null) return tr('uiPriceLoading');
    if (readmitPrice() || (raisedFrom() !== null && cap > raisedFrom()!)) return tr('uiPriceWentUpToSend', fmtAmount(cap));
    return tr('uiUpToIncludesMaxRoutingFee', fmtAmount(cap));
  };

  const firstContactCostLine = (): string | null => {
    if (!doorWanted() || (!door() && !readmitPrice())) return null;
    const q = readmitPrice() ?? doorQuote();
    if (priceProblem()) return priceProblem();
    if (!q) return tr('firstSpendCostLoading');
    return tr('firstSpendCost', fmtAmount(q.admission_msat), fmtAmount(q.message_msat),
      fmtAmount(q.max_routing_fee_msat ?? 0), fmtAmount(q.total_msat));
  };

  const retryPrice = () => {
    if (doorWanted() && door()) setDoor(null);
    props.refreshPrice();
  };

  /** What this mode costs, shown before the button is pressed. */
  /** What one message costs here, whatever the current mode (Send in chat uses it too). */
  const messageShown = (): { msat: number | null; estimate: boolean; basis: string } => {
    const resume = props.admissionResume;
    if (resume) return { msat: resume.cap_msat, estimate: false, basis: tr('uiOriginalCapIncludingAdmissionAlreadyPaidOnlyThe') };
    const problem = priceProblem();
    if (problem) return { msat: null, estimate: false, basis: problem };
    const again = readmitPrice();
    if (again) {
      return {
        msat: again.total_msat,
        estimate: false,
        basis: tr('uiAsksForAdmissionAgainThenForThisMessage', props.name, sats(again.admission_msat), satUnit(again.admission_msat), fmtAmount(again.message_msat), feeCeiling(again.max_routing_fee_msat ?? 0)),
      };
    }
    const q = doorWanted() ? doorQuote() : null;
    if (q) {
      return {
        msat: q.total_msat,
        estimate: false,
        basis: tr('uiSOwnQuoteToOpenTheirDoorThen', props.name, fmtAmount(q.admission_msat), fmtAmount(q.message_msat), feeCeiling(q.max_routing_fee_msat ?? 0)),
      };
    }
    const c = props.cost;
    if (!c) return { msat: null, estimate: false, basis: room() ? tr('uiReadingEachMemberSPrice') : tr('uiReadingTheirPrice') };
    const basis = doorWanted()
      ? tr('uiFirstContactAdmissionMustFitThisCeilingOtherwise', c.basis)
      : c.basis;
    return { msat: c.msat, estimate: c.estimate, basis };
  };

  const shown = (): { msat: number | null; estimate: boolean; basis: string } => {
    switch (mode()) {
      case 'message':
        return messageShown();
      case 'pay':
        if (payKind() === 'invoice') {
          return invoiceMsat() === null
            ? { msat: null, estimate: false, basis: tr('uiPasteAnInvoiceToSeeWhatItAsks') }
            : { msat: allIn(invoiceMsat()!), estimate: false, basis: tr('uiIncludes', feeCeiling(routingFee(invoiceMsat()!))) };
        }
        return amountMsat() === null
          ? { msat: null, estimate: false, basis: tr('uiEnterAnAmount') }
          : { msat: allIn(amountMsat()!), estimate: false, basis: tr('uiIncludes', feeCeiling(routingFee(amountMsat()!))) };
      case 'request':
        return { msat: 0, estimate: false, basis: tr('uiReceivingIsFree') };
      case 'file':
        return props.filePrice === null
          ? { msat: null, estimate: false, basis: tr('uiReadingTheFilePrice') }
          : { msat: props.filePrice.total_msat, estimate: false, basis: tr('uiFilePricePlus', feeCeiling(props.filePrice.max_routing_fee_msat)) };
    }
  };

  /** `text`: an Approve & send continuing with the words in its bubble (the box may be empty or newer). */
  const ready = (text?: string): boolean => {
    if (blocked()) return false;
    switch (mode()) {
      case 'message':
        return (text ?? draft()).trim().length > 0 && messageShown().msat !== null;
      case 'pay':
        return payKind() === 'invoice' ? invoiceMsat() !== null : pubkey().trim().length > 0 && amountMsat() !== null;
      case 'request':
        return amountMsat() !== null;
      case 'file':
        return file() !== null && props.filePrice !== null;
    }
  };

  /** The cost on the button. A file's figure is a ceiling: its price plus the most routing can cost. */
  const labelPrice = () => {
    const s = shown();
    if (s.msat === null) return '';
    const figure = `${s.estimate ? '≈ ' : ''}${sats(s.msat)} ${satUnit(s.msat)}`;
    return ` · ${mode() === 'file' ? tr('uiFileUpTo', figure) : figure}`;
  };

  const label = () => {
    if (paying()) return tr('uiPaying');
    if (deviceWait()) return tr('uiWaitingForYourOtherDevice');
    if (ownerWait()) return tr('uiWaitingForContactApproval');
    if (needsTouch()) {
      return isMobilePlatform() ? tr('uiApproveWithBiometrics') : tr('uiApproveWithTouchID');
    }
    if (viaBudget()) {
      const price = labelPrice();
      switch (stand().kind) {
        case 'paused': return tr('uiResumePayments');
        case 'waiting': return tr('uiWaitingForApproval');
        // The press only allows payments (a preset): say so, as the message button does.
        case 'off': return tr('uiSend');
        case 'first': return tr('uiSendFirst', mode() === 'file' ? tr('fileNoun') : tr('messageNoun'), price);
        case 'contact_used':
        case 'total_used': return tr('uiBudgetUsedUp');
        case 'grant_limited': return tr('uiNodeGrantLimit');
        default: return tr('uiSend230', price);
      }
    }
    if (spends() && !line().open) {
      if (props.spend?.state === 'pending') return tr('uiWaitingForApproval');
      if (props.spend?.state === 'unavailable') return tr('uiSpendingUnavailable');
      return canContinue('grant') ? tr('uiApproveSend') : tr('uiSend');
    }
    const price = labelPrice();
    return { message: tr('uiSend'), pay: tr('uiPay'), request: tr('uiCreateInvoice'), file: tr('uiSendFile') }[mode()] + (mode() === 'request' ? '' : price);
  };

  /** The Send button's text, title and accessible name: what this press does. */
  const sendTitle = () => {
    if (props.budgetStale) return tr('uiSend');
    if (liveGrantRemaining() !== null) return tr('uiSend');
    if (!needsTouch() && !viaBudget() && spends() && !line().open && props.spend?.state !== 'pending' && props.spend?.state !== 'unavailable' && canContinue('grant')) {
      return tr('uiApproveSend');
    }
    if (needsTouch()) return isMobilePlatform() ? tr('uiApproveWithBiometrics') : tr('uiApproveWithTouchID');
    // A budget press only approves or resumes; it sends nothing.
    if (viaBudget() && (mode() === 'message' || mode() === 'file')) {
      const k = stand().kind;
      if (k === 'paused') return tr('uiResumePayments');
      if (k === 'off') return tr('uiSend');
    }
    return tr('uiSend');
  };
  /** Pay / Request / File panels close back to the single message bar. */
  /** The file went: back to the message box, ready to type. A failed send never comes here, so it keeps its file. */
  const fileGone = () => {
    attachmentEdit++;
    setFile(null);
    if (fileInput) fileInput.value = '';
    setMode('message');
    // The Send button just pressed is gone. Not on a phone, where focus would open the keyboard unasked.
    if (!isMobilePlatform()) queueMicrotask(() => draftInput?.focus());
  };
  const closePanel = () => {
    attachmentEdit++;
    composerRevision++;
    if (mode() === 'file') {
      setFile(null);
      if (fileInput) fileInput.value = '';
    }
    setMode('message');
    setNote(null);
  };
  createEffect(on(mode, () => setMenuOpen(false), { defer: true }));
  createEffect(() => {
    if (!menuOpen()) return;
    const onDoc = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.composer-plus-wrap')) setMenuOpen(false);
    };
    if (plusMenu && plusBtn) onCleanup(followAnchor(plusMenu, plusBtn, 'end'));
    // Escape closes the Pay / Request / Attach menu and returns focus to +.
    queueMicrotask(() => plusMenu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
    document.addEventListener('click', onDoc);
    onCleanup(onEscape(() => { setMenuOpen(false); plusBtn?.focus(); }));
    onCleanup(() => document.removeEventListener('click', onDoc));
  });

  /**
   * Approve & send: a press that has to ask for an approval first puts the
   * words in a bubble that waits for it ("Sends when approved · up to N") and
   * frees the box. When the approval clears, that bubble goes through the
   * ordinary send path once, at the price on the button that was pressed.
   * Until it is handed over (`taken`), nothing was dispatched, so any end
   * (not approved, left, price moved, offline, expired) is a true "not sent,
   * nothing paid" Unsent card with its words.
   */
  /**
   * `kind`: the one approval this press asked for; `approved`: that approval's
   * own action succeeded (set before busy clears); `grantOp`: for the node
   * grant, the pending request it waits on. Consent ends with that approval:
   * its refusal, cancel, lapse or replacement drops it; another approval
   * never satisfies it.
   */
  /** The spending request ('grant') and a Touch ID contact approval bound to its envelope ('touch') continue (see canContinue). */
  type ApprovalKind = 'grant' | 'touch' | 'budget';
  /**
   * Bound ONLY to what the approval action itself returned. `key`: the grant
   * op G of the window that very call armed (hand-off when the open view's
   * granted_op === G). `requestId`: the node request R it made or continued
   * (hand-off when the open view's armed_by_request === R; its grant op is an
   * independent node value). `keySeen`: that window was observed open.
   * Touch ID: `envelope` is the envelope id E its relation_approve returned
   * (hand-off when a fresh grant read names E for this contact); `readsFrom`
   * the first budget read that started after it; `keySeen`: E was seen live.
   */
  type Pressed = { bubble: string; track: TrackRef; text: string; msat: number; until: number; taken: boolean; kind: ApprovalKind; approved: boolean; key: string | null; requestId: string | null; keySeen: boolean; requestSeen: boolean; envelope: string | null; readsFrom: number; cancelled: boolean; cancelReason: string | null };
  const [consent, setConsent] = createSignal<Pressed | null>(null);
  /** The host names the grant of an open window (#227): only then can grant, preset and resume continue. */
  const bindable = () => props.spend != null && 'granted_op' in props.spend;
  /**
   * Touch ID binds only where the host names each contact's node envelope
   * (relation_envelope_id_v1): decided before the tap, on a confirmed read.
   */
  const touchBindable = () => !props.budgetStale && !!budget()?.node_grant?.envelope_id_by_recipient;
  /** A budget press binds only where the host names the request that armed autopay (armed_by_request): decided before the tap. */
  const budgetBindable = () => { const b = budget(); return !props.budgetStale && !!b && 'armed_by_request' in b; };
  /**
   * Approve & send only where a node identity binds the approval: the spending
   * request (its request id or the grant op its call returned), or a Touch ID
   * contact approval (the envelope id it returned). Touch ID without envelope
   * ids, and preset/resume (a budget grant arms autopay, not the spend window),
   * keep the plain flow: approve, then press Send.
   */
  const canContinue = (kind: ApprovalKind) => mode() === 'message' && !!draft().trim() && shown().msat !== null && consent() === null &&
    (kind === 'touch' ? touchBindable() : kind === 'budget' ? budgetBindable() : bindable());
  /**
   * The plain flow after an approval that does not continue: the draft stays;
   * say what is next. Taken but still waiting for the owner at the node: say
   * so, and "Approved" only once it completes (below).
   */
  const [approvalPending, setApprovalPending] = createSignal(false);
  const approvedPlain = (ok: boolean, waiting = false) => {
    // A chosen file waits for the next press just as a typed message does.
    if (!ok || !untrack(() => (mode() === 'message' ? draft().trim() !== '' : mode() === 'file' && file() !== null))) return;
    if (waiting) { setApprovalPending(true); setNote(tr('uiWaitingForYourApprovalAtTheNode')); return; }
    setNote(tr('uiApprovedPressSendToSendIt'));
  };
  createEffect(() => {
    if (!approvalPending()) return;
    const k = stand().kind;
    if (k === 'ok' || k === 'first') { setApprovalPending(false); setNote(tr('uiApprovedPressSendToSendIt')); }
    // Completed into a limit (contact or daily total used, node grant limit), or turned off again: the
    // waiting note ends; the budget line under the composer explains the limit.
    else if (k !== 'waiting') { setApprovalPending(false); setNote(null); }
  });
  const startWaiting = (kind: ApprovalKind) => {
    if (!untrack(() => canContinue(kind))) return;
    const text = draft();
    const msat = shown().msat!;
    const bubble = props.actions.beginSending(props.track, text, msat, kind === 'budget' ? 'allowed' : true);
    setDraft('');
    setDrafted(false);
    setConsent({ bubble, track: props.track, text, msat, until: Date.now() + CONTINUE_MS, taken: false, kind, approved: false, key: null, requestId: null, keySeen: false, requestSeen: false, envelope: null, readsFrom: 0, cancelled: false, cancelReason: null });
  };
  const dropConsent = (reason: string) => {
    const c = untrack(consent);
    if (!c) return;
    setConsent(null);
    props.actions.settleWaiting(c.track, c.bubble, reason);
  };
  /**
   * Approved, but nothing binds this message to the window that opened: the
   * plain flow, at once. The words go back to the box when it is free in their
   * chat, else they stay as an Unsent card. Nothing is sent.
   */
  const backToPlain = () => {
    const c = untrack(consent);
    if (!c) return;
    setConsent(null);
    if (trackKey(untrack(() => props.track)) === trackKey(c.track) && !untrack(draft)) {
      props.actions.settleWaiting(c.track, c.bubble, '');
      setDraft(c.text);
      setDrafted(true);
      setNote(tr('uiApprovedPressSendToSendIt'));
    } else props.actions.settleWaiting(c.track, c.bubble, tr('uiApprovedPressSendToSendIt238'));
  };
  const approvalCleared = () => !needsTouch() && (viaBudget() ? stand().kind === 'ok' || stand().kind === 'first' : !spends() || line().open);
  /**
   * The approval action answered (before busy clears, so nothing continues on
   * another approval first). Refused: the wait ends. Touch ID: its contact
   * approval is what clears it. Grant / preset / resume: bound only to the
   * grant op that call returned; a request without one waits for the window
   * and then goes back to the plain flow; neither: the plain flow at once.
   */
  const afterApproval = (r: boolean | ApprovalResult) => {
    const c = untrack(consent);
    if (!c) return;
    const ok = typeof r === 'boolean' ? r : r.ok;
    if (!ok) { dropConsent(tr('uiItWasNotApproved')); return; }
    if (typeof r === 'boolean') { backToPlain(); return; }
    if (!r.bindable || (r.grantedOp === null && r.requestId === null)) { backToPlain(); return; }
    setConsent({ ...c, approved: true, key: r.grantedOp, requestId: r.requestId });
  };
  /**
   * The Touch ID action answered (before busy clears). Refused or cancelled:
   * the wait ends. No envelope id: nothing binds the message, the plain flow
   * at once. Else bound only to the envelope id E this very call returned.
   */
  const afterTouch = (r: TouchApproval, started: Pressed | null) => {
    const c = untrack(consent);
    // Only the wait this tap started: one that already ended is never bound again.
    if (!c || c !== started) return;
    if (!r.ok) { dropConsent(tr('uiItWasNotApproved')); return; }
    if (!r.envelopeId) { backToPlain(); return; }
    setConsent({ ...c, approved: true, envelope: r.envelopeId, readsFrom: r.readsFrom });
  };
  const LAPSED = () => tr('uiTheApprovalWasCancelledOrLapsedBeforeIt');
  const TOUCH_AGAIN = () => tr('uiItNeedsAgainPressSendToAsk', isMobilePlatform() ? tr('uiBiometricApproval') : tr('uiTouchID'));
  const BUDGET_AGAIN = () => tr('uiPaymentsNeedApprovingAgainPressSendToAsk');
  const BUDGET_SHORT = () => tr('uiAllowedButYourBudgetDoesNotCoverThis');
  const PRICE_MOVED = () => tr('uiTheMessagePriceChangedBeforeItWasSent');
  /** The budget stand for an approved message at the price it was approved at (whatever the composer's mode now). */
  const standFor = (p: Pressed) => budgetStand(budget(), (p.track as { id: string }).id, p.track.kind === 'room', p.msat, p.track.kind !== 'room' && readmit()).kind;
  /**
   * Does this grant read cover one message at `msat` for `peer`? Per call, the
   * whole grant, and the contact's own remainder when named. The host omits a
   * contact from recipient_left_msat_by_recipient when the grant sets no
   * per-recipient cap for it, so a missing entry means no per-recipient limit.
   */
  const touchCovers = (g: NodeGrantSummary, peer: string, msat: number) => {
    const left = g.recipient_left_msat_by_recipient;
    return messagePerPaymentMax(g) >= msat && g.remaining_msat >= msat && (!left || !(peer in left) || left[peer] >= msat);
  };
  /**
   * The envelope this Touch ID approval returned is live now, on a fresh read:
   * the grant itself not expired, the contact's id exactly E (lower-cased key),
   * its envelope not ended, and the price covered. Checked when it is seen, at
   * hand-off, and again right before a queued send is dispatched.
   */
  const touchLive = (p: Pressed) => {
    // A read known to be stale (a failed refresh keeps the old grant) proves nothing.
    if (props.budgetStale || props.actions.device()?.state !== 'registered' || props.actions.budgetReadApplied() < p.readsFrom) return false;
    const g = budget()?.node_grant;
    const peer = (p.track as { id: string }).id.toLowerCase();
    const now = Date.now();
    const until = g?.envelopes?.[peer];
    return !!g && g.expires_at_ms > now && g.envelope_id_by_recipient?.[peer] === p.envelope && !!until && until > now && touchCovers(g, peer, p.msat);
  };
  /**
   * Touch ID consent, on fresh reads only (started after the approval
   * returned), with the contact's key looked up lower-cased and exact: its
   * envelope id is E and live → seen (and it must cover the price). Before E
   * was seen, another id, a null (legacy/unknown) or no entry at all is stale:
   * it needs Touch ID again. After E was seen, any read without it live
   * (another id, none, expired) → lapsed, even if E shows again later. No
   * envelope ids at all any more: no binding, the plain flow.
   */
  createEffect(() => {
    const c = consent();
    if (!c || c.kind !== 'touch') return;
    // Before the approval answers too: once this Mac's approvals stop, the wait ends for good.
    if (props.actions.device()?.state !== 'registered') { dropConsent(tr('uiStoppedBeforeItWentThrough', isMobilePlatform() ? tr('uiBiometricApprovalsOnThis', deviceWord() === 'phone' ? tr('phone') : deviceWord()) : tr('uiTouchIDApprovalsOnThisMac'))); return; }
    if (!c.approved) return;
    if (props.actions.budgetReadApplied() < c.readsFrom) return;
    const g = budget()?.node_grant ?? null;
    if (!g) { dropConsent(c.keySeen ? LAPSED() : TOUCH_AGAIN()); return; }
    const ids = g.envelope_id_by_recipient;
    if (!ids) { backToPlain(); return; }
    const peer = (c.track as { id: string }).id.toLowerCase();
    const until = g.envelopes?.[peer];
    const now = Math.max(props.now, Date.now());
    if (g.expires_at_ms <= now || ids[peer] !== c.envelope || !until || until <= now) { dropConsent(c.keySeen ? LAPSED() : TOUCH_AGAIN()); return; }
    if (!touchCovers(g, peer, c.msat)) { dropConsent(TOUCH_AGAIN()); return; }
    if (!c.keySeen) setConsent({ ...c, keySeen: true });
  });
  /**
   * The budget press answered (before busy clears). Refused: the wait ends.
   * No node request R: nothing names what will arm autopay (an immediate arm
   * included), the plain flow at once. Else bound only to R, as this very
   * call returned it.
   */
  const afterBudget = (r: ApprovalResult, started: Pressed | null) => {
    const c = untrack(consent);
    if (!c || c !== started) return;
    if (!r.ok) { dropConsent(tr('uiItWasNotApproved')); return; }
    if (r.requestId === null) { backToPlain(); return; }
    setConsent({ ...c, approved: true, requestId: r.requestId, readsFrom: r.readsFrom ?? Number.MAX_SAFE_INTEGER });
  };
  /**
   * Autopay is open because R armed it (armed_by_request === R, the one
   * stable id: the grant op changes under autopay), not past its end, and not
   * paused, on a fresh read that is not known stale.
   */
  const budgetLive = (p: Pressed, b: BudgetView | null, now: number) =>
    !props.budgetStale && props.actions.budgetReadApplied() >= p.readsFrom && !!b && !b.paused &&
    b.autopay.state === 'open' && b.armed_by_request === p.requestId && b.autopay.open_until_ms != null && b.autopay.open_until_ms > now;
  /**
   * Budget consent, on fresh reads only: autopay armed by R → seen. Open but
   * armed some other way (another request, an immediate or local arm, none),
   * paused, or a pending request other than R → lapsed. R pending (or the
   * owner asked) → waiting; after that, neither → lapsed; so is losing R after
   * it was seen. No armed_by_request field any more: the plain flow.
   */
  createEffect(() => {
    const c = consent();
    if (!c || c.kind !== 'budget' || !c.approved) return;
    if (props.budgetStale || props.actions.budgetReadApplied() < c.readsFrom) return;
    const b = budget();
    if (!b) return;
    if (!('armed_by_request' in b)) { backToPlain(); return; }
    const now = Math.max(props.now, Date.now());
    if (budgetLive(c, b, now)) {
      // Allowed, but this message is over a limit the budget sets: it is not sent.
      const k = untrack(stand).kind;
      if (k === 'contact_used' || k === 'total_used' || k === 'grant_limited') { dropConsent(BUDGET_SHORT()); return; }
      if (!c.keySeen) setConsent({ ...c, keySeen: true });
      return;
    }
    if (c.keySeen || b.paused || b.autopay.state === 'open') { dropConsent(LAPSED()); return; }
    const sp = props.spend;
    const pendingOp = sp?.state === 'pending' ? sp.pending?.op_id ?? null : null;
    if (pendingOp !== null && pendingOp !== c.requestId) { dropConsent(LAPSED()); return; }
    if (b.waiting_for_owner || pendingOp === c.requestId) { if (!c.requestSeen) setConsent({ ...c, requestSeen: true }); return; }
    // The call returned R, so a fresh read that shows neither R waiting nor R live means it was cancelled or lapsed.
    dropConsent(LAPSED());
  });
  // The approval it waits on was cancelled, lapsed or replaced: the consent ends with it.
  createEffect(() => {
    const c = consent();
    if (!c || !c.approved || c.kind !== 'grant') return;
    const sp = props.spend;
    const open = sp?.state === 'open';
    const granted = open ? sp!.granted_op ?? null : null;
    if (c.key !== null) {
      // Bound to the grant its own call armed: another grant, or the window closing after it was seen, ends it.
      if (open && granted !== null && granted !== c.key) { dropConsent(LAPSED()); return; }
      if (open && granted === c.key) { if (!c.keySeen) setConsent({ ...c, keySeen: true }); return; }
      if (c.keySeen) dropConsent(LAPSED());
      return;
    }
    // Bound to its node request R: the window that request's completion armed (armed_by_request === R).
    if (open) {
      // A host that cannot say which request armed a window: no proof, the plain flow.
      if (!('armed_by_request' in sp!)) { backToPlain(); return; }
      if (sp!.armed_by_request === c.requestId) { if (!c.keySeen) setConsent({ ...c, keySeen: true }); return; }
      // Another request (or an immediate approval) opened this window: R's did not.
      dropConsent(LAPSED());
      return;
    }
    if (c.keySeen) { dropConsent(LAPSED()); return; }
    if (sp?.state === 'pending') {
      if (sp.pending?.op_id && sp.pending.op_id !== c.requestId) { dropConsent(LAPSED()); return; }
      if (!c.requestSeen) setConsent({ ...c, requestSeen: true });
      return;
    }
    // Closed after its request was seen pending: it lapsed or was cancelled. Before that, the view may
    // still be the one from before the request (a budget approval refreshes spending afterwards): wait.
    if (c.requestSeen) dropConsent(LAPSED());
  });
  createEffect(on(() => messageShown().msat, (msat) => {
    const c = untrack(consent);
    // Another chat's price is not this message's: leaving is said as leaving (below).
    if (c && trackKey(props.track) === trackKey(c.track) && msat !== c.msat) dropConsent(tr('uiThePriceChangedWhileItWaitedForApproval'));
  }, { defer: true }));
  createEffect(on(() => trackKey(props.track), () => { cancelHanded(); dropConsent(tr('uiYouLeftThisChatBeforeItWasApproved')); }, { defer: true }));
  createEffect(() => { if (props.moneyBlocked) dropConsent(tr('uiYourNodeWentOfflineBeforeItWasApproved')); });
  createEffect(on(consent, (c) => {
    if (!c) return;
    const timer = setTimeout(() => { if (untrack(consent) === c) dropConsent(tr('uiItWasNotApprovedWithin10Minutes')); }, Math.max(0, c.until - Date.now()));
    onCleanup(() => clearTimeout(timer));
  }));
  onCleanup(() => { cancelHanded(); dropConsent(tr('uiYouLeftBeforeItWasApproved')); });
  // Its own approval succeeded and cleared: the waiting bubble goes once, through
  // the ordinary path. Transient guards (busy, a stale budget read, a contact
  // wait) keep it waiting rather than ending it.
  createEffect(() => {
    const c = consent();
    if (!c || !c.approved || busy() || contactWaiting() || props.budgetStale || props.moneyBlocked || !approvalCleared()) return;
    if (c.kind === 'touch') {
      // Only the envelope its own Touch ID call returned, live and covering the price, on a fresh read.
      void props.now;
      if (!c.keySeen || !touchLive(c)) return;
    } else if (c.kind === 'budget') {
      // Only autopay armed by its own request R, live on a fresh read; the stand must take this message as it is.
      if (!c.keySeen || !budgetLive(c, budget(), Math.max(props.now, Date.now()))) return;
      const k = stand().kind;
      if (k === 'first') {
        // A first contact needs its own approval: the words go back to the box, with the reason.
        backToPlain();
        setNote(tr('uiThisFirstContactNeedsItsOwnApprovalPress'));
        return;
      }
      if (k !== 'ok') { dropConsent(LAPSED()); return; }
    } else {
      // Only the window its own approval armed (its grant op G, or its request R).
      const sp = props.spend;
      if (sp?.state !== 'open') return;
      if (c.key !== null ? sp.granted_op !== c.key : !(c.requestId !== null && 'armed_by_request' in sp && sp.armed_by_request === c.requestId)) return;
    }
    if (Date.now() >= c.until) { dropConsent(tr('uiItWasNotApprovedWithin10Minutes')); return; }
    setConsent(null);
    void (async () => {
      await submit(c.msat, c);
      if (!c.taken) props.actions.settleWaiting(c.track, c.bubble, untrack(note) ?? tr('uiItCouldNotBeSentAfterTheApproval'));
    })();
  });
  /**
   * Approve & send continuations handed to the send queue and not dispatched
   * yet. The queue outlives this chat, so each stays watched until its turn
   * (below), and re-checks right before it (stillBound). Leaving the chat
   * cancels it; so does any revocation seen meanwhile, for good.
   */
  const [handed, setHanded] = createSignal<Pressed[]>([]);
  const cancel = (p: Pressed, reason: string) => {
    if (p.cancelled) return;
    p.cancelled = true;
    p.cancelReason = reason;
  };
  function cancelHanded() {
    untrack(handed).forEach((p) => cancel(p, tr('uiYouLeftThisChatBeforeItWasSent')));
    setHanded([]);
  }
  /**
   * Sticky: once a handed continuation sees what it was approved for revoked
   * or lapsed, it is cancelled for good; a later read showing it again does
   * not revive it. Touch ID: approvals on this Mac stopping, or a fresh, not
   * stale read whose grant expired or whose contact entry is missing, another
   * id, or ended. Spending request: its window closing, or another G/R.
   */
  /** The spending window its own approval armed (G or R) is still open, and not past its end. */
  const windowStill = (p: Pressed, sp: SpendView | null | undefined, now: number) =>
    sp?.state === 'open' && sp.open_until_ms != null && sp.open_until_ms > now &&
    (p.key !== null ? sp.granted_op === p.key : p.requestId !== null && 'armed_by_request' in sp && sp.armed_by_request === p.requestId);
  createEffect(() => {
    const list = handed();
    if (!list.length) return;
    const now = Math.max(props.now, Date.now());
    const sp = props.spend;
    const deviceOn = props.actions.device()?.state === 'registered';
    const fresh = !props.budgetStale;
    const g = budget()?.node_grant ?? null;
    const here = props.track ? trackKey(props.track) : null;
    const price = messageShown().msat;
    const gone = list.filter((p) => {
      if (p.cancelled) return true;
      // The price it was approved at is not this contact's price any more: never sent at the old one.
      if (here === trackKey(p.track) && price !== null && price !== p.msat) { cancel(p, PRICE_MOVED()); return true; }
      if (p.kind === 'touch') {
        if (!deviceOn) { cancel(p, tr('uiStoppedBeforeItWentThrough', isMobilePlatform() ? tr('uiBiometricApprovalsOnThis', deviceWord() === 'phone' ? tr('phone') : deviceWord()) : tr('uiTouchIDApprovalsOnThisMac'))); return true; }
        if (!fresh || props.actions.budgetReadApplied() < p.readsFrom) return false;
        const peer = (p.track as { id: string }).id.toLowerCase();
        const until = g?.envelopes?.[peer];
        if (!g || g.expires_at_ms <= now || g.envelope_id_by_recipient?.[peer] !== p.envelope || !until || until <= now) { cancel(p, LAPSED()); return true; }
        return false;
      }
      if (p.kind === 'budget') {
        if (!fresh || props.actions.budgetReadApplied() < p.readsFrom) return false;
        if (!budgetLive(p, budget(), now)) { cancel(p, LAPSED()); return true; }
        // Allowed by its own R, but this message is over (or waiting on) a budget limit: not sent, even if it recovers later.
        if (here === trackKey(p.track) && standFor(p) !== 'ok') { cancel(p, BUDGET_SHORT()); return true; }
        return false;
      }
      if (!windowStill(p, sp, now)) { cancel(p, LAPSED()); return true; }
      return false;
    });
    if (gone.length) setHanded(list.filter((p) => !gone.includes(p)));
  });
  /**
   * The owner cancelled the node request: every wait bound to a node request
   * (a budget press's R, a spending request's R or G) ends for good, whether
   * still waiting or handed to the queue; a read that later shows it armed
   * never sends it. Touch ID waits, and anything already dispatched, are not
   * touched.
   */
  createEffect(on(props.actions.spendCancels, () => {
    const CANCELLED = tr('uiYouCancelledTheRequestNothingWasSent');
    const byRequest = (p: Pressed) => p.kind === 'budget' || p.kind === 'grant';
    const c = untrack(consent);
    if (c && byRequest(c)) dropConsent(CANCELLED);
    const list = untrack(handed);
    list.filter(byRequest).forEach((p) => cancel(p, CANCELLED));
    setHanded(list.filter((p) => !byRequest(p)));
  }, { defer: true }));
  /**
   * Its turn came just after an action's own budget response cleared the
   * freshness stamp, while the read that action started is still out: hold
   * the turn until that read lands (at most 10 s), then check as usual. A
   * stale or failed read still withdraws it (stillBound).
   */
  const followUp = async (p: Pressed) => {
    if (p.kind !== 'touch' && p.kind !== 'budget') return;
    const read = untrack(props.actions.followUpRead);
    if (read) await Promise.race([read, new Promise((r) => setTimeout(r, 10_000))]);
  };
  /** Why a handed-off approve & send must not go now (it becomes a Not sent card), or null. */
  const stillBound = (p: Pressed): string | null => untrack(() => {
    setHanded((list) => list.filter((x) => x !== p));
    if (p.cancelled) return p.cancelReason ?? tr('uiYouLeftThisChatBeforeItWasSent');
    if (trackKey(props.track) !== trackKey(p.track)) return tr('uiYouLeftThisChatBeforeItWasSent');
    if (props.moneyBlocked) return tr('uiYourNodeWentOfflineBeforeItWasSent');
    if (Date.now() >= p.until) return tr('uiItWasNotApprovedWithin10Minutes');
    // A budget read known to be stale proves nothing, for either kind.
    if (props.budgetStale) return p.kind === 'touch' ? TOUCH_AGAIN() : p.kind === 'budget' ? BUDGET_AGAIN() : tr('uiSpendingNeedsApprovingAgainPressSendToAsk');
    // Only at the price it was approved at (null: the price is being read again, so it is not confirmed).
    if (messageShown().msat !== p.msat) return PRICE_MOVED();
    if (p.kind === 'touch') return touchLive(p) ? null : TOUCH_AGAIN();
    if (p.kind === 'budget') return !budgetLive(p, budget(), Date.now()) ? LAPSED() : standFor(p) !== 'ok' ? BUDGET_SHORT() : null;
    return windowStill(p, props.spend, Date.now()) ? null : LAPSED();
  });
  /** The bubble a send uses: the waiting one it continues (handed over now), else a new one. */
  const bubbleFor = (t: TrackRef, text: string, cap: number, pressed: Pressed | null) => {
    if (!pressed) return props.actions.beginSending(t, text, cap);
    pressed.taken = true;
    setHanded((list) => [...list, pressed]);
    props.actions.settleWaiting(pressed.track, pressed.bubble, null);
    return pressed.bubble;
  };

  /**
   * `shownMsat`: the message price the owner saw on the button they pressed
   * (Send in chat). If the price is not that any more, nothing is sent: the
   * new price shows on Send, which needs another press. `pressed`: an
   * Approve & send continuing after its approval (its words are in its bubble).
   */
  const submit = async (shownMsat?: number | null, pressed: Pressed | null = null, budgetChoice?: FirstSpendChoice) => {
    if (!pressed && consent() && mode() === 'message' && !approvalCleared()) {
      setNote(tr('uiAMessageIsAlreadyWaitingForApprovalIn'));
      return;
    }
    if (!pressed && mode() === 'message' && !draft().trim()) return;
    if (props.moneyBlocked || (spends() && props.budgetStale) || busy() || contactWaiting()) return;
    if (mode() === 'message' && priceProblem()) { setNote(priceProblem()); return; }
    // An unknown payment result: the text stays in the box until it is checked.
    const wait = mode() === 'message' ? queue.blocked() : null;
    if (wait) { setNote(wait); return; }
    setNote(null);
    if (shownMsat !== undefined && (mode() !== 'message' || shown().msat !== shownMsat)) {
      setNote(tr('uiTheMessagePriceChangedSinceYouPressedNothing'));
      return;
    }
    if (budgetChoice && !needsFirstSpend()) return;
    if (!pressed && needsFirstSpend() && !budgetChoice) {
      if (!ready()) return;
      setFirstSpendOpen(true);
      return;
    }
    if (needsTouch()) {
      if (pressed) { setNote(TOUCH_AGAIN()); return; }
      // Where the host names each contact's envelope, the message waits in its
      // bubble and goes once that very envelope is live (approve & send);
      // otherwise this contact is approved and the draft stays (plain flow).
      const msat = shown().msat;
      const continuing = canContinue('touch');
      if (continuing) startWaiting('touch');
      const started = continuing ? untrack(consent) : null;
      setBusy(true);
      const approved = await props.actions.approveContact(target(), msat);
      if (continuing) afterTouch(approved, started);
      setBusy(false);
      if (!continuing) approvedPlain(approved.ok);
      return;
    }
    if (viaBudget()) {
      const st = stand();
      if (st.kind === 'paused' || st.kind === 'off') {
        if (pressed) { setNote(BUDGET_AGAIN()); return; }
        // The one approval (or resume). Where the host names the request that
        // arms autopay, the message waits in its bubble and goes once that very
        // request armed it (approve & send); otherwise the draft stays (plain).
        const asks = st.kind === 'paused' || budgetChoice !== undefined;
        const continuing = asks && canContinue('budget');
        if (continuing) startWaiting('budget');
        const started = continuing ? untrack(consent) : null;
        setBusy(true);
        let approved: ApprovalResult = { ok: false, requestId: null, grantedOp: null, bindable: false, waiting: false };
        if (st.kind === 'paused') approved = await props.actions.resume();
        else if (budgetChoice) approved = await props.actions.approveBudget(budgetChoice.ceiling_msat, budgetChoice.id);
        if (continuing) afterBudget(approved, started);
        setBusy(false);
        if (!continuing) approvedPlain(approved.ok, approved.waiting);
        return;
      }
      if (st.kind !== 'first' && st.kind !== 'ok') return;
      if (!ready(pressed?.text)) {
        // A press before the price is known must not look like a send: the draft
        // stays, and the owner sees why nothing moved (real-window step 10).
        setNote((pressed ? pressed.text : draft()).trim() ? tr('uiTheMessagePriceIsNotReadyYetNothing') : tr('uiTypeAMessageFirst'));
        return;
      }
      setBusy(true);
      const submittedRevision = composerRevision;
      const submittedApprovalRevision = approvalRevision;
      const submittedPeer = target();
      const submittedTrack = props.track;
      const submittedText = pressed ? pressed.text : draft();
      const submittedFile = file();
      const submittedMode = mode();
      const cap = shown().msat!;
      if (submittedMode === 'message') { setPaidLine(null); setRaisedFrom(null); }
      const first = st.kind === 'first' ? firstPick() ?? st.suggest : undefined;
      const dispatch = async (bubble?: string) => {
      // A message is in the stream as "Sending…" (its bubble) by now; the box
      // was freed when it became a send and is never touched from here.
      if (submittedMode === 'message' && bubble && queue.held()) { queue.holdBack(submittedTrack, bubble, submittedText); return; }
      if (submittedMode === 'message' && bubble && pressed) await followUp(pressed);
      const unbound = submittedMode === 'message' && bubble && pressed ? stillBound(pressed) : null;
      if (unbound) { queue.withdraw(submittedTrack, bubble!, submittedText, unbound); return; }
      const r = submittedMode === 'file'
        ? await props.actions.file(submittedTrack, submittedFile!, cap, first)
        : await props.actions.send(submittedTrack, submittedText, cap, first, bubble);
      const unchanged = composerRevision === submittedRevision;
      noteBreaker(r);
      if (unchanged && submittedMode === 'message') {
        paymentResult(r);
        if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) { setRaisedFrom(cap); setReadmitQuote(null); }
      }
      if (r.ok && readmitQuote()?.peer === submittedPeer) setReadmitQuote(null);
      if (!r.ok && r.error.code === 'readmission_quoted' && r.error.admission) setReadmitQuote({ peer: submittedPeer, price: r.error.admission });
      if (r.ok && readmitFor() === submittedPeer) setReadmitFor(null);
      else if (!r.ok && unchanged && ['price_changed', 'price_cap_exceeded'].includes(r.error.code) && doorWanted()) {
        // The stranger's price moved: ask for their signed quote again.
        setDoor(null);
      } else if (!r.ok && r.error.code === 'grant_readmission') {
        if (target() === submittedPeer) setDoor(null);
        setReadmitFor(submittedPeer);
      }
      // An optimistic message cleared the box at the press; whatever is there now is newer.
      if ((r.ok || paidUndelivered(r)) && composerRevision === submittedRevision && !bubble) {
        if (submittedMode === 'file') {
          fileGone();
        } else {
          setDraft('');
          setDrafted(false);
        }
      } else if (!r.ok && unchanged && r.error.code === 'owner_contact_expired') {
        setOwnerExpired(true);
        setNote(r.error.message);
      } else if (!r.ok && unchanged && (isBudgetStop(r.error) || ['owner_only', 'owner_contact_unavailable'].includes(r.error.code))) setNote(r.error.message);
      if (submittedMode === 'message') queue.settled(r, submittedTrack, submittedText, pressedAt(submittedRevision));
      };
      // The owner approved (at the node or on another device): the press becomes
      // a send now. The box still holds exactly this text (any edit cancelled the wait).
      const approvedSend = async () => {
        if (submittedMode !== 'message') { setBusy(true); try { await queue.enqueue(() => dispatch()); } finally { setBusy(false); } return; }
        const bubble = props.actions.beginSending(submittedTrack, submittedText, cap);
        setDraft('');
        setDrafted(false);
        // An earlier result is open: approved, but it waits for the check; never sent on its own.
        if (queue.held()) { queue.holdBack(submittedTrack, bubble, submittedText); return; }
        await queue.enqueue(() => dispatch(bubble));
      };
      const waitingText = submittedMode === 'message' ? { message: { track: submittedTrack, text: submittedText } } : {};
      // A contact our node already admitted (it holds their session) is no first
      // contact at the node: no owner approval, only this app's own contact budget.
      // A re-admission still asks, and the node still refuses anything unapproved.
      const admitted = first !== undefined && !room() && !readmit() && props.actions.knownAtNode?.(submittedPeer) === true;
      // Capability-gated, not remote-gated, on purpose: the node's local router
      // mounts request + status, so a pairing on this Mac may ask too (approving
      // is remote-only and happens on another owner device).
      if (pressed && first !== undefined && !room() && !admitted) {
        // A first contact needs its own approval: an Approve & send does not chain into a second one.
        setNote(tr('uiThisFirstContactNeedsItsOwnApprovalPress'));
        setBusy(false);
        return;
      }
      if (first !== undefined && !room() && !admitted && props.actions.ownerDeviceApproval?.()) {
        // Owner approval v1: the owner approves on their other device instead of at the node.
        // Captured before the await: leaving while the request is out keeps the text on its chat.
        requesting = waitingText.message ?? null;
        const asked = leaveGeneration;
        const request = await props.actions.approvalRequest({ kind: 'first_contact', terms: { recipient: submittedPeer, max_total_msat: cap, ...(first ? { budget_msat: first } : {}) } });
        requesting = null;
        // Left while it was out: the text is already kept on its chat; nothing goes on from here.
        if (asked !== leaveGeneration) { setBusy(false); return; }
        if (composerRevision !== submittedRevision || approvalRevision !== submittedApprovalRevision || props.moneyBlocked) {
          setBusy(false);
          return;
        }
        if (!request.ok) {
          setNote(refusalText(request.error.code, { reason: request.error.reason, remaining_msat: request.error.remaining_msat }));
          setBusy(false);
          return;
        }
        setDeviceWait({ view: request.value, revision: submittedRevision, peer: submittedPeer, cap, budget: first, send: approvedSend, ...waitingText });
        setBusy(false);
        return;
      }
      if (first !== undefined && !room() && !admitted) {
        requesting = waitingText.message ?? null;
        const asked = leaveGeneration;
        const request = await props.actions.ownerRequest(submittedPeer, cap, first);
        requesting = null;
        if (asked !== leaveGeneration) {
          // Left while it was out (the text is kept on its chat): withdraw the request; never send, even on a null answer.
          if (request.ok && request.value) void props.actions.ownerCancel(request.value.id);
          setBusy(false);
          return;
        }
        if (composerRevision !== submittedRevision || approvalRevision !== submittedApprovalRevision || props.moneyBlocked) {
          if (request.ok && request.value) void props.actions.ownerCancel(request.value.id);
          setBusy(false);
          return;
        }
        if (!request.ok) {
          setNote(request.error.message);
          setBusy(false);
          return;
        }
        if (request.value) {
          setOwnerWait({
            approval: request.value,
            revision: submittedRevision,
            ...waitingText,
            send: approvedSend,
          });
          setBusy(false);
          return;
        }
      }
      if (submittedMode === 'message') {
        // At the press: the bubble goes into the stream and the composer is
        // free for the next message; the send itself waits its turn.
        const bubble = bubbleFor(submittedTrack, submittedText, cap, pressed);
        if (!pressed) {
          setDraft('');
          setDrafted(false);
        }
        setBusy(false);
        await queue.enqueue(() => dispatch(bubble));
        return;
      }
      await dispatch();
      setBusy(false);
      return;
    }
    if (spends() && !line().open) {
      if (pressed) { setNote(tr('uiSpendingNeedsApprovingAgainPressSendToAsk')); return; }
      // The one tap asks the node for a spending window. Where the host names the
      // request or the grant it armed, the message then goes once (Approve & send).
      startWaiting('grant');
      setBusy(true);
      const approved = await props.actions.approve();
      afterApproval(approved);
      setBusy(false);
      return;
    }
    if (!ready(pressed?.text)) {
      setNote(
        mode() === 'message' && (pressed ? pressed.text : draft()).trim()
          ? tr('uiTheMessagePriceIsNotReadyYetNothing')
          : tr('uiNothingWasSentYetFinishTheFieldsFirst'),
      );
      return;
    }
    if (mode() === 'pay') {
      // Pay never pays from here: it shows the review, and only its confirm pays.
      setReview(
        payKind() === 'invoice'
          ? invoiceReview(invoiceRead()!)
          : { kind: 'keysend', pubkey: pubkey().trim(), msat: amountMsat()!, memo: memo() },
      );
      return;
    }
    setBusy(true);
    const t = props.track;
    const submittedRevision = composerRevision;
    const unchanged = () => composerRevision === submittedRevision;
    let r: Awaited<ReturnType<Actions['send']>>;
    switch (mode()) {
      case 'message': {
        const peer = target();
        setPaidLine(null);
        setRaisedFrom(null);
        const cap = shown().msat!;
        const text = pressed ? pressed.text : draft();
        // Optimistic, as in the budget path: the bubble now, the send in turn.
        const bubble = bubbleFor(t, text, cap, pressed);
        if (!pressed) {
          setDraft('');
          setDrafted(false);
        }
        setBusy(false);
        const go = async () => {
          if (queue.held()) { queue.holdBack(t, bubble, text); return; }
          if (pressed) await followUp(pressed);
          const unbound = pressed ? stillBound(pressed) : null;
          if (unbound) { queue.withdraw(t, bubble, text, unbound); return; }
          const r = await props.actions.send(t, text, cap, undefined, bubble);
          noteBreaker(r);
          if (unchanged()) {
            paymentResult(r);
            if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) { setRaisedFrom(cap); setReadmitQuote(null); }
          }
          if (r.ok && readmitQuote()?.peer === peer) setReadmitQuote(null);
          if (!r.ok && r.error.code === 'readmission_quoted' && r.error.admission) setReadmitQuote({ peer, price: r.error.admission });
          if (!r.ok && unchanged() && isBudgetStop(r.error)) setNote(r.error.message);
          queue.settled(r, t, text, pressedAt(submittedRevision));
        };
        await queue.enqueue(go);
        return;
      }
      case 'pay':
        return;
      case 'request':
        r = await props.actions.invoice(t, amountMsat()!, memo());
        if (r.ok && unchanged()) {
          setAmount('');
          setMemo('');
          setCreated(r.value as InvoiceView);
        } else if (!r.ok && unchanged()) setNote(r.error.message);
        break;
      case 'file':
        r = await props.actions.file(t, file()!, shown().msat!);
        if (r.ok && unchanged()) fileGone();
        else if (!r.ok && unchanged() && isBudgetStop(r.error)) setNote(r.error.message);
        break;
    }
    setBusy(false);
  };

  /** The confirm tap: pays exactly the reviewed amount through the same host command. */
  const confirmPay = async () => {
    const rv = review();
    if (!rv || props.moneyBlocked || props.budgetStale || busy() || !line().open) return;
    // Consumed at dispatch: a review pays at most once, whatever happens to
    // the draft while the host answers. Paying again needs a new review.
    setReview(null);
    setNote(null);
    setBusy(true);
    setPaying(true);
    const t = props.track;
    const submittedRevision = composerRevision;
    const r = await (rv.kind === 'invoice'
      ? props.actions.pay(t, rv.bolt11, rv.msat)
      : props.actions.keysend(t, rv.pubkey, rv.msat, rv.memo)
    ).finally(() => setPaying(false));
    if (composerRevision === submittedRevision) {
      if (r.ok) {
        setBolt11('');
        setAmount('');
        setMemo('');
      } else if (isBudgetStop(r.error)) setNote(r.error.message);
    }
    setBusy(false);
  };
  /**
   * Send in chat: the created invoice as an ordinary message, through the
   * Send button's own path (its price, budget and approvals). The draft shows
   * exactly what is sent; if an approval comes first, it waits there.
   */
  const sendInChat = async () => {
    const inv = created();
    if (!inv || props.moneyBlocked || busy() || contactWaiting()) return;
    // The price on the pressed button is the only price this press may pay.
    const pressedMsat = messageShown().msat;
    setMode('message');
    setDraft(inv.bolt11);
    setDrafted(false);
    await submit(pressedMsat);
    if (untrack(draft) === '') setCreated(null);
  };
  const chatPrice = () => {
    const c = messageShown();
    return c.msat === null ? '' : ` · ${c.estimate ? '≈ ' : ''}${sats(c.msat)} ${satUnit(c.msat)}`;
  };

  // A closed spending window or money going offline withdraws the review.
  createEffect(() => { if (props.moneyBlocked || props.budgetStale || !line().open) setReview(null); });

  const disabled = () =>
    (mode() === 'message' && !draft().trim()) || (mode() === 'file' && !file()) || props.moneyBlocked || (spends() && !!props.budgetStale) || busy() || contactWaiting() || (mode() === 'message' && priceProblem() !== null) ||
    (needsTouch() ? false : viaBudget()
      ? ['waiting', 'contact_used', 'total_used', 'grant_limited', 'unknown'].includes(stand().kind) || ((stand().kind === 'first' || stand().kind === 'ok' || stand().kind === 'off') && !ready())
      : spends() && !line().open
      ? props.spend?.state === 'pending' || props.spend?.state === 'unavailable' || props.spend === null
      : !ready());

  const disabledReason = (): string | null => {
    if (!disabled()) return null;
    if (mode() === 'message' && !draft().trim()) return tr('uiTypeAMessageFirst');
    if (mode() === 'file' && !file()) return tr('uiChooseAFileFor', props.name);
    if (props.moneyBlocked) return tr('firstSpendOffline');
    if (spends() && props.budgetStale) return tr('firstSpendChecking');
    if (busy()) return tr('firstSpendBusy');
    if (contactWaiting()) return tr('uiWaitingForContactApproval');
    if (mode() === 'message' && priceProblem()) return priceProblem();
    if (blocked()) return blocked();
    if (viaBudget()) {
      switch (stand().kind) {
        case 'waiting': return tr('uiWaitingForApproval');
        case 'contact_used':
        case 'total_used': return tr('uiBudgetUsedUp');
        case 'grant_limited': return tr('uiNodeGrantLimit');
        case 'unknown': return tr('firstSpendChecking');
      }
    }
    if (spends() && !line().open && !viaBudget()) {
      if (props.spend?.state === 'pending') return tr('uiWaitingForApproval');
      if (!props.spend || props.spend.state === 'unavailable') return tr('uiSpendingUnavailable');
    }
    if (mode() === 'message' && !draft().trim()) return tr('uiTypeAMessageFirst');
    return tr('firstSpendCompleteForm');
  };

  return (
    <form
      class="composer"
      data-composer
      data-swipe-approval={!!consent() || !!contactWaiting()}
      data-mode={mode()}
      onInput={() => { cancelOwner(); composerRevision++; setPaidLine(null); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.repeat && !e.shiftKey && !e.isComposing) e.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={(el) => { fileInput = el; }}
        type="file"
        class="sr-only"
        tabindex="-1"
        data-file-input
        onChange={(e) => {
          attachmentEdit++;
          composerRevision++;
          const picked = e.currentTarget.files?.[0] ?? null;
          // Said at once, before any price or Send: this file can never go.
          if (picked && picked.size > FILE_MAX_BYTES) {
            e.currentTarget.value = '';
            setFile(null);
            setNote(tr('uiThatFileIsOver14MB', picked.name));
            return;
          }
          setNote(null);
          setFile(picked);
        }}
        aria-label={tr('uiFileToSend')}
      />

      <Switch>
        <Match when={mode() === 'file'}>
          <div class="composer-panel file-panel" data-composer-panel="file">
            <div class="panel-head">
              <strong>{voiceFile() ? tr('uiSendAVoiceNote') : tr('uiSendAFile')}</strong>
              <button type="button" class="link" data-composer-close aria-label={tr('uiClose')} onClick={closePanel}>✕</button>
            </div>
            <div class="composer-main file-row">
              <button
                type="button"
                class="attach soft icon-btn"
                data-file-choose
                aria-label={tr('uiChooseAFile')}
                title={tr('uiChooseAFile')}
                onClick={() => fileInput?.click()}
              >
                +
              </button>
              <div class="file-chip" data-file-chip>
                <Show when={file()} fallback={<span class="hint">{recording() ? tr('uiRecordingUpTo', duration(recording()?.rec.limitMs ?? VOICE_MAX_MS)) : tr('uiChooseAFileFor', props.name)}</span>}>
                  {(f) => (
                    <Show when={voicePreview()} fallback={<span class="file-name">{f().name}</span>}>
                      <audio controls src={voicePreview()!} data-voice-preview aria-label={tr('uiVoiceNotePreview')} />
                    </Show>
                  )}
                </Show>
                <button type="button" class="link" onClick={closePanel}>
                  {tr('uiRemove')}
                </button>
                {/* The price shows here in every state, approval pending or not, as it does under the message bar. */}
                <span class="hint" data-file-price={mode() === 'file' && shown().msat !== null ? shown().msat! : undefined}>
                  {shown().msat !== null ? tr('uiUpToIncludesMaxRoutingFee', fmtAmount(shown().msat!)) : shown().basis} {tr('uiFilesUpTo14MB')}
                </span>
              </div>
              <button type="submit" class="primary soft money" disabled={disabled()} data-send title={label()} aria-label={label()}>
                {label()}
              </button>
            </div>
          </div>
        </Match>
        <Match when={mode() === 'pay'}>
          <div class="fields pay-flow composer-panel" data-composer-panel="pay">
            <div class="panel-head">
              <strong>{tr('uiPay')} {props.name}</strong>
              <button type="button" class="link" data-composer-close aria-label={tr('uiDone')} onClick={closePanel}>{tr('uiDone')}</button>
            </div>
            <div class="modes soft small" role="tablist" aria-label={tr('uiHowToPay')}>
              <button type="button" role="tab" aria-selected={payKind() === 'invoice'} onClick={() => { if (payKind() === 'invoice') return; composerRevision++; setPayKind('invoice'); }}>{tr('uiInvoice')}</button>
              <button type="button" role="tab" aria-selected={payKind() === 'keysend'} onClick={() => { if (payKind() === 'keysend') return; composerRevision++; setPayKind('keysend'); }}>{tr('uiDirect')}</button>
            </div>
            <Show
              when={payKind() === 'invoice'}
              fallback={
                <>
                  <AmountField data="pay" label={tr('uiAmountToPay283')} value={amount()} onInput={setAmount} cleared={amountCleared()} />
                  <input data-pay-pubkey placeholder={tr('uiTheirLightningNodeID')} value={pubkey()} onInput={(e) => setPubkey(e.currentTarget.value)} aria-label={tr('uiLightningNodePubkey')} />
                  <input data-pay-note placeholder={tr('uiNoteOptional')} value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label={tr('uiNote')} />
                </>
              }
            >
              <div class="amount-field shown" data-pay-invoice-amount={invoiceMsat() ?? ''}>
                <span class="amount-value">{invoiceMsat() === null ? '0' : sats(invoiceMsat()!)}</span>
                <span class="amount-unit">{invoiceMsat() === null ? unitName() : satUnit(invoiceMsat()!)}</span>
              </div>
              <textarea data-pay-invoice rows={2} placeholder={tr('uiPasteAnInvoiceFrom', props.name)} value={bolt11()} onInput={(e) => setBolt11(e.currentTarget.value)} aria-label={tr('uiLightningInvoice')} />
            </Show>
            <Show
              when={review()}
              fallback={
                <div class="composer-bar">
                  <div class="cost" data-cost>
                    <span class="label">{tr('uiCostToSend')}</span>
                    <Show when={shown().msat !== null} fallback={<span class="sats">…</span>}>
                      <span class="sats" data-cost-msat={shown().msat!}>
                        {sats(shown().msat!, true)}
                        <span class="unit">{satUnit(shown().msat!)}</span>
                      </span>
                    </Show>
                    <span class="basis" title={shown().basis}>{shown().basis}</span>
                  </div>
                  <button type="submit" class="primary soft money" disabled={disabled()} data-send>
                    {label()}
                  </button>
                </div>
              }
            >
              {(rv) => (
                <div class="pay-review" data-pay-review data-review-msat={rv().msat} data-review-max-msat={allIn(rv().msat)}>
                  <Show
                    when={rv().kind === 'invoice'}
                    fallback={
                      <>
                        {/* A typed pubkey is not bound to this chat's contact either. */}
                        <p class="pay-review-title">{tr('uiPayALightningNodeDirectly')}</p>
                        <PayeeLine payee={(rv() as { pubkey: string }).pubkey.toLowerCase()} peer={target()} name={props.name} />
                      </>
                    }
                  >
                    {/* Whoever sent or pasted the invoice need not be who it pays. */}
                    <p class="pay-review-title">{tr('uiPayThisLightningInvoice')}</p>
                    <PayeeLine payee={(rv() as { payee: string }).payee} peer={target()} name={props.name} />
                  </Show>
                  <dl>
                    <dt>{tr('uiAmount')}</dt>
                    <dd data-review-amount>{fmtAmount(rv().msat)}</dd>
                    <dt>{tr('uiNetworkFee')}</dt>
                    <dd data-review-fee>{tr('uiUpTo178')} {fmtAmount(routingFee(rv().msat))}</dd>
                    <dt>{tr('uiTotalAtMost')}</dt>
                    <dd data-review-total>{fmtAmount(allIn(rv().msat))}</dd>
                    <Show when={rv().kind === 'keysend' && (rv() as { memo: string }).memo.trim()}>
                      <dt>{tr('uiNote')}</dt>
                      <dd>{(rv() as { memo: string }).memo.trim()}</dd>
                    </Show>
                  </dl>
                  <div class="composer-bar">
                    <button type="button" class="link" data-pay-back disabled={busy()} onClick={() => setReview(null)}>{tr('uiBack')}</button>
                    <span class="basis">{tr('uiYouPayTheRealFeeNeverAboveThis')}</span>
                    <button type="button" class="primary soft money" data-pay-confirm disabled={busy() || props.moneyBlocked} onClick={() => void confirmPay()}>
                      {tr('uiConfirmAndPay')}
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Match>
        <Match when={mode() === 'request'}>
          <div class="fields pay-flow composer-panel" data-composer-panel="request">
            <div class="panel-head">
              <strong>{tr('uiRequestFrom', props.name)}</strong>
              <button type="button" class="link" data-composer-close aria-label={tr('uiDone')} onClick={closePanel}>{tr('uiDone')}</button>
            </div>
            <AmountField data="request" label={tr('uiAmountToRequest')} value={amount()} onInput={setAmount} cleared={amountCleared()} />
            <input data-request-note placeholder={tr('uiWhatForEGDinner')} value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label={tr('uiWhatItIsFor')} />
            <div class="composer-bar">
              <div class="cost" data-cost>
                <span class="basis" data-request-hint>{tr('uiMakesAnInvoiceAndQRHereSendIt')} {props.name} {tr('uiCanPayItReceivingIsFree')}</span>
              </div>
              <button type="submit" class="primary soft money" disabled={disabled()} data-send>
                {label()}
              </button>
            </div>
            <Show when={created()}>
              {(inv) => (
                <div class="composer-bar" data-request-created>
                  <span class="basis">
                    {tr('uiInvoiceFor')} {fmtAmount(inv().amount_msat)} {tr('uiIsReadySendItTo')} {props.name} {tr('uiAsAChatMessageItPaysLikeAny')}
                  </span>
                  <button type="button" class="primary soft money" data-send-in-chat disabled={props.moneyBlocked || busy() || contactWaiting()} onClick={() => void sendInChat()}>
                    {tr('uiSendInChat')}{chatPrice()}
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>

      {/* Above the capsule: the terms read before Send, which is the Touch ID tap. */}
      <Show when={needsTouch() && !props.budgetStale}>
        <TouchApproval peer={target()} name={props.name} priceMsat={shown().msat} actions={props.actions} />
      </Show>
      <div class="composer-main signal-bar" data-composer-bar>
        <div class="composer-emoji-wrap">
        <button
          ref={emojiBtn}
          type="button"
          class="attach soft icon-btn"
          data-emoji
          aria-label={tr('uiEmoji')}
          aria-expanded={emojiOpen()}
          title={tr('uiEmoji')}
          disabled={mode() !== 'message'}
          onClick={() => setEmojiOpen((v) => !v)}
        >
          <svg class="composer-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" /><path d="M9 9.5v.01M15 9.5v.01" /></svg>
        </button>
      <Show when={emojiOpen()}>
        <div ref={(el) => { emojiPicker = el; }} class="emoji-picker" data-emoji-picker role="group" aria-label={tr('uiEmoji')}>
          <For each={[...EMOJIS]}>
            {(e) => (
              <button
                type="button"
                class="emoji-pick"
                data-emoji-pick={e}
                onClick={() => {
                  const el = draftInput;
                  const start = el?.selectionStart ?? draft().length;
                  const end = el?.selectionEnd ?? start;
                  const { next, caret } = insertEmoji(draft(), e, start, end);
                  composerRevision++;
                  setDraft(next);
                  setEmojiOpen(false);
                  queueMicrotask(() => {
                    el?.focus();
                    el?.setSelectionRange(caret, caret);
                  });
                }}
              >
                {e}
              </button>
            )}
          </For>
        </div>
      </Show>
        </div>
        <textarea
          ref={(el) => { draftInput = el; }}
          rows={1}
          placeholder={tr('uiMessage', props.name)}
          value={draft()}
          disabled={mode() !== 'message'}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Signal-like: Enter sends, Shift+Enter is a new line.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (!e.repeat) void submit();
            }
          }}
          aria-label={tr('uiMessage', props.name)}
        />
        <Show when={!room()}>
          <button
            type="button"
            class="attach soft icon-btn voice-record"
            classList={{ recording: recording() !== null }}
            data-voice-record={recording() ? 'stop' : 'start'}
            aria-label={recording() ? tr('uiStopRecording') : tr('uiRecordAVoiceNote')}
            title={recording() ? tr('uiStopRecording') : tr('uiRecordAVoiceNoteUpTo', duration(VOICE_MAX_MS))}
            disabled={starting() || busy()}
            onClick={() => void (recording() ? stopRecording() : startVoice())}
          >
            {recording() ? `■ ${duration(recordedMs())}` : <svg class="composer-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></svg>}
          </button>
          <div class="composer-plus-wrap">
            <button
              ref={plusBtn}
              type="button"
              class="attach soft icon-btn"
              data-composer-plus
              aria-label={tr('uiMoreAttachPayRequest')}
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              title={tr('uiAttachPayOrRequest')}
              onClick={() => setMenuOpen((v) => !v)}
            >
              +
            </button>
            <div ref={(el) => { plusMenu = el; }} class="composer-menu" data-composer-menu role="menu" hidden={!menuOpen()}>
              <For each={modes().filter((m) => m !== 'message')}>
                {(m) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="composer-menu-item"
                    data-composer-mode={m}
                    data-attach={m === 'file' ? '' : undefined}
                    onClick={() => {
                      setMenuOpen(false);
                      // The file panel takes the bar's place, Stop included. Settle the
                      // recording first, as leaving the window does: the clip stays as the
                      // unsent preview unless a pick, Remove or Close comes before it lands.
                      // Not every chooser blurs the window, so this cannot be left to blur.
                      // The chooser still opens in this same press.
                      if (m === 'file') onLeave();
                      if (m === 'file') fileInput?.click();
                      // Reselecting the active mode is not an edit: it must not
                      // detach an in-flight send from the draft it will clear.
                      if (mode() === m) return;
                      composerRevision++;
                      setMode(m);
                      setNote(null);
                    }}
                  >
                    {{ message: tr('uiMessage315'), pay: tr('uiPay'), request: tr('uiRequest'), file: tr('uiAttach') }[m]}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={mode() === 'message'}>
          <button
            type="submit"
            class="primary soft send-btn money"
            disabled={disabled()}
            data-send
            aria-describedby={disabledReason() ? sendReasonId : undefined}
            onClick={(e) => { if (e.detail > 1) e.preventDefault(); }}
            title={sendTitle()}
            aria-label={sendTitle()}
          >
            {sendTitle()}
          </button>
        </Show>
      </div>
      <Show when={disabledReason()}>
        {/* An empty box needs no telling before anyone has tried anything: only a screen reader hears why Send is off. */}
        <p id={sendReasonId} class="hint" classList={{ 'sr-only': mode() === 'message' && !draft().trim() }} data-send-disabled-reason>{disabledReason()}</p>
      </Show>
      <Show when={mode() === 'message' && liveGrantRemaining() !== null}>
        <p class="hint" data-send-budget>{tr(budget()?.autopay.state === 'open' ? 'sendBudgetRemaining' : 'caNodeGrantSeparateLimits', fmtAmount(liveGrantRemaining()!))}</p>
        <Show when={budget()?.autopay.state !== 'open' ? appBudgetRemaining() : null}>
          {(left) => <p class="hint" data-send-app-budget>{left().contact === null
            ? tr('caAppTotalRemaining', fmtAmount(left().total))
            : tr('caAppContactRemaining', fmtAmount(left().contact!), fmtAmount(left().total), tr(room() ? 'uiThisRoom' : 'caThisContact'))}</p>}
        </Show>
      </Show>
      <div class="composer-meta">
      <Show when={mode() === 'message'}>
        <div class="send-price" classList={{ priced: !priceProblem() && (paidLine() !== null || messageShown().msat !== null) }}>
          <span data-send-price aria-live="polite">{priceLine()}</span>
          <Show when={firstContactCostLine()}><span class="first-contact-cost" data-first-contact-cost>{firstContactCostLine()}</span></Show>
          <Show when={priceProblem() && priceProblem() !== tr('uiPriceLoading')}>
            {' '}<button type="button" class="link" data-price-retry disabled={busy()} onClick={retryPrice}>{tr('uiRetry')}</button>
          </Show>
        </div>
      </Show>
      <details class="composer-info" data-composer-info>
        <summary aria-label={tr('uiCostAndRules')} title={tr('uiCostAndRules')}><span aria-hidden="true">ⓘ</span></summary>
        <Show when={breakdown()}>
          {(b) => (
            <>
              <dl class="price-breakdown" data-price-breakdown>
                <dt>{tr('uiNamedPrice', possessive(props.name))}</dt>
                <dd>{fmtAmount(b().priceMsat)}</dd>
                <dt>{tr('uiRoutingFeeAtMost')}</dt>
                <dd>{fmtAmount(b().routingMsat)}</dd>
                <dt class="total">{tr('uiYouPayAtMost')}</dt>
                <dd class="total">{fmtAmount(b().ceilingMsat)}</dd>
              </dl>
              <p class="hint price-note">
                {tr('uiACeilingNotAChargeTheAmountActually')}
                <Show when={b().routingMsat >= b().priceMsat}> {tr('uiRoutingCanCostMoreThanTheMessageItself')}</Show>
              </p>
            </>
          )}
        </Show>
        <Show when={mode() === 'message' || mode() === 'file'}>
          <div class="composer-bar cost-only">
            <div class="cost" data-cost>
              <span class="label">{tr('uiCostToSend')}</span>
              <Show when={shown().msat !== null} fallback={<span class="sats">…</span>}>
                <span class="sats" data-cost-msat={shown().msat!}>
                  {shown().estimate ? '≈ ' : ''}
                  {sats(shown().msat!, true)}
                  <span class="unit">{satUnit(shown().msat!)}</span>
                </span>
              </Show>
              <span class="basis" title={shown().basis}>{shown().basis}</span>
            </div>
          </div>
        </Show>
        <Show when={mode() === 'pay'}>
          <p data-budget-payment><strong>{tr('uiPaymentRules')}</strong> {tr('uiAppInvoicePaymentsAndKeysendReservePrincipalPlus')}</p>
        </Show>
        <Show when={mode() === 'file'}>
          <p data-budget-file><strong>{tr('uiFileSpendRules')}</strong> {tr('uiFilesReservePrincipalPlusTheNetworkFeeCeiling')}</p>
        </Show>
      </details>
      </div>

      <Show when={mode() === 'message' && readmitPrice()}>
        {(p) => (
          <>
            <p class="hint" data-readmission-quote>
              {props.name} {tr('uiAsksForAdmissionAgain')} {sats(p().admission_msat)} {satUnit(p().admission_msat)}{tr('uiNothingWasPaidSendAgain')} {sats(p().total_msat)} {satUnit(p().total_msat)} {tr('uiInAll')}
            </p>
            <details class="quiet-detail" data-readmission-detail>
              <summary>{tr('uiDetails')}</summary>
              <p>{tr('uiTheSameMessageKeepsItsOperationSoIt')}</p>
            </details>
          </>
        )}
      </Show>
      <Show when={drafted()}>
        <p class="drafted" data-drafted>
          {tr('uiDraftedInTheAITrackCheckItAnd')} {mode() === 'request' ? tr('uiCreateTheInvoice') : tr('uiSendIt')} {tr('uiYourself')}
        </p>
      </Show>
      <Show when={blocked()}>
        <p class="err-note" data-room-blocked>{blocked()}</p>
      </Show>
      <Show when={note() && note() !== MONEY_NOT_READY}>
        <p class="err-note" data-composer-note role="status">{note()}</p>
      </Show>
      <Show when={ownerExpired()}>
        <button type="button" class="link" data-contact-requote onClick={() => {
          setDoor(null);
          setOwnerExpired(false);
          setNote(null);
          props.refreshPrice();
        }}>{tr('uiGetAFreshQuote')}</button>
      </Show>
      <Show when={breaker()}>
        {(reason) => <BreakerCard
          reason={reason()}
          now={props.now}
          offerReset={props.actions.breakerResetOffered?.() === true}
          request={() => props.actions.approvalRequest({ kind: 'breaker_reset', terms: {} })}
          status={props.actions.approvalStatus}
          // The card stays to say "reset, press Send again"; the next send (or chat) clears it.
          onReset={() => props.actions.refreshBudget?.()}
        />}
      </Show>
      <Show when={deviceWait()}>
        {(w) => <OwnerApprovalWait
          view={w().view}
          now={props.now}
          status={props.actions.approvalStatus}
          fallback={w().view.owner_action}
          after={tr('caSendsWhenApproved')}
          onStop={() => setDeviceWait(null)}
          onApproved={(v) => deviceApproved(w(), v)}
        />}
      </Show>
      <Show when={ownerWait()?.recipient ? ownerWait() : null}>
        {/* Approved on the other device: the node's grant is checked, then the message goes at once. */}
        <div class="approval" data-contact-approval="device-approved">
          <p class="ok-note" role="status">{tr('uiApprovedOnYourOtherDeviceSendingAsSoon')} {ownerCountdown()} {tr('uiS')}</p>
          <button type="button" class="link" data-contact-cancel onClick={() => cancelOwner()}>{tr('uiCancel')}</button>
        </div>
      </Show>
      <Show when={ownerWait() && !ownerWait()!.recipient ? ownerWait() : null}>
        {(pending) => <TouchIdFirst actions={props.actions} stays={<p class="hint" data-touch-id-stays-text="first-contact">
            {tr('uiThisMessageSendsAutomaticallyOnceYourNodeS')}{' '}
            <button type="button" class="link" data-contact-cancel-visible onClick={() => cancelOwner()}>{tr('uiCancel')}</button> {tr('uiStopsIt')}
          </p>}><div class="approval" data-contact-approval="pending" data-contact-request={JSON.stringify(pending().approval.request)}>
          <p><strong>{tr('uiApproveThisContactAtYourNode')}</strong> {tr('uiRunThisCommandOnceInTheOwnerS')}</p>
          <p>{tr('uiTheCommandApprovesThisContactSBudgetAnd')}</p>
          <Show when={pending().approval.approval_window_secs !== undefined}>
            <p role="status" data-contact-countdown>{tr('uiWaitingForRemoteApproval')} {Math.floor(ownerCountdown() / 60)}:{String(ownerCountdown() % 60).padStart(2, '0')} {tr('uiRemaining')}</p>
          </Show>
          <OperatorDetails>
            <textarea readonly aria-label={tr('uiOwnerApprovalCommand')} data-contact-owner-command data-command={pending().approval.owner_command} value={pending().approval.owner_command} />
            <button type="button" class="link" onClick={async () => { try { await navigator.clipboard.writeText(pending().approval.owner_command); } catch { setNote(tr('uiSelectAndCopyTheCommandAbove')); } }}>{tr('uiCopyCommand')}</button>
          </OperatorDetails>
          <button type="button" class="link" data-contact-cancel onClick={() => cancelOwner()}>{tr('uiCancel')}</button>
          <p class="hint">{tr('uiCancelDoesNotRevokeAnApprovalAlreadyIssued')} {pending().approval.approval_window_secs !== undefined ? tr('caFive') : tr('caTwo')} {tr('uiMinutes')}</p>
        </div></TouchIdFirst>}
      </Show>
      <Show when={spends()}>
        <Show when={!props.budgetStale} fallback={<p class="spend-line" data-budget-stale>{tr('uiSpendGrantStaleCheckingYourNodeAutoPay')}</p>}>
          <Show
            when={viaBudget()}
            fallback={<SpendBar spend={props.spend} error={props.approvalError ?? props.spendError} now={props.now} actions={props.actions} hasPending={props.hasPending} stays={mode() === 'message' ? (consent() ? tr('uiYourMessageWaitsInItsBubbleAndSends') : tr('uiYourDraftIsKeptNothingIsSentUntil')) : undefined} />}
          >
            <BudgetBar
              stand={stand()}
              budget={budget()!}
              spend={props.spend}
              name={props.name}
              room={room()}
              target={target()}
              priceMsat={shown().msat}
              door={doorQuote()}
              firstPick={firstPick()}
              onFirstPick={setFirstPick}
              error={props.budgetError ?? props.approvalError}
              now={props.now}
              actions={props.actions}
              hasPending={props.hasPending}
              waitingSend={consent() !== null}
            />
          </Show>
        </Show>
      </Show>
      <Show when={firstSpendOpen()}>
        <FirstSpendSheet
          onSetupApprovals={touchIdOffer(props.actions) ? () => { setFirstSpendOpen(false); props.actions.openNodeSettings?.(); } : undefined}
          presets={budget()?.presets ?? []}
          initialPreset={presetChosen()?.id ?? null}
          maxDailyMsat={budget()?.max_daily_msat ?? 0}
          grant={props.actions.localApproval?.() ? undefined : budget()?.node_grant ?? undefined}
          startsNow={props.actions.localApproval?.() === true || !!budget()?.node_grant}
          mayStartNow={props.actions.spendScoped?.() === true}
          lapse={props.spend?.state === 'expired' ? props.spend.lapse : null}
          dailyExpired={budget()?.autopay.state === 'expired'}
          onRetry={priceProblem() && priceProblem() !== tr('uiPriceLoading') && !busy() ? retryPrice : undefined}
          costLine={mode() === 'file' && props.filePrice
            ? tr('firstSpendFileCost', fmtAmount(props.filePrice.principal_msat), fmtAmount(props.filePrice.max_routing_fee_msat), fmtAmount(props.filePrice.total_msat))
            : firstContactCostLine() ?? priceLine() ?? tr('uiPriceLoading')}
          blockedReason={disabledReason()}
          onPreset={id => { setPresetPick(id); saveSpendPreset(props.ownId, id); }}
          onCancel={() => setFirstSpendOpen(false)}
          onAllow={choice => {
            if (disabled() || !needsFirstSpend()) return;
            setFirstSpendOpen(false);
            void submit(undefined, null, choice);
          }}
        />
      </Show>
    </form>
  );
}

/**
 * The owner's spend window. One tap opens it for ten minutes; it can only
 * narrow what the node allows, never widen it.
 */
/** This Mac can approve with Touch ID but is not set up yet (registration exists for a remote node only). */
const touchIdOffer = (actions: Actions) => {
  const d = actions.device();
  return actions.remote?.() === true && !!d?.available && (d.state === 'none' || d.state === 'lapsed');
};


// How many Touch ID offers are on screen: the spend bar's own "not set up"
// pointer stays quiet while one is, so it is never said twice.
const [touchIdOffersShown, setTouchIdOffersShown] = createSignal(0);

/**
 * Where a send or first contact stalls on a command at the node, the in-app
 * path comes first when this Mac could approve with Touch ID but is not set
 * up: one button to its home (Settings → Node). Setting it up asks the
 * node's owner to approve this Mac once; after that one Touch ID tap approves
 * a contact here. The node command stays under "Other ways". `stays` is what
 * is true for THIS card about the draft (and its Cancel); it always stays in
 * view. What gets approved and its limits are unchanged.
 */
function TouchIdFirst(props: { actions: Actions; stays: JSX.Element; children: JSX.Element }) {
  const mobile = isMobilePlatform();
  const device = () => mobile ? (deviceWord() === 'phone' ? tr('phone') : deviceWord()) : tr('uiMac');
  const tap = () => mobile ? tr('caBiometric') : tr('uiAuthenticatorName');
  const Offer = () => {
    setTouchIdOffersShown((n) => n + 1);
    onCleanup(() => setTouchIdOffersShown((n) => n - 1));
    const lapsed = () => props.actions.device()?.state === 'lapsed';
    return (
      <div class="approval touch-id-first" data-touch-id-first>
        <p>
          <strong>{tr('uiApproveOnThis')} {device()} {tr('uiWith')} {mobile ? tr('biometrics') : tr('uiTouchID')}.</strong>{' '}
          {lapsed()
            ? tr('uiYourLastSetupRequestLapsedSetItUp', device())
            : tr('uiSetItUpOnceYourNodeSOwner', device())}{' '}
          {/* Only promised where the node says it does it; otherwise, said as it is today. */}
          {props.actions.ownerDeviceApproval?.()
            ? tr('uiAfterThatOneTapApprovesAContactHere', tap())
            : tr('uiYourNodeDoesNotYetAcceptApprovalsIn', mobile ? tr('uiBiometricApprovals') : tr('uiAuthenticatorApprovals'), tap())}
        </p>
        <div class="form-actions">
          <button type="button" class="primary soft" data-touch-id-setup onClick={() => props.actions.openNodeSettings?.()}>
            {tr('uiSetUp')} {mobile ? tr('uiBiometricApprovals') : tr('uiAuthenticatorApprovals')}
          </button>
        </div>
        <div data-touch-id-stays>{props.stays}</div>
        <details class="other-ways" data-other-ways>
          <summary>{tr('uiOtherWays')}</summary>
          {props.children}
        </details>
      </div>
    );
  };
  return <Show when={touchIdOffer(props.actions)} fallback={props.children}><Offer /></Show>;
}

/** What is true while a spend request waits, for whichever action raised it (the default holds for every consumer). */
const spendWaitDefault = () => tr('spendWaitDefault');

/**
 * The node's own approval, in plain words: the box needs one yes from the
 * person who set it up. The exact line stays closed under Details, for that
 * person only; nothing outside it names a command or a terminal.
 */
function NodeApprovalSteps(props: { command?: string | null }) {
  return <>
    <p class="hint" data-approval-who>{tr('caApprovalWho')}</p>
    <Show when={props.command}>
      {(command) => <OperatorDetails>
        <ol class="approval-steps" data-approval-steps>
          <li>{tr('caApprovalStepOpen')}</li>
          <li>
            {tr('caApprovalStepPaste')}
            <code class="address" data-owner-action>{command()}</code>
            <CopyButton text={command()} label={tr('caApprovalCopy')} />
          </li>
          <li>{tr('caApprovalStepCode')}</li>
        </ol>
      </OperatorDetails>}
    </Show>
  </>;
}


function SpendBar(props: { spend: SpendView | null; error: string | undefined; now: number; actions: Actions; hasPending?: boolean; stays?: string; requestBudgetMsat?: number }) {
  const line = () => spendLine(props.spend, props.now);
  const stays = () => line().open ? tr('spendWaitReplacement') : props.stays ?? spendWaitDefault();
  const minutes = (ms: number) => Math.max(1, Math.ceil((ms - props.now) / 60_000));
  // One Ask again at a time: a double click must not print two requests at the node.
  const [asking, setAsking] = createSignal(false);
  usePairingActivity(asking);
  const askAgain = async () => {
    if (props.actions.moneyBlocked() || asking()) return;
    setAsking(true);
    try {
      await props.actions.approve(props.requestBudgetMsat);
    } finally {
      setAsking(false);
    }
  };
  return (
    <div class="spend" data-spend={props.spend?.state ?? 'unknown'}>
      <Show when={line().open}>
        <details class="quiet-detail passive-status" data-spend-status open={Boolean(props.spend?.pending)}>
          <summary aria-label={tr('uiSpendingStatus')} title={tr('uiSpendingStatus')}>ⓘ</summary>
          <p class="spend-line">
            <span class="dot ok" /> {line().text}.{' '}
            <button type="button" class="link" data-spend-lock onClick={() => void props.actions.lock()}>{tr('uiLockNow')}</button>
          </p>
          <details class="quiet-detail" data-spend-detail>
            <summary>{tr('uiDetails')}</summary>
            <p>
              {props.spend?.basis === 'app_lock'
                ? tr('uiThisNodeVersionDoesNotLimitAppTokens')
                : tr('uiYourNodeSOwnerGrantIsInEffect')}
            </p>
          </details>
        </details>
      </Show>
      <Switch>
        <Match when={(props.spend?.state === 'pending' || (props.spend?.state === 'open' && props.spend.pending?.owner_can_grant)) && props.spend.pending}>
          {(p) => (
            <TouchIdFirst actions={props.actions} stays={<p class="hint" data-touch-id-stays-text="spend">
              {stays()}{' '}
              <button type="button" class="link" data-spend-cancel-visible onClick={() => void props.actions.cancelSpend()}>{tr('uiCancelRequest')}</button>
            </p>}>
            <div class="approval" data-approval="pending">
              <p>
                <strong>{tr('uiConfirmAtYourNode')}</strong> {tr('uiYourNodeAsksItsOwnerToApproveThis')}
              </p>
              <NodeApprovalSteps command={p().owner_action} />
              <p class="hint">
                {tr('uiThisAppCannotApproveItForYouThe')} {minutes(p().expires_at_ms)} {tr('uiMinYourDraftIsKept')}{' '}
                <Show when={line().open}>{stays()}{' '}</Show>
                <button type="button" class="link" data-spend-cancel onClick={() => void props.actions.cancelSpend()}>
                  {tr('uiCancelRequest')}
                </button>
              </p>
            </div>
            </TouchIdFirst>
          )}
        </Match>
        <Match when={(props.spend?.state === 'unavailable' || (props.spend?.state === 'open' && props.spend.pending?.owner_can_grant === false)) && props.spend.pending}>
          {(p) => (
            <div class="approval" data-approval="unavailable">
              <p>
                <strong>{tr(line().open ? 'spendReplacementUnavailable' : 'uiThisNodeCannotGrantSpendingToTheApp')}</strong>
              </p>
              <OperatorDetails>
                <p>{tr('uiReceivingStillWorksYourNodeSays')}</p>
                <code class="address" data-owner-action>{p().owner_action}</code>
              </OperatorDetails>
            </div>
          )}
        </Match>
        <Match when={props.spend?.state === 'expired' && props.spend.lapse}>
          {(lapse) => (
            <p class="spend-line" data-spend-lapse={lapse()}>
              <span class="dot" />{' '}
              {lapse() === 'lost'
                ? tr('uiYourNodeCanNoLongerApproveThatRequest')
                : tr('uiThatRequestLapsedBeforeItWasApproved')}{' '}
              <button type="button" class="link" data-spend-ask-again disabled={props.actions.moneyBlocked() || asking()} onClick={() => void askAgain()}>
                {tr('uiAskAgain')}
              </button>
            </p>
          )}
        </Match>
        <Match when={!line().open}>
          <p class="spend-line">
            <span class="dot" /> {line().text}.{' '}
            {props.spend?.state === 'expired'
              ? tr('uiApproveAgainToKeepSending')
              : tr('uiSendingSpendsSatsFromYourNodeOneApproval')}
          </p>
        </Match>
      </Switch>
      {/* Not said twice: a pending request above already leads with the Touch ID offer. */}
      <Show when={(props.actions.remote?.() || props.actions.device()?.state === 'off') && touchIdOffersShown() === 0}>
        <DeviceSetup device={props.actions.device()} now={props.now} actions={props.actions} />
      </Show>
      <Reconcile actions={props.actions} hasPending={props.hasPending || Boolean(props.spend?.pending)} />
      <Show when={props.error}>
        <p class="err-note">{props.error}</p>
      </Show>
    </div>
  );
}

/** What one Touch ID tap allows a contact by default (the host uses the same). */
export const ENVELOPE_BUDGET_MSAT = 200_000;
export const envelopePerAct = (priceMsat: number | null) =>
  Math.min(Math.max(priceMsat ?? 10_000, 1_000), ENVELOPE_BUDGET_MSAT);

/**
 * Touch ID approvals: set up once (the owner approves this Mac at the node),
 * then one tap opens a contact's envelope. The console path stays for recovery.
 */
function DeviceSetup(props: { device: DeviceView | null; now: number; actions: Actions }) {
  // One home for Touch ID approvals (Settings → Node, and onboarding after
  // pairing); the spend bar only points there instead of repeating it.
  const mobile = isMobilePlatform();
  const what = () => (mobile ? tr('extraBiometricApprovals') : tr('extraTouchIDApprovals'));
  const note = () => {
    switch (props.device?.state) {
      case 'off': return tr('extraAreOff', what());
      case 'pending': return tr('extraAreWaitingForYourNodeSOwner', what());
      case 'none': case 'lapsed': return tr('extraAreNotSetUp', what());
      default: return null;
    }
  };
  return (
    <Show when={note()}>
      <p class="hint" data-device-settings-hint={props.device?.state}>
        {note()}{' '}
        <button type="button" class="link" data-device-settings-link onClick={() => props.actions.openNodeSettings?.()}>
          {tr('approvalSettingsDevices')}
        </button>
      </p>
    </Show>
  );
}

/**
 * One contact's envelope, approved with Touch ID: a slim line above the
 * composer. The terms and the contact's id show here before the tap, and the
 * system dialog repeats them. Send in the composer is the tap.
 */
export function TouchApproval(props: { peer: string; name: string; priceMsat: number | null; actions: Actions }) {
  const [expanded, setExpanded] = createSignal(false);
  const detailId = createUniqueId();
  const perAct = () => envelopePerAct(props.priceMsat);
  const mobile = isMobilePlatform();
  return (
    <div class="spend touch-line" data-touch-approval>
      <p class="spend-line">
        <span class="dot" />{' '}
        <span class="line-text">
          {/* The petname is local; Touch ID names the same key, never a name. */}
          <strong>
            {tr('uiApprove')} {props.name} {tr('extraNode')} <code data-touch-peer>{shortId(props.peer)}</code>{tr('extraWith')} {mobile ? tr('biometrics') : tr('uiTouchID')}.
          </strong> {tr('uiUpTo105')} <span data-touch-budget>{fmtAmount(ENVELOPE_BUDGET_MSAT)}</span> {tr('extraInTotalFor24HoursAtMost')}{' '}
          <span data-touch-per-act>{fmtAmount(perAct())}</span> {tr('extraPerMessage')}
        </span>
      </p>
      <div class="quiet-detail" data-touch-detail>
        <button type="button" class="touch-detail-toggle" aria-expanded={expanded()} aria-controls={detailId}
          onClick={() => setExpanded(value => !value)}>
          <span aria-hidden="true">{expanded() ? '▾' : '▸'}</span> {tr('uiDetails')}
        </button>
        <p id={detailId} hidden={!expanded()}>
          {mobile ? tr('extraTheBiometricPrompt') : tr('uiAuthenticatorPrompt')} {tr('extraShowsTheSameAmountsForNode')} {shortId(props.peer)}{tr('extraYourNodeChecksEveryPaymentAgainstThemNothing')}
        </p>
      </div>
    </div>
  );
}

/** Read-only: match an unknown outcome to the node's own records. Never re-sends. */
function Reconcile(props: { actions: Actions; hasPending?: boolean; onChecked?: (text: string) => void; onGone?: (text: string) => void; stopId?: string | null }) {
  const [result, setResult] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(false);
  usePairingActivity(checking);
  // Paid, not delivered: the owner may stop retrying (it dispatches nothing).
  // The record the check showed: Stop retrying names it, never whatever is pending later.
  const [undelivered, setUndelivered] = createSignal<string | null>(null);
  const stopId = () => undelivered() ?? props.stopId ?? null;
  createEffect(on(props.actions.pendingRevision, () => {
    setUndelivered(null);
    setResult(null);
  }, { defer: true }));
  const reconcile = async () => {
    if (checking()) return;
    setChecking(true);
    try {
      const revision = props.actions.pendingRevision();
      const outcome = await props.actions.reconcile();
      if (revision !== props.actions.pendingRevision()) return;
      // "No pending spend" reads as a dead end beside an approval that is still waiting.
      setResult(outcome.ok ? (/^no pending spend\.?$/i.test(outcome.value.trim()) ? tr('caNoPaymentWaiting') : outcome.value) : outcome.error.message);
      setUndelivered(!outcome.ok && outcome.error.code === 'undelivered_pending' ? outcome.error.pending_id ?? null : null);
      if (outcome.ok) props.onChecked?.(outcome.value);
    } finally { setChecking(false); }
  };
  const stop = async () => {
    if (checking()) return;
    setChecking(true);
    try {
      const outcome = await props.actions.stopRetrying(null, stopId());
      setResult(outcome.ok ? outcome.value : outcome.error.message);
      setUndelivered(null);
      // Already gone: the host no longer holds that record.
      if (!outcome.ok && outcome.error.code === 'retry_unavailable') props.onGone?.(outcome.error.message);
    } finally { setChecking(false); }
  };
  return (
    <>
      <Show when={props.hasPending}>
        <button type="button" class="link" data-spend-reconcile disabled={checking()} onClick={() => void reconcile()}>
          {tr('uiCheckPendingResult390')}
        </button>
      </Show>
      <Show when={stopId()}>
        <button type="button" class="link" data-stop-retrying disabled={checking()} onClick={() => void stop()}>
          {tr('uiStopRetrying')}
        </button>
      </Show>
      <Show when={result()}><p class="hint" data-reconciliation>{result()}</p></Show>
    </>
  );
}

/** Whole hours left, never more than the approval window (the shell clock ticks every few seconds). */
const hoursLeft = (untilMs: number | null, nowMs: number, windowMs = 86_400_000) =>
  Math.min(Math.round(windowMs / 3_600_000), Math.max(1, Math.ceil(((untilMs ?? nowMs) - nowMs) / 3_600_000)));

/** A node grant's remaining life: minutes under an hour, else whole hours. */
const timeLeft = (untilMs: number, nowMs: number) => {
  const min = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
  return min < 60 ? `${min} min` : tr('caHExtra625', Math.ceil(min / 60));
};



/**
 * Invisible payments (B2). Inside the owner's budget a message just goes: no
 * prompt, the price still shown, and the node still enforces each message's cap.
 * The bar says where the budget stands and is the only place that asks.
 */
function BudgetBar(props: {
  /** An Approve & send bubble waits on this approval. */
  waitingSend?: boolean;
  stand: BudgetStandT;
  budget: BudgetView;
  spend: SpendView | null;
  name: string;
  room: boolean;
  target: string;
  priceMsat: number | null;
  /** A stranger's signed quote, on a first paid message. */
  door: FirstContactQuote | null;
  firstPick: number | null;
  onFirstPick: (msat: number) => void;
  error: string | undefined;
  now: number;
  actions: Actions;
  hasPending?: boolean;
}) {
  const worth = (msat: number) => messagesWorth(msat, props.priceMsat);
  const who = () => (props.room ? tr('uiThisRoom') : props.name);
  const firstOptions = (suggest: number, ceiling: number) =>
    [...new Set([suggest, suggest * 2, suggest * 5].map((v) => Math.min(v, ceiling)))].filter((v) => v >= (props.priceMsat ?? 0));
  return (
    <div class="spend budget" data-budget={props.stand.kind}>
      <Switch>
        <Match when={props.stand.kind === 'paused'}>
          <p class="spend-line" data-budget-paused>
            <span class="dot warn" /> <span class="line-text">{tr('uiPaymentsArePausedNewAppPaymentsAreBlocked')}</span>
          </p>
        </Match>
        <Match when={props.stand.kind === 'waiting'}>
          <TouchIdFirst actions={props.actions} stays={<p class="hint" data-touch-id-stays-text="budget">
            {props.waitingSend
              ? tr('uiYourMessageWaitsInItsBubbleAndSends')
              : tr('uiYourDraftIsKeptNothingIsSentUntil')}
          </p>}>
          <div class="approval" data-approval="pending">
            <p>
              <strong>{tr('uiConfirmAtYourNode')}</strong> {tr('uiOneApprovalLetsMessagesPayForTheNext')}
            </p>
            <NodeApprovalSteps command={props.spend?.pending?.owner_action} />
            <p class="hint">{tr('uiThisAppCannotApproveItForYouYour')}</p>
          </div>
          </TouchIdFirst>
        </Match>
        <Match when={props.stand.kind === 'first' && (props.stand as Extract<BudgetStandT, { kind: 'first' }>)}>
          {(st) => (
            <div class="approval budget-first" data-first-contact>
              <Show when={st().again ? props.door : null}>
                {(q) => (
                  <p class="door-quote" data-door-quote={q().total_msat} data-readmit>
                    {who()} {tr('uiReconnectedAndAsksToBeAdmittedAgain')} <strong>{fmtAmount(q().admission_msat)}</strong>{tr('uiThen')}{' '}
                    <strong>{fmtAmount(q().message_msat)}</strong> {tr('uiForThisMessage')} <strong>{fmtAmount(q().total_msat)}</strong> {tr('uiInAllIncluding')} {feeCeiling(q().max_routing_fee_msat ?? 0)}{tr('uiNothingIsPaidUntilYouSend')}
                  </p>
                )}
              </Show>
              <Show when={st().again ? null : props.door}>
                {(q) => (
                  <p class="door-quote" data-door-quote={q().total_msat}>
                    {who()}{tr('uiSDoor')} <strong>{fmtAmount(q().admission_msat)}</strong> {tr('uiOnceToReachThemThen')}{' '}
                    <strong>{fmtAmount(q().message_msat)}</strong> {tr('uiAMessageThisFirstMessageCosts')}{' '}
                    <strong>{fmtAmount(q().total_msat)}</strong> {tr('uiInAllIncluding')} {feeCeiling(q().max_routing_fee_msat ?? 0)}{tr('uiNothingIsPaidUntilYouSend')}
                  </p>
                )}
              </Show>
              <Show
                when={st().again}
                fallback={
                  <p>
                    <strong>{tr('uiFirstPaidMessageTo')} {who()}.</strong> {tr('uiAskedOnceAfterItMessagesTo')} {who()} {tr('uiPayAutomaticallyUpTo')}
                  </p>
                }
              >
                <p>
                  <strong>{tr('uiAdmit')} {who()} {tr('uiAgain')}</strong> {tr('uiAskedOnceAfterItYourNodePaysA')} {who()} {tr('uiFromTheirBudgetWithoutAskingUpTo')}
                </p>
              </Show>
              <div class="presets" role="radiogroup" aria-label={tr('uiDailyBudgetFor', who())}>
                <For each={firstOptions(st().suggest, st().ceiling)}>
                  {(msat) => (
                    <button
                      type="button"
                      class="chip"
                      role="radio"
                      aria-checked={(props.firstPick ?? st().suggest) === msat}
                      data-first-budget={msat}
                      onClick={() => props.onFirstPick(msat)}
                    >
                      {fmtAmount(msat)} {tr('uiADay')}<Show when={worth(msat)}> · {worth(msat)}</Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'grant_limited'}>
          <p class="spend-line" data-node-grant-limit>{tr('uiYourNodeSSpendGrantCannotCoverThis')} {fmtAmount(props.budget.node_grant?.remaining_msat ?? 0)} {tr('uiLeftAndAllowsAtMost')} {fmtAmount(props.budget.node_grant ? messagePerPaymentMax(props.budget.node_grant) : 0)} {tr('uiPerPaymentAskYourNodeSOwnerFor')}</p>
        </Match>
        <Match when={props.stand.kind === 'contact_used' && (props.stand as Extract<BudgetStandT, { kind: 'contact_used' }>)}>
          {(st) => (
            <div class="approval budget-used" data-budget-used="contact">
              <p>
                <strong>{tr('uiBudgetFor')} {who()} {tr('uiUsedUp')}</strong> {fmtAmount(st().spent)} {tr('uiOf')} {fmtAmount(st().limit)} {tr('uiInTheLast24HoursAndThisMessage')} {props.priceMsat === null ? '…' : fmtAmount(props.priceMsat)}.
                <Show when={budgetNote(props.budget.rows.find(r => r.target === props.target && r.room === props.room))}>{note => <> {note()}.</>}</Show>
                {' '}{tr('uiItFreesUpAsOlderPaymentsPass24')}
              </p>
              <Show
                when={st().raiseTo}
                fallback={
                  <p class="hint">
                    {tr('uiThisBudgetAlreadyEqualsYourAppAllIn')}{' '}
                    <button type="button" class="link" data-budget-raise-total disabled={props.actions.moneyBlocked()} onClick={() => void props.actions.approveBudget(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat), props.budget.preset)}>
                      {tr('uiRaiseTheAppAllInLimitTo')} {fmtAmount(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat))}
                    </button>
                  </p>
                }
              >
                {(to) => (
                  <button type="button" class="primary small money" data-budget-raise disabled={props.actions.moneyBlocked()} onClick={() => void props.actions.setBudget(props.target, props.room, to())}>
                    {tr('uiRaiseTo')} {fmtAmount(to())} {tr('uiADay')}
                  </button>
                )}
              </Show>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'total_used' && (props.stand as Extract<BudgetStandT, { kind: 'total_used' }>)}>
          {(st) => (
            <div class="approval budget-used" data-budget-used="total">
              <p>
                <strong>{tr('uiYourAppAllInLimitIsUsedUp')}</strong> {fmtAmount(st().spent)} {tr('uiOf')} {fmtAmount(st().ceiling)} {tr('uiInTheLast24HoursRaisingItIs')} {budgetNote(props.budget)}
              </p>
              <Show when={st().raiseTo}>
                {(to) => (
                  <button type="button" class="primary small money" data-budget-raise-total disabled={props.actions.moneyBlocked()} onClick={() => void props.actions.approveBudget(to(), props.budget.preset)}>
                    {tr('uiApprove')} {fmtAmount(to())} {tr('uiInTotalForUpTo24Hours')}
                  </button>
                )}
              </Show>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'ok' && (props.stand as Extract<BudgetStandT, { kind: 'ok' }>)}>
          {(st) => (
            <div class="sr-only" data-budget-status>
              <p class="spend-line" data-budget-line>
                <span class="dot ok" />
                <span class="line-text">
                  {tr('uiPaysAutomatically')} {fmtAmount(st().spent)} {tr('uiOf')} {fmtAmount(st().limit)} {tr('uiTo')} {who()} {tr('uiIn24H')}
                  <Show when={budgetNote(props.budget.rows.find(r => r.target === props.target && r.room === props.room))}>{note => <> · {note()}</>}</Show>
                  {' '}{tr('uiApprovalEndsIn')}{' '}
                  {hoursLeft(props.budget.autopay.open_until_ms, props.now, props.budget.window_ms)} {tr('uiH')}{' '}
                  <button type="button" class="link" data-pause-all onClick={() => void props.actions.pauseAll()}>{tr('uiPauseAppPayments')}</button>
                </span>
              </p>
            </div>
          )}
        </Match>
      </Switch>
      <Reconcile actions={props.actions} hasPending={props.hasPending} />
      <Show when={props.error}>
        <p class="err-note" data-budget-error role="alert">{props.error}</p>
      </Show>
    </div>
  );
}

/**
 * An owner grant whose message cap (at most 6 sats) is below its call limit:
 * both are shown. Null when they are equal, and for a relation grant, whose
 * envelopes bound each contact (its line is the plain one).
 */
function grantSplitCaps(g: NodeGrantSummary): { message: number; call: number } | null {
  if (g.envelopes) return null;
  const message = messagePerPaymentMax(g);
  const call = callPerPaymentMax(g) ?? g.per_call_max_msat;
  return message < call ? { message, call } : null;
}

/**
 * The running tally (context panel): what left in the last 24 hours against the
 * daily total, per contact and room, and the one-tap pause for everything.
 */
function BudgetPanel(props: {
  budget: BudgetView | null;
  error: string | undefined;
  now: number;
  nameOf: (id: string, room: boolean) => string;
  actions: Actions;
}) {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [value, setValue, amountCleared] = createAmountDraft({ unit: () => 'sats', allowZero: true });
  const [note, setNote] = createSignal<string | null>(null);
  const pct = (spent: number, of: number) => `${Math.min(100, of > 0 ? (spent / of) * 100 : 0).toFixed(1)}%`;
  const save = async (row: BudgetRow) => {
    if (ambiguousThousands(value(), 'sats')) return setNote(tr('amountUseSpaces'));
    const msat = value().trim() === '0' ? 0 : parseAmount(value(), 'sats');
    if (msat === null) return setNote(tr('budgetInvalidAmount'));
    const r = await props.actions.setBudget(row.target, row.room, msat);
    if (r.ok) {
      setEditing(null);
      setNote(null);
    } else setNote(r.error.message);
  };
  const directPaymentName = (target: string) => target === 'app:invoice-payments' ? tr('caInvoicePayments')
    : target === 'app:keysend-payments' ? tr('caKeysendPayments') : null;
  const status = (b: BudgetView) => {
    if (b.paused) return tr('caPausedNewAppPaymentsBlocked');
    if (b.waiting_for_owner) return tr('caWaitingForNodeApproval');
    if (b.autopay.state === 'open') return tr('caAutopayOpenHLeft', hoursLeft(b.autopay.open_until_ms, props.now, b.window_ms));
    if (b.autopay.state === 'expired') return tr('caDailyApprovalEnded');
    return tr('caNotApprovedThisSession');
  };
  const statusDetail = (b: BudgetView) => {
    if (b.paused) return tr('caInFlightPaymentsAndSpendingOutsideThisAppCan');
    if (b.waiting_for_owner) return tr('caConfirmThePendingApprovalAtYourNode');
    if (b.autopay.state === 'open') return tr('caMessagesAndFilesPayInsideThisAllInLimit');
    if (b.autopay.state === 'expired') return tr('caApproveAgainFromAnyConversation');
    return tr('caApproveAnAppAllInLimitFromAnyConversation');
  };
  return (
    <div class="panel" data-panel="budget">
      <h2>{tr('caAppPaymentBudget')}</h2>
      <details class="quiet-detail hint" data-budget-scope>
        <summary><strong>{tr('caAppAllInRolling24H')}</strong>{' '}{tr('caWhatItCovers')}</summary>
        <p>
          {tr('caCoversAutomaticAndManualWindowMessagesRoomSendsFiles')}</p>
      </details>
      <Show when={props.budget} fallback={<Show when={!props.error} fallback={<p class="err-note">{props.error}</p>}><DelayedSpinner /></Show>}>
        {(b) => (
          <>
            <div class="tally" data-tally>
              <span class="label">{tr('caKnownPaidInTheLast24Hours')}</span>
              <span class="sats big" data-tally-total>
                {fmtAmount(b().spent_msat, true)} <span class="unit">/ {fmtAmount(b().ceiling_msat, true)}</span>
              </span>
              <span class="meter" aria-hidden="true"><span style={{ width: pct(b().spent_msat, b().ceiling_msat) }} /></span>
              <Show when={b().unsettled_msat > 0}>
                <span class="hint" data-unsettled>{fmtAmount(b().unsettled_msat)}{' '}{tr('caReservedAtSendCeilingsOutcomeNotKnownYet')}</span>
              </Show>
              <Show when={b().fee_unknown}>
                <span class="hint" data-fee-unknown>{budgetNote({ ...b(), unsettled_msat: 0, accounted_msat: (b().accounted_msat ?? b().spent_msat) - b().unsettled_msat })}</span>
              </Show>
              <Show when={b().node_grant}>
                {(g) => (
                  <span class="hint" data-node-grant>
                    {tr('caYourFiniteNodeGrantAllows')}{' '}{fmtAmount(g().remaining_msat)}{' '}{tr('uiOf')}{' '}{fmtAmount(g().budget_msat)}{' '}{tr('caMoreAtMost')}{' '}
                    <Show
                      when={grantSplitCaps(g())}
                      fallback={<>{fmtAmount(g().per_call_max_msat)}{' '}{tr('caPerPaymentFor')}</>}
                    >
                      {(caps) => <>{fmtAmount(caps().message)}{' '}{tr('caPerMessagePayment')}{' '}{fmtAmount(caps().call)}{' '}{tr('caPerCallPaymentFor')}</>}
                    </Show>
                    {' '}{timeLeft(g().expires_at_ms, props.now)}.
                  </span>
                )}
              </Show>
            </div>
            <p class="spend-line" classList={{ paused: b().paused }} data-autopay={b().paused ? 'paused' : b().autopay.state}>
              <span class={`dot ${b().paused ? 'warn' : b().autopay.state === 'open' ? 'ok' : ''}`} /> <span class="line-text">{status(b())}</span>
            </p>
            <details class="quiet-detail" data-budget-status-detail>
              <summary>{tr('uiDetails')}</summary>
              <p>{statusDetail(b())}</p>
            </details>
            <Show
              when={b().paused}
              fallback={
                <button type="button" class="pause-all" data-pause-all onClick={() => void props.actions.pauseAll()}>
                  {tr('uiPauseAppPayments')}</button>
              }
            >
              <button type="button" class="primary money" data-resume disabled={props.actions.moneyBlocked()} onClick={() => void props.actions.resume()}>
                {tr('uiResumePayments')}</button>
            </Show>
            <h3>{tr('caByActionContactAndRoom')}</h3>
            <For each={b().rows} fallback={<p class="hint">{tr('caNoOneHasABudgetYetYourFirstPaid')}</p>}>
              {(row) => {
                const key = () => `${row.room ? 'room' : 'peer'}:${row.target}`;
                return (
                  <div class="budget-row" data-budget-row={row.target}>
                    <div class="row" style={{ 'justify-content': 'space-between', gap: 'var(--s-2)' }}>
                      <span class="who">{directPaymentName(row.target) ?? props.nameOf(row.target, row.room)}</span>
                      <span class="sats" data-row-tally>
                        {fmtAmount(row.spent_msat, true)}
                        <span class="unit">{row.limit_msat === null ? tr('caApprovedByHand') : `/ ${fmtAmount(row.limit_msat, true)}`}</span>
                      </span>
                    </div>
                    <Show when={budgetNote(row)}>{note => <span class="hint">{note()}</span>}</Show>
                    <Show when={row.limit_msat !== null}>
                      <span class="meter" aria-hidden="true"><span style={{ width: pct(row.spent_msat, row.limit_msat!) }} /></span>
                    </Show>
                    <Show when={!directPaymentName(row.target)}>
                      <Show
                        when={editing() === key()}
                        fallback={
                          <button type="button" class="link" data-budget-edit onClick={() => { setEditing(key()); setValue(amountText(row.limit_msat ?? 0, 'sats')); setNote(null); }}>
                            {tr(row.limit_msat === null ? 'budgetSet' : 'budgetChange')}
                          </button>
                        }
                      >
                        <form class="row" onSubmit={(e) => { e.preventDefault(); void save(row); }}>
                          <input inputmode="decimal" value={value()} onInput={(e) => setValue(e.currentTarget.value)} aria-label={tr('budgetDailySats', props.nameOf(row.target, row.room))} data-budget-input />
                          <button type="submit" class="small" data-budget-save disabled={props.actions.moneyBlocked()}>{tr('budgetSave')}</button>
                          <button type="button" class="link" onClick={() => setEditing(null)}>{tr('uiCancel')}</button>
                        </form>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={editing() && amountCleared()}><p class="hint" role="status" data-amount-cleared>{tr('amountDraftCleared')}</p></Show>
            <Show when={note() && note() !== MONEY_NOT_READY}><p class="err-note" role="alert">{note()}</p></Show>
            <Show when={props.error}><p class="err-note" role="alert">{props.error}</p></Show>
            <p class="hint">
              {tr('caABudgetCanGoUpToTheAppAll')}</p>
          </>
        )}
      </Show>
    </div>
  );
}

/** Product default hides bitsov://introduce; money-safety tests enable the still-shipped door/consent UI. */
let showLegacyIntroductionUi = false;
export function setShowLegacyIntroductionUi(enabled: boolean) {
  showLegacyIntroductionUi = enabled;
}

/** Product default hides legacy prototype rooms; current rooms use node-verified bindings. */
let showLegacyRoomsUi = false;
export function setShowLegacyRoomsUi(enabled: boolean) {
  showLegacyRoomsUi = enabled;
}

function NewTrack(props: {
  nodeRooms: boolean;
  moneyBlocked: boolean;
  ownId: string;
  source: Source;
  spend: SpendView | null;
  now: number;
  actions: Actions;
  spendError: string | undefined;
  onContext: () => void;
  /** Continue succeeded; follow only while the originating form is unchanged. */
  onIntroduced: (card: Introduction, follow: boolean) => void;
}) {
  let active = true;
  let formRevision = 0;
  onCleanup(() => { active = false; });
  const editForm = () => { formRevision += 1; };
  // Product hides bitsov://introduce (protocol audit): Profile cards live under
  // Browse. Sponsor starter-bitcoin stays reachable on this track. Tests may
  // flip showLegacyIntroductionUi to exercise the still-shipped door/consent UI.
  // K1: your own signed introduction. Without one (older node, no dialable
  // endpoint) the plain node id is shown as before.
  const [mine, setMine] = createSignal<Introduction | null>(null);
  const [mineErr, setMineErr] = createSignal<string | null>(null);
  const loadMine = () => {
    setMineErr(null);
    props.source.introductionMine().then(setMine, (e) => {
      setMine(null);
      setMineErr(asActionError(e).message);
    });
  };
  if (showLegacyIntroductionUi) loadMine();
  const nowSecs = () => Math.floor(props.now / 1000);
  const mineLive = () => {
    if (!showLegacyIntroductionUi) return null;
    const m = mine();
    return m && m.expires_at > nowSecs() ? m : null;
  };
  const qr = createMemo(() => {
    const text = mineLive()?.offer_link ?? mineLive()?.link ?? props.ownId;
    try {
      return text ? qrSvg(text) : null;
    } catch {
      return null;
    }
  });
  const minutesLeft = (until: number) => Math.max(1, Math.ceil((until - nowSecs()) / 60));

  // K1: a scanned or pasted introduction. Reading it is local; Continue asks
  // the node to dial, and the conversation's door card does the rest.
  const [pasted, setPasted] = createSignal('');
  const [card, setCard] = createSignal<Introduction | null>(null);
  const [cardErr, setCardErr] = createSignal<string | null>(null);
  const [opening, setOpening] = createSignal(false);
  // The canonical link includes the signed payload and signature. Keep the
  // displayed key/address with it so consent can never migrate to another card.
  const [localConsent, setLocalConsent] = createSignal<Pick<Introduction, 'node_id' | 'endpoint' | 'link'> | null>(null);
  const allowLocal = (c: Introduction) => {
    const consent = localConsent();
    return consent !== null && consent.node_id === c.node_id && consent.endpoint === c.endpoint && consent.link === c.link;
  };
  let readRevision = 0;
  const cardLive = () => {
    const c = card();
    return c && c.expires_at > nowSecs() ? c : null;
  };
  const readCard = () => {
    const revision = ++readRevision;
    setCard(null);
    setLocalConsent(null);
    setAsk(null);
    setArrived(null);
    setAskErr(null);
    setCardErr(null);
    const text = pasted();
    props.source.introductionRead(text).then(
      (c) => {
        if (!active) return;
        // Even a stale completion invalidates consent, but it must not replace
        // the current card (including an input edited away and then restored).
        setLocalConsent(null);
        if (revision === readRevision) setCard(c);
      },
      (e) => {
        if (!active) return;
        setLocalConsent(null);
        if (revision === readRevision) setCardErr(asActionError(e).message);
      },
    );
  };
  // K1 slice 2, sponsor side: starter bitcoin in your introduction, and the
  // review of a newcomer's request. Offer/review use the spend window; each
  // gift needs an independent owner command at the node.
  const [sponsor, setSponsor] = createSignal<SponsorStatus | null>(null);
  props.source.sponsorStatus().then(setSponsor, () => setSponsor(null));
  const [kitErr, setKitErr] = createSignal<string | null>(null);
  const [ownerRequired, setOwnerRequired] = createSignal(false);
  const ownerStep = async (step: () => Promise<void>, fail: (m: string) => void) => {
    fail('');
    if (props.moneyBlocked) return;
    if (!open()) {
      await props.actions.approve();
      return;
    }
    try {
      await step();
    } catch (e) {
      const err = asActionError(e);
      if (err.code === 'sponsor_owner_approval_required') setOwnerRequired(true);
      else {
        fail(err.message);
        if (needsApproval(err)) await props.actions.approve();
      }
    }
  };
  const includeStarter = () =>
    ownerStep(async () => {
      setMine(await props.source.sponsorOffer());
    }, setKitErr);
  const [request, setRequest] = createSignal('');
  const [cand, setCand] = createSignal<SponsorCandidate | null>(null);
  const [theirCode, setTheirCode] = createSignal('');
  const [gift, setGift] = createSignal<SponsorKit | null>(null);
  const [ownerWait, setOwnerWait] = createSignal<SponsorOwnerApproval | null>(null);
  const [candErr, setCandErr] = createSignal<string | null>(null);
  const [giving, setGiving] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [cancelUnconfirmed, setCancelUnconfirmed] = createSignal(false);
  usePairingActivity(() => giving() || cancelling() || ownerWait() !== null || gift() !== null || cancelUnconfirmed());
  const giftPending = () => gift()?.state === 'paying' || gift()?.state === 'unknown';
  const requestLocked = () => props.moneyBlocked || giving() || !!ownerWait() || !!gift() || cancelUnconfirmed();
  let giftRevision = 0;
  let giftPoll: ReturnType<typeof setTimeout> | undefined;
  const stopGiftWait = () => {
    giftRevision += 1;
    clearTimeout(giftPoll);
    setOwnerWait(null);
    setOwnerRequired(false);
    setGiving(false);
  };
  onCleanup(() => { giftRevision += 1; clearTimeout(giftPoll); });
  const reviewRequest = () => {
    if (requestLocked()) return;
    stopGiftWait();
    const revision = giftRevision;
    setCand(null);
    setGift(null);
    setTheirCode('');
    return ownerStep(async () => {
      const c = await props.source.sponsorCandidate(request());
      if (active && revision === giftRevision) setCand(c);
    }, (message) => { if (active && revision === giftRevision) setCandErr(message); });
  };
  const pollGift = (c: SponsorCandidate, revision: number) => {
    const current = () => active && revision === giftRevision;
    const check = async () => {
      try {
        const status = await props.source.sponsorStatus();
        if (!current()) return;
        setSponsor(status);
        const kit = status.kits?.find((k) => k.intro_id === c.intro_id);
        if (kit) {
          if (kit.candidate?.newcomer !== c.newcomer || kit.candidate?.payment_hash !== c.payment_hash ||
              kit.candidate?.code !== c.code || kit.gift_msat !== c.gift_msat || kit.fee_msat !== c.fee_max_msat) {
            stopGiftWait();
            setCandErr(tr('caTheNodeStatusDiffersFromTheReviewedGiftReview'));
            return;
          }
          if (kit.state !== 'candidate' && kit.state !== 'offered') {
            setGift(kit);
            setOwnerWait(null);
            setOwnerRequired(false);
            if (kit.state !== 'paying' && kit.state !== 'unknown') return;
            await props.source.sponsorReconcile(c.intro_id);
            if (!current()) return;
          }
        }
      } catch (e) {
        if (!current()) return;
        const err = asActionError(e);
        if (err.code === 'sponsor_owner_approval_required') setOwnerRequired(true);
        else setCandErr(err.message);
      }
      if (current()) giftPoll = setTimeout(() => void check(), 3000);
    };
    void check();
  };
  const prepareGift = async () => {
    const c = cand();
    if (!c || requestLocked() || theirCode().length !== 6) return;
    const revision = ++giftRevision;
    const current = () => active && revision === giftRevision;
    setGiving(true);
    setCandErr(null);
    try {
      const approval = await props.source.sponsorOwnerApproval(c, theirCode());
      if (!current()) return;
      setOwnerWait(approval);
      setOwnerRequired(true);
      pollGift(c, revision);
    } catch (e) {
      if (!current()) return;
      const err = asActionError(e);
      if (err.code === 'sponsor_owner_approval_required') setOwnerRequired(true);
      else setCandErr(err.message);
    } finally {
      if (current()) setGiving(false);
    }
  };
  const cancelKit = async () => {
    const c = cand();
    if (!c || giving() || cancelling() || giftPending()) return;
    // Polling may invalidate its revision on a tuple mismatch while the
    // node still owes this candidate a cancellation response.
    const current = () => active && cand() === c;
    setCancelling(true);
    setCancelUnconfirmed(true);
    setCandErr(null);
    try {
      await props.source.sponsorCancel(c.intro_id);
      if (!current()) return;
      // Only the node's successful withdrawal releases the reviewed request.
      stopGiftWait();
      setCand(null);
      setGift(null);
      setTheirCode('');
      setCancelUnconfirmed(false);
    } catch (e) {
      if (!current()) return;
      setCandErr(asActionError(e).message);
      // A refusal or lost response may race with dispatch. Keep all visible
      // state and restart reads, including cancellation before owner-wait began.
      clearTimeout(giftPoll);
      pollGift(c, ++giftRevision);
    } finally {
      if (active) setCancelling(false);
    }
  };

  // K1 slice 2, newcomer side: ask for the offered starter bitcoin. Nothing
  // is sent: the request is shown to the inviter in person.
  const [ask, setAsk] = createSignal<FundingAsk | null>(null);
  const [arrived, setArrived] = createSignal<FundingStatus | null>(null);
  const [askErr, setAskErr] = createSignal<string | null>(null);
  const askQr = createMemo(() => {
    const a = ask();
    try {
      return a ? qrSvg(a.request) : null;
    } catch {
      return null;
    }
  });
  let poll: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => poll && clearInterval(poll));
  const requestStarter = () => {
    const c = card();
    if (props.moneyBlocked || !c?.offer_link) return;
    setAskErr(null);
    props.source.sponsorRequest(c.offer_link).then(
      (a) => {
        setAsk(a);
        setArrived(null);
        if (poll) clearInterval(poll);
        const check = () =>
          props.source.sponsorRequestStatus(a.payment_hash).then((st) => {
            if (st.state === 'received') {
              setArrived(st);
              if (poll) clearInterval(poll);
            }
          }, () => undefined);
        poll = setInterval(check, 3000);
        void check();
      },
      (e) => setAskErr(asActionError(e).message),
    );
  };

  const continueCard = () => {
    const c = cardLive();
    if (!c || opening() || (c.reach === 'local' && !allowLocal(c))) return;
    const startedRevision = formRevision;
    const unchanged = () => active && formRevision === startedRevision;
    setOpening(true);
    setCardErr(null);
    props.source.introductionOpen(c.link, c.reach === 'local' && allowLocal(c)).then(
      (opened) => {
        const follow = unchanged();
        if (active) setOpening(false);
        if (follow) {
          setLocalConsent(null);
          setCard(null);
          setPasted('');
        }
        props.onIntroduced(opened, follow);
      },
      (e) => {
        if (active) setOpening(false);
        if (unchanged()) setCardErr(asActionError(e).message);
      },
    );
  };
  const open = () => spendLine(props.spend, props.now).open;
  const [invitee, setInvitee] = createSignal('');
  const [addr, setAddr] = createSignal('');
  const [hours, setHours] = createSignal(72);
  const [made, setMade] = createSignal<{ link: string; until: number } | null>(null);
  const [token, setToken] = createSignal('');
  const [redeemed, setRedeemed] = createSignal<{ inviter: string; addr: string } | null>(null);
  const [errs, setErrs] = createStore<{ create?: string; redeem?: string }>({});
  const [busy, setBusy] = createSignal(false);

  usePairingActivity(busy);
  /** Invites change the node: outside the window the button is the approval. */
  const run = async (which: 'create' | 'redeem', action: () => Promise<void>) => {
    setErrs(which, undefined);
    setBusy(true);
    try {
      if (!open()) await props.actions.approve();
      else await action();
    } catch (e) {
      const err = asActionError(e);
      setErrs(which, err.message);
      if (needsApproval(err)) await props.actions.approve();
    }
    setBusy(false);
  };
  const button = (what: string) =>
    open() ? what : props.spend?.state === 'pending' ? tr('uiWaitingForApproval') : tr('caApproveFirst');
  const waiting = () => props.spend?.state === 'pending' || props.spend?.state === 'unavailable';

  return (
    <>
      <TrackHead title={tr('caStartSomething')} onContext={props.onContext} />
      <SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} />
      <div class="stream">
        <Show
          when={mineLive()}
          fallback={
            <div class="empty-track" data-new-track>
              <h2>{tr('caShareYourNodeId')}</h2>
              <p class="hint">
                {tr('caAnyoneWhoKnowsItCanOfferToPayYou')}</p>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label={tr('caYourNodeIdAsAQRCode')}>
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <code class="address">{props.ownId}</code>
              <Show when={sponsor()?.enabled}>
                <Show
                  when={mine()?.starter}
                  fallback={
                    <>
                      <button type="button" class="quiet" data-starter-include disabled={props.moneyBlocked} onClick={() => void includeStarter()}>
                        {open() ? tr('caIncludeStarterBitcoin', fmtAmount(sponsor()!.gift_msat)) : tr('caIncludeStarterBitcoinApproveFirst')}
                      </button>
                      <p class="hint" data-starter-purse>
                        {tr('caYouFundItFromYourOwnNodeOnlyAfter')}{' '}{fmtAmount(sponsor()!.purse_used_msat)}{' '}{tr('uiOf')}{' '}
                        {fmtAmount(sponsor()!.purse_msat)}{' '}{tr('caUsedInTheLast24Hours')}</p>
                    </>
                  }
                >
                  {(st) => (
                    <>
                      <p data-starter-offered>
                        {tr('caStarterBitcoinUpTo')}{' '}<strong>{fmtAmount(st().gift_msat)}</strong>{tr('caAfterYouApproveTheirRequestItIsTheirsOnce')}</p>
                      <code class="address" data-intro-link>{mine()!.offer_link ?? mine()!.link}</code>
                    </>
                  )}
                </Show>
                <Show when={kitErr() && kitErr() !== MONEY_NOT_READY}>
                  <p class="err-note" data-starter-error>{kitErr()}</p>
                </Show>
              </Show>
              <Show when={showLegacyIntroductionUi && mine()}>
                <p class="hint" data-intro-expired>
                  {tr('caYourIntroductionExpired')}{' '}<button type="button" class="link" onClick={loadMine}>{tr('caMakeANewOne')}</button>
                </p>
              </Show>
              <Show when={mineErr()}>
                {(e) => <SoftError message={e()} data="intro-unavailable" />}
              </Show>
            </div>
          }
        >
          {(m) => (
            <div class="empty-track" data-new-track data-intro-mine>
              <h2>{tr('caYourIntroduction')}</h2>
              <p class="hint">
                {tr('caLetSomeoneScanThisOrSendThemTheLink')}</p>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label={tr('caYourIntroductionAsAQRCode')}>
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <p data-intro-prices>
                {tr('caAdmission')}{' '}<strong>{fmtAmount(allIn(m().admission_msat))}</strong>{' '}{tr('caIncluding')}{' '}{feeCeiling(routingFee(m().admission_msat))}{tr('caEachMessage')}{' '}<strong>{fmtAmount(allIn(m().message_msat))}</strong>{' '}{tr('caIncluding')}{' '}{feeCeiling(routingFee(m().message_msat))}{' '}{tr('caEstimatedCeilings')}</p>
              <p class="hint">
                {tr('caValidForAbout')}{' '}{minutesLeft(m().expires_at)}{' '}{tr('caMin')}{' '}<button type="button" class="link" onClick={loadMine}>{tr('caNewCard')}</button>
              </p>
              <Show
                when={m().starter}
                fallback={
                  <Show when={sponsor()?.enabled}>
                    <button type="button" class="quiet" data-starter-include disabled={props.moneyBlocked} onClick={() => void includeStarter()}>
                      {open() ? tr('caIncludeStarterBitcoin', fmtAmount(sponsor()!.gift_msat)) : tr('caIncludeStarterBitcoinApproveFirst')}
                    </button>
                    <p class="hint" data-starter-purse>
                      {tr('caYouFundItFromYourOwnNodeOnlyAfter')}{' '}{fmtAmount(sponsor()!.purse_used_msat)}{' '}{tr('uiOf')}{' '}
                      {fmtAmount(sponsor()!.purse_msat)}{' '}{tr('caUsedInTheLast24Hours')}</p>
                  </Show>
                }
              >
                {(st) => (
                  <p data-starter-offered>
                    {tr('caStarterBitcoinUpTo')}{' '}<strong>{fmtAmount(st().gift_msat)}</strong>{tr('caAfterYouApproveTheirRequestItIsTheirsOnce')}</p>
                )}
              </Show>
              <Show when={kitErr() && kitErr() !== MONEY_NOT_READY}>
                <p class="err-note" data-starter-error>{kitErr()}</p>
              </Show>
              <code class="address" data-intro-link>{m().offer_link ?? m().link}</code>
            </div>
          )}
        </Show>

        <div class="new-grid" onInput={editForm} onChange={editForm} onSubmit={editForm}>
          <Show when={sponsor()?.enabled}>
            <form
              class="panel"
              data-starter-review
              onSubmit={(e) => {
                e.preventDefault();
                void reviewRequest();
              }}
            >
              <h2>{tr('caStarterBitcoinRequest')}</h2>
              <p class="hint">{tr('caPasteTheRequestShownOnTheirScreenAfterThey')}</p>
              <textarea
                data-starter-request-text
                rows={3}
                placeholder="bitsov://sponsor-request#…"
                value={request()}
                disabled={requestLocked()}
                onInput={(e) => {
                  stopGiftWait();
                  setCand(null);
                  setTheirCode('');
                  setRequest(e.currentTarget.value);
                }}
                aria-label={tr('caStarterBitcoinRequest')}
              />
              <button type="submit" class="primary" classList={{ money: !open() }} data-starter-request-submit disabled={!request().trim() || requestLocked()}>
                {open() ? tr('ownerApprovalReview') : tr('caApproveFirst')}
              </button>
              <Show when={cand()}>
                {(c) => (
                  <div class="artifact" data-starter-candidate={c().newcomer}>
                    <span class="kind">{tr('caStarterBitcoin')}{' '}{shortId(c().newcomer)}</span>
                    <p>
                      {tr('caLightningGift')}{' '}<strong>{fmtAmount(c().gift_msat)}</strong>{tr('caNetworkFeeAtMost')}{' '}{fmtAmount(c().fee_max_msat)}.
                    </p>
                    <span class="hint">
                      {tr('caTheyOwnItOnceItArrivesAndCanKeep')}</span>
                    <label class="door-allow">
                      <span>{tr('caCodeOnTheirScreen')}</span>
                      <input
                        data-starter-their-code
                        disabled={requestLocked()}
                        inputmode="numeric"
                        maxLength={6}
                        value={theirCode()}
                        onInput={(e) => setTheirCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                        aria-label={tr('caCodeOnTheirScreen')}
                      />
                    </label>
                    <span class="row" style={{ gap: 'var(--s-2)' }}>
                      <button
                        type="button"
                        class="primary money"
                        data-starter-approve
                        disabled={requestLocked() || theirCode().length !== 6}
                        onClick={() => void prepareGift()}
                      >
                        {giving() ? tr('caPreparing') : tr('caSponsorUpTo', fmtAmount(c().gift_msat + c().fee_max_msat))}
                      </button>
                      <button type="button" class="quiet" data-starter-cancel disabled={giving() || cancelling() || giftPending()} onClick={() => void cancelKit()}>
                        {tr('cancel')}</button>
                    </span>
                  </div>
                )}
              </Show>
              <Show when={ownerRequired()}>
                <div class="approval" data-starter-owner-approval="pending">
                  <p><strong>{tr('caApproveThisGiftAtYourNode')}</strong>{' '}{tr('caTheBoxOwnerApprovesThisGiftOnce')}</p>
                  <Show when={ownerWait()} fallback={<p>{tr('caReviewTheRequestAndCompareTheCodeToPrepare')}</p>}>
                    {(pending) => <>
                      <OperatorDetails>
                        <textarea readonly aria-label={tr('uiOwnerApprovalCommand')} data-starter-owner-command value={pending().owner_command} />
                        <button type="button" class="link" onClick={() => void navigator.clipboard.writeText(pending().owner_command).catch(() => setCandErr(tr('uiSelectAndCopyTheCommandAbove')))}>{tr('uiCopyCommand')}</button>
                      </OperatorDetails>
                      <p class="hint">{tr('caWaitingForTheNodeToReportThisGiftFunded')}</p>
                    </>}
                  </Show>
                </div>
              </Show>
              <Show when={gift()}>
                {(g) => (
                  <p class={g().state === 'funded' ? 'ok-note' : 'err-note'} data-starter-gift={g().state}>
                    {g().state === 'funded'
                      ? tr('caSentItIsTheirsNow', fmtAmount(g().paid_msat))
                      : g().state === 'paying' || g().state === 'unknown'
                        ? tr('caPaymentPendingDoNotSendAgainYourNodeKeeps')
                        : tr('caGiftThisKitIsClosed', g().state)}
                  </p>
                )}
              </Show>
              <Show when={candErr() && candErr() !== MONEY_NOT_READY}>
                <p class="err-note" data-starter-review-error>{candErr()}</p>
              </Show>
            </form>
          </Show>
          <Show when={showLegacyIntroductionUi}>
          <form
            class="panel"
            data-intro-open
            onSubmit={(e) => {
              e.preventDefault();
              readCard();
            }}
          >
            <h2>{tr('caOpenAnIntroduction')}</h2>
            <p class="hint">{tr('caPasteABitsovIntroduceLinkSomeoneShowedOrSent')}</p>
            <textarea
              data-intro-text
              rows={3}
              placeholder="bitsov://introduce#…"
              value={pasted()}
              onInput={(e) => {
                readRevision += 1;
                setLocalConsent(null);
                setPasted(e.currentTarget.value);
                setCard(null);
                setCardErr(null);
              }}
              aria-label={tr('caIntroductionLink')}
            />
            <button type="submit" class="primary" disabled={!pasted().trim() || opening()}>
              {tr('caReadCard')}</button>
            <Show when={card()}>
              {(c) => (
                <div class="artifact" data-door-card={c().node_id}>
                  <span class="kind">{tr('caDoorCard')}{' '}{shortId(c().node_id)}</span>
                  <span>{tr('caSignedByTheKeyItNames')}</span>
                  <p data-door-prices>
                    {tr('caAdmission')}{' '}<strong>{fmtAmount(allIn(c().admission_msat))}</strong>{' '}{tr('caIncluding')}{' '}{feeCeiling(routingFee(c().admission_msat))}{tr('caEachMessage')}{' '}<strong>{fmtAmount(allIn(c().message_msat))}</strong>{' '}{tr('caIncluding')}{' '}{feeCeiling(routingFee(c().message_msat))}{' '}{tr('caEstimatedCeilings')}</p>
                  <Show when={c().starter}>
                    {(st) => (
                      <div class="door-starter" data-door-starter>
                        <p>
                          {tr('caStarterBitcoinAvailableAfterTheyApprove')}{' '}<strong>{fmtAmount(st().gift_msat)}</strong>.
                        </p>
                        <Show
                          when={ask()}
                          fallback={
                            <>
                              <span class="hint">
                                {tr('caRequestingMakesOneInvoiceToYourOwnNodeFor')}</span>
                              <button type="button" class="quiet" data-door-request-starter disabled={props.moneyBlocked} onClick={requestStarter}>
                                {tr('caRequestStarterBitcoin')}</button>
                            </>
                          }
                        >
                          {(a) => (
                            <>
                              <Show when={askQr()}>
                                <svg class="qr" viewBox={`0 0 ${askQr()!.extent} ${askQr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label={tr('caYourStarterBitcoinRequestAsAQRCode')}>
                                  <rect width={askQr()!.extent} height={askQr()!.extent} fill="#ffffff" />
                                  <path d={askQr()!.path} fill="#000000" />
                                </svg>
                              </Show>
                              <p data-starter-code>
                                {tr('caShowThisToThemCode')}{' '}<strong>{a().code.slice(0, 3)} {a().code.slice(3)}</strong>{tr('caTheyTypeItBeforeApproving')}</p>
                              <p class="hint" data-starter-status={arrived() ? 'received' : 'waiting'}>
                                {arrived()
                                  ? tr('caReceivedInYourOwnNode', fmtAmount(arrived()!.amount_msat))
                                  : tr('caWaitingForStarterBitcoin')}
                              </p>
                              <code class="address" data-starter-request>{a().request}</code>
                            </>
                          )}
                        </Show>
                        <Show when={askErr() && askErr() !== MONEY_NOT_READY}>
                          <span class="err-note" data-starter-ask-error>{askErr()}</span>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <span class="hint">
                    {tr('caPricesFromTheirSignedCardBeforeAnythingIsPaid')}</span>
                  <Show when={c().reach === 'local'}>
                    <span class="hint" data-door-local>
                      {tr('caLocalNetworkAddress')}{c().endpoint}{tr('caContinueOnlyIfYouAreOnTheSameNetwork')}</span>
                    <label class="door-allow">
                      <input
                        type="checkbox"
                        data-door-allow-local
                        checked={allowLocal(c())}
                        onChange={(e) => setLocalConsent(e.currentTarget.checked
                          ? { node_id: c().node_id, endpoint: c().endpoint, link: c().link }
                          : null)}
                        disabled={opening()}
                      />
                      <span>{tr('caAllowThisLocalAddress')}</span>
                    </label>
                  </Show>
                  <details>
                    <summary>{tr('uiDetails')}</summary>
                    <code class="address">{c().node_id}</code>
                    <span class="hint">{tr('endpoint')}{' '}{c().endpoint} · {c().network}</span>
                  </details>
                  <Show
                    when={cardLive()}
                    fallback={<span class="err-note" data-door-expired>{tr('caThisCardHasExpiredAskThemForAFresh')}</span>}
                  >
                    <span class="hint">{tr('caContinuingConnectsYourNodeToTheirsItPaysNothing')}</span>
                    <span class="row" style={{ gap: 'var(--s-2)' }}>
                      <button
                        type="button"
                        class="primary"
                        data-door-continue
                        disabled={opening() || (c().reach === 'local' && !allowLocal(c()))}
                        onClick={continueCard}
                      >
                        {opening() ? tr('caConnecting') : tr('caContinue')}
                      </button>
                      <button type="button" class="quiet" onClick={() => { readRevision += 1; setLocalConsent(null); setCard(null); }} disabled={opening()}>
                        {tr('cancel')}</button>
                    </span>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={cardErr()}>
              {(e) => <SoftError message={e()} data="door-error" />}
            </Show>
          </form>
          </Show>

          <form
            class="panel"
            data-invite-create
            onSubmit={(e) => {
              e.preventDefault();
              void run('create', async () => {
                const v = await props.source.inviteCreate(invitee(), addr(), hours());
                setMade({ link: v.invite_link, until: v.expires_at_ms });
              });
            }}
          >
            <h2>{tr('caInviteSomeone')}</h2>
            <p class="hint">
              {tr('caAnInviteIsBoundToOnePersonSKey')}</p>
            <input data-invitee placeholder={tr('caTheirNodeId64Hex')} value={invitee()} onInput={(e) => setInvitee(e.currentTarget.value)} aria-label={tr('caTheirNodeId')} />
            <input data-addr placeholder={tr('caYourNodeSReachableAddressHostPort')} value={addr()} onInput={(e) => setAddr(e.currentTarget.value)} aria-label={tr('caYourNodeSAddress')} />
            <label class="row">
              <span class="hint">{tr('caValidFor')}</span>
              <select value={hours()} onChange={(e) => setHours(Number(e.currentTarget.value))} aria-label={tr('caValidFor')}>
                <option value={24}>{tr('ca1Day')}</option>
                <option value={72}>{tr('ca3Days')}</option>
                <option value={168}>{tr('ca7Days')}</option>
              </select>
            </label>
            <button type="submit" class="primary" classList={{ money: !open() }} data-invite-create-submit disabled={props.moneyBlocked || busy() || (open() ? !invitee() || !addr() : waiting())}>
              {button(tr('caCreateInvite'))}
            </button>
            <Show when={made()}>
              {(m) => (
                <div class="artifact" data-invite-link>
                  <span class="kind">{tr('caInviteUntil')}{' '}{day(m().until)}</span>
                  <code class="address">{m().link}</code>
                  <span class="hint">{tr('caSendItToThemYourselfTheAppSendsNothing')}</span>
                </div>
              )}
            </Show>
            <Show when={errs.create && errs.create !== MONEY_NOT_READY ? errs.create : null}>
              {(e) => <SoftError message={e()} data="invite-create-error" />}
            </Show>
          </form>

          <form
            class="panel"
            data-invite-redeem
            onSubmit={(e) => {
              e.preventDefault();
              void run('redeem', async () => {
                const v = await props.source.inviteRedeem(token());
                setRedeemed({ inviter: v.inviter_pubkey, addr: v.addr });
                setToken('');
              });
            }}
          >
            <h2>{tr('caAcceptAnInvite')}</h2>
            <p class="hint">{tr('caPasteABitsovInviteLinkSomeoneSentYouYour')}</p>
            <textarea data-invite-token rows={3} placeholder="bitsov://invite/…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} aria-label={tr('caInviteLink')} />
            <button type="submit" class="primary" classList={{ money: !open() }} data-invite-accept-submit disabled={props.moneyBlocked || busy() || (open() ? !token().trim() : waiting())}>
              {button(tr('caAcceptInvite'))}
            </button>
            <Show when={redeemed()}>
              {(r) => (
                <p class="ok-note" data-redeemed>
                  {tr('caAcceptedConnectingTo')}{' '}{shortId(r().inviter)}{' '}{tr('caAtAddress')}{' '}{r().addr}{tr('caMessagesBetweenYouStillPayToBeAdmitted')}</p>
              )}
            </Show>
            <Show when={errs.redeem && errs.redeem !== MONEY_NOT_READY ? errs.redeem : null}>
              {(e) => <SoftError message={e()} data="invite-redeem-error" />}
            </Show>
          </form>
        </div>
        <p class="send-next">
          {tr('caInvitesChangeYourNodeSoTheyUseTheSame')}<Show when={!props.nodeRooms}>{' '}{tr('uiThisNodeDoesNotSupportRoomsYet')}</Show>
        </p>
      </div>
    </>
  );
}

// ---- context panels ---------------------------------------------------------

function NodePanel(props: { connection?: JSX.Element; deviceApprovals?: JSX.Element; onForgetRemote?: () => Promise<void>; pairAnother?: JSX.Element; overview: NodeOverview | null; link: LinkState | null; peers: Peer[]; now: number; error?: string; onReconnect: () => Promise<void> }) {
  const fresh = () => freshness(props.overview?.read_at ?? null, props.now);
  const linkText = () =>
    props.link === 'open' ? tr('callLive') : props.link === 'connecting' ? tr('callConnecting') : props.link === 'closed' ? tr('caReconnecting') : tr('caWaiting');
  return (
    <div class="panel" data-panel="node">
      <h2>{tr('caYourNode832')}</h2>
      {props.deviceApprovals}
      <Show when={props.onForgetRemote}><LocalNodeSwitch onForget={() => props.onForgetRemote!()} /></Show>
      {props.pairAnother}
      <HubTrustInfo level={3} />
      {props.connection}
      <ChainNotice overview={props.overview} />
      <Show when={props.overview} fallback={<Show when={!props.error}><DelayedSpinner /></Show>}>
        {(o) => (
          <>
          <dl class="facts">
            <dt>{tr('caStatus')}</dt>
            <dd>
              <span class="row" style={{ 'justify-content': 'flex-end', gap: 'var(--s-2)' }}>
                <span class={`dot ${o().status === 'ok' ? 'ok' : 'warn'}`} />
                {o().status === 'ok' ? tr('caHealthy') : o().status}
              </span>
            </dd>
            <dt>{tr('caNodeId')}</dt>
            <dd class="id" title={o().node_id}>{shortId(o().node_id)}</dd>
            <Show when={custodyBadge(o().custody_mode)}>
              <dt>{tr('caKeys')}</dt>
              <dd><CustodyBadgeView mode={o().custody_mode} /></dd>
            </Show>
            <dt>{tr('caLiveFeed')}</dt>
            <dd data-link={props.link ?? 'none'}>{linkText()}</dd>
            <dt>{tr('caPeersConnected')}</dt>
            <dd class="sats">{o().connected_peers}</dd>
            <dt>{tr('caEncryptedSessions')}</dt>
            <dd class="sats">{o().e2ee_sessions}</dd>
            <dt>{tr('caWaitingToDeliver')}</dt>
            <dd class="sats">{o().pending_deliveries}</dd>
            <dt>{tr('caBlockHeight')}</dt>
            <dd class="sats">{o().block_height !== null ? satsWhole(o().block_height!, true) : tr('caUnknown')}</dd>
            <dt>{tr('receiveLightning')}</dt>
            <dd>{o().lightning_available ? o().lightning_backend ?? tr('caAvailable') : tr('caUnavailableExtra63')}</dd>
            <dt>{tr('caChainSource')}</dt>
            <dd>{o().chain_backend ?? tr('caUnknown')}</dd>
            <dt>{tr('caUptime')}</dt>
            <dd class="sats">{uptime(o().uptime_secs)}</dd>
            <VersionRows overview={o()} />
          </dl>
          <CopyVersions overview={o()} />
          </>
        )}
      </Show>
      <p class="fresh-line" classList={{ stale: fresh().stale }} data-freshness>
        {fresh().label}
      </p>
      <Show when={props.error}>
        <SoftError message={props.error!} onReconnect={props.onReconnect} />
      </Show>
      <h3>{tr('caPeers')}</h3>
      <For each={props.peers} fallback={<p class="hint">{tr('caYourNodeHasNoPeersYet')}</p>}>
        {(p) => (
          <div class="row" style={{ 'justify-content': 'space-between', 'font-size': 'var(--t-sm)' }}>
            <span class="row" style={{ gap: 'var(--s-2)', 'min-width': 0 }}>
              <span class={`dot ${p.connected ? 'ok' : ''}`} />
              <span style={{ 'font-family': 'var(--font-sans)' }}>{peerName(p, p.node_id)}</span>
            </span>
            <span class="id">{p.fingerprint ?? shortId(p.node_id)}</span>
          </div>
        )}
      </For>
      <p class="hint">{tr('caYourPeerListIsPrivateToThisNodeIt')}</p>
    </div>
  );
}

function WalletPanel(props: { moneyBlocked: boolean; wallet: WalletOverview | null; error?: string; onReconnect: () => Promise<void>; fund?: JSX.Element }) {
  const active = () => props.wallet?.channels.filter((c) => c.active).length ?? 0;
  return (
    <>
      <div class="panel" data-panel="wallet">
        <h2>{tr('uiWallet')}</h2>
        <p class="hint" data-budget-wallet-warning>{tr('caChannelAndOnChainActionsTheirFeesAndOwner')}</p>
        <Show when={props.wallet} fallback={<Show when={!props.error}><DelayedSpinner /></Show>}>
          {(w) => (
            <>
              <div class="big-balance">
                <span class="sats" data-balance>
                  {sats(w().balance_msat, true)}
                  <span class="unit">{satUnit(w().balance_msat)}</span>
                </span>
                <p class="hint">{tr('caNodeReportedTotalOneFigureNotASpendableBalance')}</p>
              </div>
              <dl class="facts">
                <dt>{props.moneyBlocked ? tr('caLightningOutboundCapacityMoneyNotReady') : tr('caLightningOutboundCapacity')}</dt>
                <dd class="sats">{fmtAmount(w().lightning_spendable_sats == null ? w().lightning_outbound_msat : w().lightning_spendable_sats! * 1000, true)}</dd>
                <dt>{tr('caOpenChannels')}</dt>
                <dd class="sats">
                  {active()}{' '}{tr('uiOf')}{' '}{w().channels.length}{' '}{tr('caActive')}</dd>
              </dl>
              <h3>{tr('uiChannels')}</h3>
              <For each={w().channels} fallback={<p class="hint" data-channels-empty>{NO_CHANNELS()}</p>}>
                {(c) => {
                  const share = () => (c.capacity_msat > 0 ? (c.local_balance_msat / c.capacity_msat) * 100 : 0);
                  return (
                    <div class="channel" data-channel={c.channel_id}>
                      <div class="row">
                        <span class="id" title={c.peer_pubkey}>{shortId(c.peer_pubkey)}</span>
                        <span>{c.active ? tr('caActive') : tr('caInactive')}</span>
                      </div>
                      <div class="liquidity" title={tr('caYoursOrangeAgainstTheirs')}>
                        <div style={{ width: `${share()}%`, opacity: c.active ? 1 : 0.4 }} />
                      </div>
                      <div class="row">
                        <span class="sats">{fmtAmount(c.local_balance_msat, true)}{' '}{tr('caYours')}</span>
                        <span class="sats">{fmtAmount(c.remote_balance_msat, true)}{' '}{tr('caTheirs')}</span>
                      </div>
                    </div>
                  );
                }}
              </For>
            </>
          )}
        </Show>
        <Show when={props.error}>
          <SoftError message={props.error!} onReconnect={props.onReconnect} />
        </Show>
      </div>
      <Show when={props.fund}>
        <div data-panel="receive">{props.fund}</div>
      </Show>
    </>
  );
}
