import { pollingSource } from './polling';
import { readSpendPreset, saveSpendPreset } from './prefs';
import { WelcomeHome } from './WelcomeHome';
import { DelayedSpinner } from './DelayedSpinner';
import { MONEY_NOT_READY, readinessLine, readinessSource } from './readiness';
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch, untrack } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { qrSvg } from '../qr';
import type { Proposal } from './ai';
import { AiTrack, createAiSession } from './AiTrack';
import { amount as fmtAmount, paidAmount, budgetNote, allIn, clock, day, feeCeiling, routingFee, sats, satsWhole, satUnit, shortId, uptime } from './format';
import { amountText, inPaymentBounds, MAX_PAYMENT_MSAT, MIN_PAYMENT_MSAT, parseAmount } from './amountInput';
import { Organism } from './BodyPanel';
import { SoftError } from './SoftError';
import { DiscoverPanel, FrontDoorEditor } from './Discover';
import { PorchPanel } from './Porch';
import { ContactPanel } from './ContactPanel';
import { custodyBadge, CustodyBadgeView } from './custody';
import { WalletPage, type WalletActions, type WalletTab } from './WalletPage';
import { artifactActivity, logActivity, type LoggedActivity } from './wallet';
import { callCost, createCallEngine, IDLE as CALL_IDLE, isCallKind, signalCost, stunServer, type CallMedia, type CallView } from './call';
import { createMeetingEngine, declineCost, inviteCost, joinCost, MAX_PARTICIPANTS, MEETING_IDLE, type LegState, type MeetingView, type ShownQuotes } from './meeting';
import { admitRoom, leaveRoom, localRoom, localRooms, newRoom, rememberRoom, ROOM_CAPABILITY, ROOM_PAGE, roomOf, sameRoom, sendRoom, type LegPlan, type LocalRoom } from './room';
import { NewRoomPanel, RoomThread, type RoomSend } from './RoomPanel';
import { blobUrl, duration, FILE_MAX_BYTES, fileNameOf, isVoiceNote, type Recording, startRecording, VOICE_MAX_MS } from './voice';
import { EMOJIS, insertEmoji } from './emoji';
import { cleanPurpose, hostReadProblem, invoicePaymentHash, NOT_PAYABLE_NOTE, type NotPayable, payeeView, readChatInvoice } from './bolt11';
import { safeImageMime, looksLikeSafeImageName, dataImageUrl } from './frontDoorMedia';
import type { FileSaveResult, InvoiceAmount, InvoiceView, VoiceBlob } from './types';
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
  mergeMessages,
  messagesWorth,
  needsApproval,
  nodePill,
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
  BudgetPreset,
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
  remote?: boolean;
  retryAfterSecs?: number | null;
  onReconnect?: () => Promise<void>;
  source: Source;
  /** Setup completed for this trust boundary: keep the shell mounted. */
  active: boolean;
  /** Transient connection readiness, independent of shell visibility. */
  live?: boolean;
  ready: boolean;
  error: string | null;
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
};

/** The result of one action: its value, or why it did not happen. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/**
 * What the conversation can do. Messages pay inside the owner's budget; every
 * other spending call is refused by the host outside the ten-minute window.
 */
export type Actions = {
  approve: () => Promise<void>;
  lock: () => Promise<void>;
  /** Withdraw the pending request at the node. */
  cancelSpend: () => Promise<void>;
  /** This Mac's Touch ID approvals, as last read. */
  device: () => DeviceView | null;
  registerDevice: () => Promise<void>;
  cancelDevice: () => Promise<void>;
  /** One contact's envelope, signed with Touch ID. */
  approveContact: (peer: string, perActMsat: number | null) => Promise<void>;
  /** The contact the node last refused for having no envelope (`grant_no_envelope`). */
  noEnvelopeFor: () => string | null;
  reconcile: () => Promise<Outcome<string>>;
  pendingRevision: () => number;
  /** The owner's one approval for a daily total (B2). */
  approveBudget: (ceilingMsat: number, preset: PresetId) => Promise<void>;
  setBudget: (target: string, room: boolean, limitMsat: number) => Promise<Outcome<unknown>>;
  pauseAll: () => Promise<void>;
  resume: () => Promise<void>;
  send: (t: TrackRef, text: string, maxMsat: number, firstContactMsat?: number) => Promise<Outcome<unknown>>;
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
  ownerStatus: (id: string) => Promise<Outcome<OwnerContactApproval>>;
  ownerCancel: (id: string) => Promise<void>;
  /** Create an invoice for an exact msat amount (never rounded here). */
  invoice: (t: TrackRef, msat: number, note: string) => Promise<Outcome<unknown>>;
  /** The host's read-only decode of an invoice: the only payee and amount shown. */
  readInvoice: (bolt11: string) => Promise<Outcome<InvoiceAmount>>;
  pay: (t: TrackRef, bolt11: string, msat: number) => Promise<Outcome<unknown>>;
  keysend: (t: TrackRef, pubkey: string, msat: number, memo: string) => Promise<Outcome<unknown>>;
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
  /** Open the meeting planner with this contact picked. Pays nothing. */
  planMeeting: (peer: string) => void;
};

let artifactSeq = 0;

/** An artifact before it has an id; `at` defaults to now. Distributes over the union. */
type NewArtifact = Artifact extends infer A ? (A extends Artifact ? Omit<A, 'id' | 'at'> & { at?: number } : never) : never;

export function ControlCenter(props: Props) {
  const [now, setNow] = createSignal(Date.now());
  const [overview, setOverview] = createSignal<NodeOverview | null>(null);
  const [readinessRefused, setReadinessRefused] = createSignal(false);
  const moneyBlocked = () => readinessRefused() || overview()?.money_ready === false;
  // The node's own STUN responder, if `/status` reports one (offered in Settings).
  const ownStun = createMemo<OwnStun | null>(() => {
    const o = overview();
    return o?.stun_port ? { port: o.stun_port, url: o.stun_url ?? null } : null;
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
  const [peers, setPeers] = createSignal<Peer[]>([]);
  const [peersLoaded, setPeersLoaded] = createSignal(false);
  const [rooms, setRooms] = createSignal<Room[]>([]);
  const [members, setMembers] = createStore<Record<string, string[]>>({});
  const [wallet, setWallet] = createSignal<WalletOverview | null>(null);
  const [link, setLink] = createSignal<LinkState | null>(null);
  const [threads, setThreads] = createStore<{ t: Threads; unread: Unread; fresh: Record<string, true> }>({ t: {}, unread: {}, fresh: {} });
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
      if (read === quoteRead && track() && trackKey(track()!) === trackKey(t)) setQuoteError(peerNotReadyMessage(error, t.kind === 'peer' ? nameOf(t.id) : 'This peer') ?? 'price unavailable · could not read peer price');
    }
  };
  const [roomQuote, setRoomQuote] = createSignal<RoomQuote | null>(null);
  const [filePrice, setFilePrice] = createSignal<PaymentQuote | null>(null);
  const [spend, setSpend] = createSignal<SpendView | null>(null);
  const [device, setDevice] = createSignal<DeviceView | null>(null);
  const [noEnvelopeFor, setNoEnvelopeFor] = createSignal<string | null>(null);
  const [budget, setBudgetValue] = createSignal<BudgetView | null>(null);
  let budgetRevision = 0;
  const setBudget = (value: BudgetView) => {
    budgetRevision += 1;
    setBudgetValue(value);
  };
  const [deliveries, setDeliveries] = createStore<Deliveries>({});
  /** What each send actually paid, by message id: a room echo carries one member's share only. */
  const [paid, setPaid] = createStore<Record<string, number>>({});
  const [allowances, setAllowances] = createStore<Record<string, { total_msat: number; max_routing_fee_msat: number; fee_paid_msat?: number; readmission_msat?: number }>>({});
  const [pendingRevision, setPendingRevision] = createSignal(0);
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
  const [contextOpen, setContextOpen] = createSignal(false);
  /** The full-screen Wallet page, on this tab; null when closed. */
  const [walletTab, setWalletTab] = createSignal<WalletTab | null>(null);
  createEffect(() => {
    if (!walletTab()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !contextOpen()) {
        e.preventDefault();
        setWalletTab(null);
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });
  const [settingsEl, setSettingsEl] = createSignal<HTMLElement | null>(null);
  let settingsReturnFocus: HTMLElement | null = null;
  createEffect(() => {
    const open = contextOpen();
    const panel = settingsEl();
    // Closed modal uses visibility:hidden (CSS) so its controls leave the tab order.
    if (open && panel) {
      settingsReturnFocus = document.activeElement as HTMLElement | null;
      queueMicrotask(() => panel.querySelector<HTMLElement>('[data-settings-close]')?.focus());
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setContextOpen(false);
        }
      };
      window.addEventListener('keydown', onKey);
      onCleanup(() => window.removeEventListener('keydown', onKey));
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
  const [tab, setTab] = createSignal<'body' | 'node' | 'wallet' | 'budget' | 'frontdoor'>('body');
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
  const openKey = () => (track() ? trackKey(track()!) : null);
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
    void attempt('thread', () => source.roomThread(id, before ?? undefined, ROOM_PAGE), (page) => {
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
      const recovering = moneyBlocked() && value.money_ready !== false;
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
    if (!track()) {
      const first = value.find((p) => p.connected) ?? value[0];
      if (first) setTrack({ kind: 'peer', id: first.node_id.toLowerCase() });
    }
  });
  const loadRooms = () => attempt('rooms', () => source.rooms(), setRooms);
  const loadWallet = () => attempt('wallet', () => source.wallet(), setWallet);
  const loadSpend = () => attempt('spendPoll', () => source.spendStatus(), (value) => {
    const resolved = spend()?.state !== 'open' && value.state === 'open';
    setSpend(value);
    if (resolved) setErrors('spend', undefined);
  });
  // Never an error line of its own: without a device key the console path stays.
  const loadDevice = () => source.deviceKeyStatus().then(setDevice, () => setDevice(null));
  const loadBudget = async () => {
    const revision = ++budgetRevision;
    try {
      const b = await source.budgetStatus();
      if (revision !== budgetRevision) return;
      if (budget()?.autopay.state !== 'open' && b.autopay.state === 'open') setErrors('budget', undefined);
      setBudget(b);
      setBudgetReadAt(Date.now());
      setBudgetConfirmed(true);
      setGrantUnknown(false);
      setErrors('budgetPoll', undefined);
    } catch (e) {
      if (revision !== budgetRevision) return;
      setBudgetConfirmed(false);
      const error = asActionError(e);
      setGrantUnknown(error.code === 'grant_unknown');
      setErrors('budgetPoll', typeof e === 'string' ? e : error.message);
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
    void attempt('thread', () => source.messages(t.id), (page) => {
      setThreads('t', key, (old) => mergeMessages(old ?? [], page));
      if (t.kind === 'peer') foldRooms(page, false);
      setEnergyAt(Date.now());
    });
  };

  const clockTimer = setInterval(() => setNow(Date.now()), REFRESH_MS.clock);
  let timers: ReturnType<typeof setTimeout>[] = [];
  let unlisten: (() => void) | undefined;
  // Bumped on every stop so a subscription that resolves late is closed at once.
  let generation = 0;
  const stop = () => {
    generation += 1;
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
        void loadSpend().then(loadBudget);
        void loadDevice();
        // Keep timer phases through cooldowns. Skip ticks while paused rather
        // than restarting the initial load sequence when the link recovers.
        const polls: [() => Promise<unknown>, number][] = [
          [loadDevice, REFRESH_MS.peers], [loadOverview, REFRESH_MS.overview],
          [loadPeers, REFRESH_MS.peers], [loadWallet, REFRESH_MS.wallet],
          [loadRooms, REFRESH_MS.rooms], [loadDoor, REFRESH_MS.door],
          [loadEnergy, REFRESH_MS.energy], [loadMembrane, REFRESH_MS.membrane],
          [() => loadSpend().then(() => { if (live()) return loadBudget(); }), REFRESH_MS.spend],
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
              setLink(event.state);
              if (event.state !== 'open') { budgetRevision += 1; setBudgetConfirmed(false); }
              else if (live()) void loadSpend().then(loadBudget);
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
            // Call signals ring or steer the call; they are not chat.
            if (event.type === 'message' && isCallKind(event.message.kind)) {
              // Each engine takes only its own: meeting legs carry a roster.
              void calls.receive(event.message, ownId());
              void meetings.receive(event.message, ownId());
              return;
            }
            if (event.type === 'message' || event.type === 'delivery') {
              foldMembrane((log) =>
                membraneLive(log, event, { ownId: ownId(), contacts: contactSet(), threads: threads.t, nowMs: Date.now(), nodeMembrane: caps().membrane }),
              );
            }
            if (event.type === 'message') {
              setEnergyAt(Date.now());
              energyAfterEvent();
            }
            if (event.type === 'delivery') {
              const next = applyDelivery(deliveries, event);
              if (next !== deliveries) setDeliveries(event.message_id, next[event.message_id]);
              return;
            }
            if (event.type === 'message' && roomOf(event.message, ownId())) {
              // A room chat: unread in its room, kept (hidden) in the member's 1:1 history.
              const m = event.message;
              const peer = (isOutgoing(m, ownId()) ? m.recipient : m.sender).toLowerCase();
              setThreads('t', trackKey({ kind: 'peer', id: peer }), (old) => mergeMessages(old ?? [], [m]));
              foldRooms([m], true);
              setThreads('fresh', m.id, true);
              return;
            }
            const next = applyLive(threads.t, threads.unread, openKey(), event, ownId());
            if (!next.key) return;
            setThreads(
              produce((s) => {
                s.t = next.threads;
                s.unread = next.unread;
                if (event.type === 'message') s.fresh[event.message.id] = true;
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

  /** Run one action. An approval error re-reads the window; the caller shows the rest. */
  const act = async <T,>(run: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      const error = asActionError(e);
      if (needsApproval(error) || error.code === 'spend_refused' || error.code === 'grant_ended') void loadSpend();
      return { ok: false, error };
    }
  };
  /** A message the node took: show it in the thread with what it paid. */
  const sentOne = (t: TrackRef, receipt: SendReceipt, text: string) => {
    setPaid(receipt.message_id, receipt.amount_msat);
    setAllowances(receipt.message_id, {
      total_msat: receipt.total_msat ?? receipt.amount_msat + (receipt.readmission_msat ?? 0) + (receipt.max_routing_fee_msat ?? 0),
      max_routing_fee_msat: receipt.max_routing_fee_msat ?? 0,
      fee_paid_msat: receipt.fee_paid_msat,
      ...(receipt.readmission_msat ? { readmission_msat: receipt.readmission_msat } : {}),
    });
    if (!deliveries[receipt.message_id]) setDeliveries(receipt.message_id, deliveryFromReceipt(receipt));
    const sent = sentMessage(receipt, ownId(), text);
    setThreads('t', trackKey(t), (old) => mergeMessages(old ?? [], [sent]));
    foldRooms([sent], false);
    setThreads('fresh', receipt.message_id, true);
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
    if (stand.kind === 'first') return 'No budget for them yet: message them once in their chat first. Not charged.';
    if (stand.kind === 'contact_used') return 'Their budget is used up for today. Not charged.';
    return null;
  };
  const createRoom = async (picks: string[]) => {
    const room = rememberRoom(await newRoom(ownId(), picks));
    setRoomPlan(false);
    if (room) setTrack({ kind: 'bound', id: room.id });
  };
  /** A failed action that is not an approval or budget question stays in the track as a record. */
  const recordFailure = (t: TrackRef, action: string, outcome: Outcome<unknown>) => {
    // A send that did not cross (price, setpoint) is also a membrane reading. A
    // price refusal stands at their door in the track instead of a failure row.
    if (!outcome.ok) foldMembrane((log) => membraneRefused(log, outcome.error, trackKey(t), Date.now()));
    if (!outcome.ok && outcome.error.code !== 'not_ready' && !needsApproval(outcome.error) && !isBudgetStop(outcome.error) && outboundKind(outcome.error) !== 'price' && outcome.error.code !== 'readmission_capped' && outcome.error.code !== 'readmission_quoted') {
      addArtifact(t, { type: 'failed', action: FAILURE_LABEL[outcome.error.code] ?? action, error: outcome.error });
    }
    return outcome;
  };

  // Calls: media is peer to peer in this webview; each signal is one paid send.
  const [callView, setCallView] = createSignal<CallView>(CALL_IDLE);
  const [callStreams, setCallStreams] = createSignal<{ local: MediaStream | null; remote: MediaStream | null }>({ local: null, remote: null });
  const calls = createCallEngine({
    grant: () => budget()?.node_grant ?? null,
    quote: (peer) => act(() => source.callQuote(peer)),
    signal: async (peer, kind, plaintext, maxMsat) => {
      const r = await act(() => source.callSignal(peer, kind, plaintext, maxMsat));
      void loadBudget();
      void loadWallet();
      return r;
    },
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    peerConnection: (config) => new RTCPeerConnection(config),
    now: () => Date.now(),
    onView: setCallView,
    onStreams: (local, remote) => setCallStreams({ local, remote }),
    // No STUN unless the owner set one: host candidates only.
    iceServers: () => stunServer(stunPref()),
    busy: () => meetingOn(),
  });
  // Closing the window ends the call here without paying; only Hang up pays.
  onCleanup(() => calls.endLocal());

  // Meetings: up to 4 people, one ordinary paid 1:1 call per pair (meeting.ts).
  const [meetingView, setMeetingView] = createSignal<MeetingView>(MEETING_IDLE);
  const [meetingStreams, setMeetingStreams] = createSignal<{ local: MediaStream | null; remote: Record<string, MediaStream> }>({ local: null, remote: {} });
  const [meetingPlan, setMeetingPlan] = createSignal<string[] | null>(null);
  const meetingOn = () => meetingView().phase === 'invited' || meetingView().phase === 'active';
  // Our own node takes meeting legs (genome `call_meeting_v1` on /status).
  const nodeMeets = () => overview()?.capabilities?.includes('call_meeting_v1') === true;
  const meetings = createMeetingEngine({
    quote: (peer) => act(() => source.callQuote(peer)),
    signal: async (peer, kind, plaintext, maxMsat) => {
      const r = await act(() => source.callSignal(peer, kind, plaintext, maxMsat));
      void loadBudget();
      void loadWallet();
      return r;
    },
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    peerConnection: (config) => new RTCPeerConnection(config),
    ownId: () => ownId(),
    canMeet: (peer) => nodeMeets() && peerById().get(peer.toLowerCase())?.meetings === true,
    onView: setMeetingView,
    onStreams: (local, remote) => setMeetingStreams({ local, remote }),
    iceServers: () => stunServer(stunPref()),
    busy: () => !['idle', 'ended'].includes(callView().phase),
  });
  onCleanup(() => meetings.endLocal());

  // Voice notes: one object URL per message, revoked when the shell goes.
  // A just-sent clip plays from its own bytes; a received one is read once.
  const voiceUrls = new Map<string, Promise<string>>();
  onCleanup(() => voiceUrls.forEach((u) => void u.then(URL.revokeObjectURL, () => undefined)));
  const actions: Actions = {
    callQuote: (peer) => act(() => source.callQuote(peer)),
    placeCall: (peer, media, quote) => void calls.place(peer, media, quote),
    callActive: () => !['idle', 'ended'].includes(callView().phase) || meetingOn(),
    // Opens the planner; the contact is pre-picked only if their node takes meetings.
    planMeeting: (peer) => {
      if (meetingOn()) return;
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
    approve: async () => {
      setErrors('spend', undefined);
      const r = await act(() => source.spendRequest());
      if (r.ok) setSpend(r.value);
      else setErrors('spend', r.error.message);
    },
    lock: async () => {
      setErrors('spend', undefined);
      const r = await act(() => source.spendLock());
      if (r.ok) setSpend(r.value);
    },
    cancelSpend: async () => {
      setErrors('spend', undefined);
      const r = await act(() => source.spendCancel());
      if (r.ok) setSpend(r.value);
      else setErrors('spend', r.error.message);
      void loadBudget();
    },
    device,
    registerDevice: async () => {
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
      setErrors('spend', undefined);
      const r = await act(() => source.relationApprove(peer, null, perActMsat));
      if (r.ok) {
        setSpend(r.value);
        setErrors('spend', undefined);
        if (noEnvelopeFor() === peer) setNoEnvelopeFor(null);
      } else {
        setErrors('spend', r.error.message);
        if (r.error.code === 'device_invalid') void loadDevice();
      }
      void loadBudget();
    },
    pendingRevision,
    reconcile: () => act(() => source.spendReconcile()),
    approveBudget: async (ceilingMsat, preset) => {
      setErrors('budget', undefined);
      const r = await act(() => source.budgetApprove(ceilingMsat, preset));
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else setErrors('budget', r.error.message);
      // A paired node asks its owner: the pending request shows from the spend view.
      void loadSpend();
    },
    setBudget: async (target, room, limitMsat) => {
      const r = await act(() => source.budgetSet(target, room, limitMsat));
      if (r.ok) setBudget(r.value);
      return r;
    },
    pauseAll: async () => {
      setErrors('budget', undefined);
      const r = await act(() => source.budgetPause());
      if (r.ok) setBudget(r.value);
      else setErrors('budget', r.error.message);
      void loadSpend();
    },
    resume: async () => {
      setErrors('budget', undefined);
      const r = await act(() => source.budgetResume());
      if (r.ok) {
        setBudget(r.value);
        setErrors('budget', undefined);
      } else {
        setErrors('budget', r.error.message);
        void loadBudget();
      }
      void loadSpend();
    },
    doorQuote: (peer) => source.firstContactQuote(peer),
    ownerRequest: (peer, cap, budget) => act(() => source.firstContactRequest(peer, cap, budget)),
    ownerStatus: (id) => act(() => source.firstContactStatus(id)),
    ownerCancel: (id) => source.firstContactCancel(id).catch(() => {}),
    send: async (t, text, maxMsat, firstContactMsat) => {
      if (t.kind !== 'peer' && t.kind !== 'room') return { ok: false, error: { code: 'invalid', message: 'nothing to send to' } };
      const r = await act(() => source.send(t.id, t.kind === 'room', text, maxMsat, t.kind === 'room' ? Object.fromEntries((roomQuote()?.members ?? []).map((m) => [m.node_id, m.msat])) : undefined, firstContactMsat));
      // The tally moved, or a budget rule stopped the send: either way, re-read it.
      if (r.ok || isBudgetStop(r.error) || ['spend_unknown', 'payment_unknown', 'failed_paid', 'payment_settled_undelivered'].includes(r.error.code)) void loadBudget();
      // Approved another contact with Touch ID, not this one: offer the tap here.
      if (!r.ok && r.error.code === 'grant_no_envelope' && t.kind === 'peer') setNoEnvelopeFor(t.id);
      if (!r.ok && r.error.code === 'payment_settled_undelivered' && r.error.undelivered) {
        // Paid, not delivered: the draft moves here, with the only safe way to resend it.
        addArtifact(t, { type: 'undelivered', text, paid: r.error.undelivered, note: null, admission: null, pendingId: r.error.pending_id ?? null });
        return r;
      }
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) {
        if (t.kind === 'peer') void loadPrice(t);
        else void attempt('quote', () => source.roomQuote(t.id), (q) => {
          if (track() && trackKey(track()!) === trackKey(t)) setRoomQuote(q);
        });
      }
      if (r.ok) sentOne(t, r.value, text);
      return recordFailure(t, !r.ok && r.error.code === 'room_partial' ? 'Room send incomplete' : 'Message not sent', r);
    },
    retryDelivery: async (t, artifactId, approvedMsat) => {
      if (moneyBlocked()) return { ok: false, error: { code: 'not_ready', message: MONEY_NOT_READY } };
      const submittedApprovalRevision = retryApprovalRevision;
      const key = trackKey(t);
      const a = (artifacts[key] ?? []).find((x) => x.id === artifactId);
      if (t.kind !== 'peer' || a?.type !== 'undelivered' || !a.paid.retry) {
        return { ok: false, error: { code: 'retry_unavailable', message: 'Nothing to retry.' } };
      }
      // Only the price the card shows can be approved.
      if (approvedMsat !== undefined && approvedMsat !== a.admission?.total_msat) {
        return { ok: false, error: { code: 'retry_unavailable', message: 'Nothing to approve.' } };
      }
      const text = a.text;
      const update = (next: Partial<Extract<Artifact, { type: 'undelivered' }>> | null) =>
        setArtifacts(key, (old) => (old ?? []).flatMap((x) => (x.id !== artifactId ? [x] : next ? [{ ...x, ...next } as Artifact] : [])));
      const current = () => !moneyBlocked() && submittedApprovalRevision === retryApprovalRevision && (artifacts[key] ?? []).some((x) => x.id === artifactId && x.type === 'undelivered' && x.pendingId === a.pendingId);
      const waiting: Outcome<unknown> = { ok: false, error: { code: 'owner_only', message: 'Approve this retry at your node, then check approval.' } };
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
        update({ paid, admission: null, pendingId: r.error.pending_id ?? a.pendingId, note: `Still not delivered. Paid for this message so far: ${sats(paid.paid_msat)} ${satUnit(paid.paid_msat)}.` });
      } else if (r.error.code === 'not_ready') {
        // The shared notice owns this refusal; the paid card stays retryable.
        update({ ownerApproval: null, note: null });
      } else if (r.error.code === 'retry_needs_admission') {
        // Stopped before paying: the price to approve, when the node could tell.
        update({ admission: r.error.admission ?? null, note: r.error.message });
      } else {
        // A refusal before dispatch (approval, price) keeps the retry; anything else ends it.
        // A refused approved price is spent: Retry delivery asks for the current one.
        const ends = ['retry_unavailable', 'spend_unknown', 'payment_unknown', 'failed_paid'].includes(r.error.code);
        update({ paid: { ...a.paid, retry: !ends }, note: r.error.message, admission: r.error.code === 'price_cap_exceeded' ? null : a.admission });
      }
      return r;
    },
    stopRetrying: async (t, pendingId) => {
      // Only the record this card (or the pending check) showed: never another one.
      if (!pendingId) return { ok: false, error: { code: 'retry_unavailable', message: 'Check the pending result first.' } };
      const r = await act(() => props.source.dismissUndelivered(pendingId));
      void loadBudget();
      if (r.ok) {
        setPendingRevision((v) => v + 1);
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
        if (t) addArtifact(t, { type: 'failed', action: 'Stopped retrying', error: { code: 'undelivered_pending', message: r.value } });
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
      const r = await act(() => source.pay(bolt11, msat, allIn(msat)));
      void loadBudget();
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, invoice: bolt11, at: r.value.paid_at_ms });
        void loadWallet();
      }
      return recordFailure(t, 'Payment not sent', r);
    },
    keysend: async (t, pubkey, msat, memo) => {
      const r = await act(() => source.keysend(pubkey, msat, memo.trim() || null, allIn(msat)));
      void loadBudget();
      if (r.ok) {
        addArtifact(t, { type: 'payment', receipt: r.value, at: r.value.paid_at_ms });
        void loadWallet();
      }
      return recordFailure(t, 'Payment not sent', r);
    },
    file: async (t, file, maxMsat, firstContactMsat) => {
      if (t.kind !== 'peer') return { ok: false, error: { code: 'invalid', message: 'Files go to one peer at a time.' } };
      const data = await readBase64(file).catch(() => null);
      if (data === null) return { ok: false, error: { code: 'invalid', message: 'the file could not be read' } };
      const r = await act(() => source.fileSend(t.id, file.name, file.type, data, maxMsat, firstContactMsat));
      void loadBudget();
      void loadWallet();
      if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) void attempt('quote', () => source.filePrice(), setFilePrice);
      if (r.ok) {
        if (isVoiceNote(200, file.name)) voiceUrls.set(r.value.message_id, Promise.resolve(URL.createObjectURL(file)));
        setPaid(r.value.message_id, r.value.amount_msat);
        setAllowances(r.value.message_id, { total_msat: r.value.total_msat ?? r.value.amount_msat + (r.value.max_routing_fee_msat ?? 0), max_routing_fee_msat: r.value.max_routing_fee_msat ?? 0, fee_paid_msat: r.value.fee_paid_msat, readmission_msat: r.value.readmission_msat });
        if (!deliveries[r.value.message_id]) setDeliveries(r.value.message_id, deliveryFromReceipt(r.value));
        setThreads('t', trackKey(t), (old) => mergeMessages(old ?? [], [sentFileMessage(r.value, ownId())]));
        setThreads('fresh', r.value.message_id, true);
      }
      return recordFailure(t, 'File not sent', r);
    },
  };

  const pill = () =>
    nodePill({ remote: props.remote, retryAfterSecs: props.retryAfterSecs, ready: props.ready, error: props.error, overview: overview(), link: link(), nowMs: now() });

  const trackName = (t: TrackRef): string => {
    if (t.kind === 'peer') return peerName(peerById().get(t.id), t.id);
    if (t.kind === 'room') return rooms().find((r) => r.id.toLowerCase() === t.id)?.name ?? 'Room';
    if (t.kind === 'bound') return boundName(t.id);
    if (t.kind === 'ai') return 'AI';
    if (t.kind === 'discover') return 'Browse';
    if (t.kind === 'porch') return 'Porch';
    return 'Start something';
  };
  const nameOf = (id: string) => (id.toLowerCase() === ownId().toLowerCase() ? 'You' : peerName(peerById().get(id.toLowerCase()), id));
  /** Resolve only an unambiguous mapping reported by the node. */
  const channelName = (pubkey: string) => {
    const matches = peers().filter((p) => p.ln_pubkey?.toLowerCase() === pubkey.toLowerCase());
    return matches.length === 1 ? nameOf(matches[0].node_id) : nameOf(pubkey);
  };
  /** A room is named by its other members, as the owner calls them. */
  const boundName = (id: string) => {
    const own = ownId().toLowerCase();
    return localRoom(id)?.roster.filter((p) => p !== own).map(nameOf).join(', ') || 'Room';
  };
  const trackKeyName = (key: string) => {
    const [kind, id] = key.split(':');
    if (kind === 'bound') return boundName(id ?? '');
    return kind === 'room' ? rooms().find((r) => r.id.toLowerCase() === id)?.name ?? 'Room' : nameOf(id ?? key);
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
    approve: () => actions.approve(),
  };
  const openWallet = (tab: WalletTab = 'activity') => {
    setContextOpen(false);
    setWalletTab(tab);
    void loadWallet();
  };

  const welcomeHome = () => <WelcomeHome overview={overview()} moneyBlocked={moneyBlocked()} walletReady={wallet() !== null && !errors.wallet}
      onShare={() => { setTab('frontdoor'); setContextOpen(true); }}
      onAddContact={() => setTrack({ kind: 'discover' })}
      onAddSats={() => openWallet('receive')} />;

  return (
    <div class="cc" classList={{ 'no-context': !props.active }} data-mode={source.mode}>
      <Rail
        pill={pill()}
        active={props.active}
        sample={source.mode === 'sample'}
        peers={peers()}
        rooms={rooms()}
        nodeRooms={nodeRooms()}
        boundRooms={localRooms()}
        boundName={boundName}
        onNewRoom={() => setRoomPlan(true)}
        knocks={knocks()}
        nameOf={nameOf}
        unread={threads.unread}
        openKey={openKey()}
        ownId={ownId()}
        onOpen={(next) => setTrack(next)}
        onProfile={() => {
          setTab('body');
          setContextOpen(true);
        }}
        onWallet={() => openWallet()}
        balanceMsat={wallet()?.balance_msat ?? null}
        behind={walletTab() !== null}
      />

      <Show when={props.active} fallback={<section class="track">{props.firstRun}</section>}>
        <section class="track" aria-label="Track" inert={walletTab() !== null}>
          <Show when={moneyBlocked()}>
            <p class="hint money-notice" data-money-notice role="status">{MONEY_NOT_READY} Sending, paying, first contact, files, rooms, channels and gifts will be available when it is ready.</p>
          </Show>
          <Show when={introNotice()}>
            {(n) => (
              <p class="ok-note intro-notice" data-intro-notice={n().node_id} role="status">
                Connected to {shortId(n().node_id)} from their introduction. Nothing was paid.{' '}
                <button type="button" class="link" data-intro-notice-open onClick={() => openIntroduced(n())}>
                  Open conversation
                </button>{' '}
                <button type="button" class="link" onClick={() => setIntroNotice(null)}>
                  Dismiss
                </button>
              </p>
            )}
          </Show>
          <Show when={track()} fallback={
            <Show when={peersLoaded()} fallback={
              <div class="empty-track">
                <Show when={errors.peers} fallback={<DelayedSpinner />}>
                  <SoftError message={errors.peers!} summary="We could not load your contacts." onReconnect={async () => { await props.onReconnect?.(); await loadPeers(); }} />
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
                      onEarlier={() => loadRoomPage(room().id, roomPages[room().id]?.before ?? null)}
                      sends={roomSends[room().id] ?? []}
                      fresh={threads.fresh}
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
                    nodeReads={overview()?.capabilities?.includes('porch_read_v1') === true}
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
                    artifacts={artifacts[trackKey(t())] ?? []}
                    fresh={threads.fresh}
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
                    budgetStale={grantUnknown() || (budget() !== null && (!budgetConfirmed() || !!errors.budgetPoll))}
                    actions={actions}
                    now={now()}
                    error={errors.thread}
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
      </Show>

      {/* Profile / settings: Body, Node, Wallet, Budget and display prefs. Always
          mounted so existing tests can open tabs; closed until the avatar is pressed. */}
      <div
        class="settings-scrim"
        classList={{ open: contextOpen() }}
        data-settings-open={contextOpen() ? 'true' : 'false'}
        onClick={() => setContextOpen(false)}
      />
      <aside
        ref={setSettingsEl}
        class="context settings-modal"
        classList={{ open: contextOpen() }}
        aria-label="Profile and settings"
        aria-hidden={contextOpen() ? 'false' : 'true'}
        aria-modal={contextOpen() ? true : undefined}
        role="dialog"
        data-settings
      >
        <div class="row settings-head">
          <div class="tabs" role="tablist" style={{ flex: 1 }}>
            <button role="tab" aria-selected={tab() === 'body'} data-tab="body" onClick={() => { setTab('body'); setContextOpen(true); }}>Body</button>
            <button role="tab" aria-selected={tab() === 'node'} data-tab="node" onClick={() => { setTab('node'); setContextOpen(true); }}>Node</button>
            <button role="tab" aria-selected={tab() === 'wallet'} data-tab="wallet" onClick={() => { setTab('wallet'); setContextOpen(true); }}>Wallet</button>
            <button role="tab" aria-selected={tab() === 'budget'} data-tab="budget" onClick={() => { setTab('budget'); setContextOpen(true); }}>Budget</button>
            <button role="tab" aria-selected={tab() === 'frontdoor'} data-tab="frontdoor" onClick={() => { setTab('frontdoor'); setContextOpen(true); }}>Profile</button>
          </div>
          <button class="quiet context-toggle" data-settings-close onClick={() => setContextOpen(false)} aria-label="Close settings">Close</button>
        </div>
        <SettingsDisplay own={ownStun()} />
        <Switch>
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
              onResume={() => void actions.resume()}
            />
          </Match>
          <Match when={tab() === 'node'}>
            <NodePanel overview={overview()} link={link()} peers={peers()} now={now()} error={props.error ?? errors.overview ?? errors.peers} onReconnect={async () => { await props.onReconnect?.(); await loadOverview(); await loadPeers(); }} />
          </Match>
          <Match when={tab() === 'wallet'}>
            <button type="button" class="primary soft" data-open-wallet-page onClick={() => openWallet()}>Open Wallet</button>
            <WalletPanel moneyBlocked={moneyBlocked()} wallet={wallet()} error={errors.wallet} onReconnect={async () => { await props.onReconnect?.(); await loadWallet(); }} fund={props.fund?.(source, moneyBlocked)} />
          </Match>
          <Match when={tab() === 'budget'}>
            <BudgetPanel
              budget={budget()}
              error={errors.budget ?? errors.budgetPoll}
              now={now()}
              nameOf={(id, room) => (room ? rooms().find((r) => r.id.toLowerCase() === id)?.name ?? 'Room' : nameOf(id))}
              actions={actions}
            />
          </Match>
          <Match when={tab() === 'frontdoor'}>
            <FrontDoorEditor source={source} now={now()} />
          </Match>
        </Switch>
      </aside>
      <CallPanel
        view={callView()}
        streams={callStreams()}
        nameOf={nameOf}
        quote={actions.callQuote}
        accept={() => void calls.accept()}
        decline={() => void calls.decline()}
        hangup={() => void calls.hangup()}
        mute={() => calls.toggleMute()}
        camera={() => void calls.toggleCamera()}
        dismiss={() => calls.dismiss()}
      />
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
      <Show when={roomPlan() && props.active}>
        <NewRoomPanel contacts={roomContacts()} nodeRooms={nodeRooms()} onCreate={(picks) => void createRoom(picks)} onCancel={() => setRoomPlan(false)} />
      </Show>
      <Show when={props.active && walletTab()}>
        {(tab) => (
          <WalletPage
            tab={tab()}
            onTab={setWalletTab}
            onClose={() => setWalletTab(null)}
            wallet={wallet()}
            walletError={errors.wallet}
            moneyBlocked={moneyBlocked()}
            spend={spend()}
            spendGate={<SpendBar spend={spend()} error={errors.spend ?? errors.spendPoll} now={now()} actions={actions} />}
            now={now()}
            ownId={ownId()}
            histories={[...peers().map((p) => p.node_id.toLowerCase()), ...rooms().map((r) => r.id.toLowerCase())]}
            threadMessages={Object.values(threads.t).flat()}
            nameOf={(id) => rooms().find((r) => r.id.toLowerCase() === id.toLowerCase())?.name ?? channelName(id)}
            actions={walletActions}
            reads={{ fundingAddress: () => source.fundingAddress(), invoiceStatus: (b) => source.invoiceStatus(b), messages: (id) => source.messages(id) }}
            onRefresh={() => void loadWallet()}
            onReconnect={async () => { await props.onReconnect?.(); await loadWallet(); }}
            custody={overview()?.custody_mode}
          />
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
 * The owner's STUN server for calls. Off by default: with none, calls use
 * host candidates only and connect on the same network. A STUN server learns
 * your public address each time you place or accept a call. When the node
 * runs its own responder, it is offered here, and used only after Save.
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
      setError('Use stun:host or stun:host:port. TURN relays are not supported.');
      return;
    }
    setError(null);
    setStunPref(v);
  };
  return (
    <section data-call-settings>
      <h3>Calls</h3>
      <p class="hint" data-stun-note>
        {stunPref()
          ? stunPref() === ownUrl()
            ? `Calls ask your own node (${stunPref()}) for your public address. No third party is contacted; your node sees your IP address each time you place or accept a call.`
            : `Calls ask ${stunPref()} for your public address, so that server sees your IP address each time you place or accept a call.`
          : 'No STUN server: calls contact no third party and connect only on the same network (or a VPN). Calls across routers need a STUN server you choose, for example one run on your own node.'}
      </p>
      <Show when={ownUrl() && stunPref() !== ownUrl()}>
        <div class="row">
          <button type="button" class="soft" data-stun-own onClick={() => { setDraft(ownUrl()!); setError(null); }}>
            Use my node ({ownUrl()})
          </button>
        </div>
        <Show when={draft().trim() === ownUrl()}>
          <p class="hint" data-stun-own-confirm>Press Save to use your node. It then sees your IP address each time you place or accept a call.</p>
        </Show>
      </Show>
      <Show when={props.own && !ownUrl()}>
        <p class="hint" data-stun-own-hint>
          {`Your node answers STUN on UDP port ${props.own!.port}, but it has no public address set ([network] advertised_addr), so it cannot be offered here. You can enter stun:your-public-address:${props.own!.port} yourself.`}
        </p>
      </Show>
      <div class="row">
        <input data-stun-input placeholder="stun:host:3478" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} aria-label="STUN server for calls (optional)" />
        <button type="button" class="soft" data-stun-save onClick={save}>Save</button>
        <Show when={stunPref()}>
          <button type="button" class="soft" data-stun-clear onClick={() => { setDraft(''); setStunPref(''); setError(null); }}>Remove</button>
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
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  const denoms: { id: Denom; label: string }[] = [
    { id: 'sats', label: 'Sats' },
    { id: 'btc', label: 'BTC' },
  ];
  return (
    <div class="panel settings-display" data-panel="display">
      <h2>Display</h2>
      <h3>Theme</h3>
      <div class="modes soft" role="radiogroup" aria-label="Theme" data-theme-toggle>
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
      <h3>Amounts</h3>
      <div class="modes soft" role="radiogroup" aria-label="Denomination" data-denom-toggle>
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
      <p class="hint">Balances and costs use this unit everywhere. Payment amounts to the node stay in millisatoshis.</p>
      <CallSettings own={props.own} />
    </div>
  );
}

// ---- rail -----------------------------------------------------------------

function Rail(props: {
  pill: ReturnType<typeof nodePill>;
  active: boolean;
  sample: boolean;
  peers: Peer[];
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
  onProfile: () => void;
  onWallet: () => void;
  balanceMsat: number | null;
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });
  const item = (t: TrackRef, name: string, meta?: JSX.Element) => {
    const key = trackKey(t);
    return (
      <button
        class="track-link"
        data-track={key}
        aria-current={props.openKey === key}
        disabled={!props.active}
        onClick={() => props.onOpen(t)}
      >
        <span class="name">{name}</span>
        <Show when={(props.unread[key] ?? 0) > 0} fallback={meta}>
          <span class="badge" aria-label={`${props.unread[key]} new`}>{props.unread[key]}</span>
        </Show>
      </button>
    );
  };

  return (
    <nav class="rail" aria-label="Tracks" inert={props.behind}>
      <div class="mark">
        Bit<span>Sov</span>
      </div>
      <button class="node-pill" title={props.pill.text} data-pill={props.pill.tone} onClick={() => props.onProfile()} disabled={!props.active}>
        <span class={`dot ${props.pill.tone}`} classList={{ live: props.pill.live }} />
        <span class="what">{props.pill.text}</span>
        <Show when={props.active}>
          <span class="peers" title="Connected peers">{props.peers.filter((p) => p.connected).length}/{props.peers.length}</span>
        </Show>
      </button>

      <div class="track-group">
        <h2>Peers</h2>
        <Show when={props.active} fallback={<p class="track-empty">Available after setup</p>}>
          <For each={props.peers} fallback={<p class="track-empty">No peers yet</p>}>
            {(p) =>
              item({ kind: 'peer', id: p.node_id.toLowerCase() }, peerName(p, p.node_id), <span class={`dot ${p.connected ? 'ok' : ''}`} title={p.connected ? 'Connected' : 'Offline'} />)
            }
          </For>
        </Show>
      </div>

      <div class="track-group" data-rooms-soon={props.active && props.nodeRooms ? undefined : ''}>
        <h2>Rooms</h2>
        <Show
          when={props.active && props.nodeRooms}
          fallback={
            <p class="track-empty" data-rooms-coming-soon>
              {props.active ? 'This node does not support rooms yet.' : 'Room availability is checked after setup.'}
            </p>
          }
        >
          <For each={props.boundRooms}>
            {(r) => item({ kind: 'bound', id: r.id }, props.boundName(r.id), <span class="meta">{r.roster.length}</span>)}
          </For>
          <button class="track-link new-track" data-room-new onClick={() => props.onNewRoom()}>
            + New room
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
          <h2>At your door</h2>
          <For each={props.knocks}>
            {(id) => (
              <button
                class="track-link knock"
                data-door-track={`peer:${id}`}
                aria-current={props.openKey === `peer:${id}`}
                title="Paid your door price. Not a contact."
                onClick={() => props.onOpen({ kind: 'peer', id })}
              >
                <span class="name id">{shortId(id)}</span>
                <Show when={(props.unread[`peer:${id}`] ?? 0) > 0} fallback={<span class="meta">paid</span>}>
                  <span class="badge">{props.unread[`peer:${id}`]}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="track-group">
        <h2>AI</h2>
        <Show when={props.active}>{item({ kind: 'ai' }, 'Ask your node', <span class="meta">local</span>)}</Show>
      </div>

      <div class="track-group">
        <h2>Browse</h2>
        <Show when={props.active}>
          <button
            class="track-link"
            data-track="discover"
            aria-current={props.openKey === 'discover'}
            onClick={() => props.onOpen({ kind: 'discover' })}
          >
            <span class="name">Profiles</span>
            <span class="meta">paste a card</span>
          </button>
          <button
            class="track-link"
            data-track="porch"
            aria-current={props.openKey === 'porch'}
            onClick={() => props.onOpen({ kind: 'porch' })}
          >
            <span class="name">Porch</span>
            <span class="meta">cards & pages · paid</span>
          </button>
        </Show>
      </div>

      <div class="rail-foot">
        <Show when={props.active}>
          <button class="track-link new-track" data-track="new" aria-current={props.openKey === 'new'} onClick={() => props.onOpen({ kind: 'new' })}>
            + New
          </button>
        </Show>
        <Show when={props.sample}>
          <span class="mode-tag" data-sample>Sample data, no node</span>
        </Show>
        <div class="avatar-menu-wrap">
          <Show when={menuOpen()}>
            <div class="avatar-scrim" onClick={() => setMenuOpen(false)} />
            <div class="avatar-menu" role="menu" aria-label="You" data-avatar-menu>
              <button type="button" role="menuitem" class="avatar-menu-item wallet" data-open-wallet onClick={() => choose(props.onWallet)}>
                <span class="name">Wallet</span>
                <Show when={props.balanceMsat !== null}>
                  <span class="meta sats" data-avatar-balance>{fmtAmount(props.balanceMsat!)}</span>
                </Show>
              </button>
              <button type="button" role="menuitem" class="avatar-menu-item" data-open-settings onClick={() => choose(props.onProfile)}>
                <span class="name">Profile and settings</span>
              </button>
            </div>
          </Show>
          <button
            ref={avatar}
            type="button"
            class="profile-avatar"
            data-profile
            disabled={!props.active}
            aria-label="You: wallet, profile and settings"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            title="Wallet, profile and settings"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span class="avatar-mark" aria-hidden="true">BS</span>
            <span class="avatar-label">You</span>
          </button>
        </div>
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
          aria-label={`Contact ${props.title}`}
        >
          <h1>{props.title}</h1>
          <Show when={props.keyChanged}>
            <span class="contact-pill warn" data-contact-pill="key-changed">Key changed</span>
          </Show>
          <Show when={props.verified && !props.keyChanged}>
            <span class="contact-pill ok" data-contact-pill="verified">Verified</span>
          </Show>
        </button>
      </Show>
      <div class="sub">{props.sub}</div>
      {props.extra}
      <button
        type="button"
        class="quiet context-toggle icon-btn"
        onClick={() => props.onContext()}
        title="Settings"
        aria-label="Settings"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="sr-only">Settings</span>
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
  budgetStale: boolean;
  actions: Actions;
  now: number;
  error: string | undefined;
  onReconnect: () => void;
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onContext: () => void;
}) {
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
      name: props.track.kind === 'peer' ? `${props.name}’s` : undefined,
      room: props.roomQuote,
      nowMs: props.now,
    });
  // Room chats show in their room, not as raw text here.
  const items = () => streamItems(props.messages.filter((m) => !isCallKind(m.kind) && !(props.track.kind === 'peer' && roomOf(m, props.ownId))), props.artifacts);

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
        {props.members === null ? 'Reading members…' : `${props.members.length} members · ${props.nodeRooms ? 'Legacy room' : 'Rooms unavailable on this node'}`}
      </span>
    );

  return (
    <>
      <TrackHead
        title={props.name}
        sub={sub()}
        extra={
          <Show when={props.track.kind === 'peer' && props.peer ? props.track.id : null}>
            {(peer) => <CallButtons peer={peer()} name={props.name} blocked={props.moneyBlocked} actions={props.actions} />}
          </Show>
        }
        onContext={props.onContext}
        onContact={props.track.kind === 'peer' && props.peer ? () => setContactOpen(true) : undefined}
        verified={peerVerify().verified}
        keyChanged={peerVerify().keyChanged}
      />
      <Show when={props.track.kind === 'peer' && props.peer}><CallNetworkNote /></Show>
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
      <div class="stream" ref={stream} data-stream>
        <div class="chat-column">
        <Show when={props.introduced}>
          {(c) => (
            <p class="day" data-introduced={c().node_id}>
              Opened from {props.name}’s signed introduction. Estimated from their card: admission {fmtAmount(allIn(c().admission_msat))} including {feeCeiling(routingFee(c().admission_msat))}, each
              message {fmtAmount(allIn(c().message_msat))} including {feeCeiling(routingFee(c().message_msat))} (estimated ceilings). You confirm their node’s own quote before anything is paid, and every
              message pays.
            </p>
          )}
        </Show>
        <Show when={props.doorstep}>
          {(c) => (
            <p class="day" data-doorstep={c().node_id}>
              Opened from {props.name}’s profile. Card snapshot (display only): admission {fmtAmount(allIn(c().admission_msat))}, each
              message {fmtAmount(allIn(c().message_msat))}. Knock uses their live first-contact quote — you confirm before anything is paid.
            </p>
          )}
        </Show>
        <Show when={props.track.kind === 'room'}>
          <p class="day" data-room-day-notice>
            {props.nodeRooms ? 'This is a legacy room. Create a new room to use group chat.' : 'This node does not support rooms yet.'} Members added here are not notified yet. A room message pays each member their own price, separately.
          </p>
        </Show>
        <For
          each={items()}
          fallback={
            <div class="empty-track">
              <h2>Nothing here yet</h2>
              <p class="hint">
                {props.track.kind === 'room'
                  ? `${props.nodeRooms ? 'This is a legacy room. Create a new room to use group chat.' : 'This node does not support rooms yet.'} A message here pays each member separately, and reaches each one when their payment settles.`
                  : `Your first message to ${props.name} is a paid first contact: it is admitted when the payment settles.`}
              </p>
            </div>
          }
        >
          {(item, i) => {
            const prev = () => items()[i() - 1];
            const newDay = () => !prev() || day(prev()!.at) !== day(item.at);
            return (
              <>
                <Show when={newDay()}>
                  <p class="day">{day(item.at)}</p>
                </Show>
                <Switch>
                  <Match when={item.type === 'message' && item.message}>
                    {(m) => (
                      <MessageView
                        m={m()}
                        out={isOutgoing(m(), props.ownId)}
                        room={props.track.kind === 'room'}
                        fresh={!!props.fresh[m().id]}
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
                  <Match when={item.type === 'artifact' && item.artifact}>
                    {(a) => <ArtifactView moneyBlocked={props.moneyBlocked} a={a()} nameOf={props.nameOf} delivery={a().type === 'file' ? props.deliveries[(a() as { receipt: { message_id: string } }).receipt.message_id] : undefined} onRetry={(id, approved) => props.actions.retryDelivery(props.track, id, approved)} onStop={(pendingId) => props.actions.stopRetrying(props.track, pendingId)} />}
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

      <Composer
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
 * A contact's Lightning node id, when the app knows it. The node keeps one
 * per connected peer for its own keysend but exposes none (GET /peers has no
 * such field), so today no invoice payee is ever named as a contact.
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
      {v().verified ? `Pays ${v().text}’s Lightning node.` : `Pays ${v().text}.`}
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
      <span class="kind">Payment request from {props.name}</span>
      <span class="sats big">{sats(props.inv.amount_msat)} <span class="unit">{satUnit(props.inv.amount_msat)}</span></span>
      <Show when={purpose()} fallback={<span class="hint">No purpose given</span>}>
        <span class="purpose" data-request-purpose>For: {purpose()}</span>
      </Show>
      <PayeeLine payee={props.inv.payee} peer={props.peer} name={props.name} />
      <Show
        when={done()}
        fallback={
          <>
            <span class="hint">Expires at {clock(props.inv.expires_at_ms)}. Nothing is paid until you confirm.</span>
            <button type="button" class="primary money" data-request-pay disabled={props.blocked} onClick={() => props.onPay(props.inv.bolt11)}>
              Pay
            </button>
          </>
        }
      >
        {(status) => (
          <span class="request-paid" data-request-paid={status()}>
            {status() === 'settled' ? 'Paid. You paid this invoice.' : 'Payment in progress. Check its receipt below before trying again.'}
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
    <article class={`msg ${props.out ? 'out' : 'in'}`} classList={{ fresh: props.fresh }} data-message={props.m.id}>
      <Show when={!props.out && props.room}>
        <span class="who">{props.nameOf(props.m.sender)}</span>
      </Show>
      <Show
        when={payable()}
        fallback={
          <div class="bubble" classList={{ file: props.m.kind === 200 }} data-kind={props.m.kind}>
            <Show when={props.m.kind === 200} fallback={props.m.plaintext ?? 'Encrypted content not available on this device'}>
              <Show
                when={!props.out && props.fileFetch && props.fileSave}
                fallback={
                  <Show when={props.voiceUrl && isVoiceNote(props.m.kind, props.m.plaintext)} fallback={<span class="file-name">{props.m.plaintext ?? 'File'}</span>}>
                    <VoiceNote id={props.m.id} name={fileNameOf(props.m.plaintext) ?? 'file'} load={props.voiceUrl!} />
                  </Show>
                }
              >
                <ReceivedFile
                  id={props.m.id}
                  name={fileNameOf(props.m.plaintext) ?? 'file'}
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
            title={props.out ? paidLabel() : `${fmtAmount(amount())} · to you`}
          >
            <Bolt />
            <span class="sats">{props.out ? paidLabel() : fmtAmount(amount())}</span>
          </span>
          <Show when={props.out && props.allowance?.readmission_msat}>
            <span data-readmission-paid>incl. admission again {sats(props.allowance!.readmission_msat!)} {satUnit(props.allowance!.readmission_msat!)}</span>
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

function CallNetworkNote() {
  return <Show when={!stunPref()}>
    <p class="hint call-network-note" data-call-network-note>Calls may not connect across networks yet. No STUN server is set. Choose one in Settings → Calls.</p>
  </Show>;
}

/**
 * Call and video buttons. The price is read (never paid) first and shown on
 * the button: the offer to this contact plus one hangup, all-in.
 */
function CallButtons(props: { peer: string; name: string; blocked: boolean; actions: Actions }) {
  const [quote, setQuote] = createSignal<CallQuote | null>(null);
  const [why, setWhy] = createSignal<string | null>(null);
  createEffect(on(() => props.peer, (peer) => {
    setQuote(null);
    setWhy(null);
    void props.actions.callQuote(peer).then((r) => {
      if (props.peer !== peer) return;
      if (r.ok) setQuote(r.value);
      else setWhy(r.error.message);
    });
  }));
  const cost = () => {
    const q = quote();
    return q && callCost(q) !== null ? callCost(q)! : null;
  };
  const off = () => props.blocked || cost() === null || props.actions.callActive();
  const title = () =>
    why() ?? (quote() && cost() === null ? `${props.name}’s node does not take calls yet` : cost() !== null
      ? `Up to ${fmtAmount(cost()!)}: ${fmtAmount(quote()!.offer_msat! + quote()!.offer_max_routing_fee_msat)} to ring (their call price plus ${feeCeiling(quote()!.offer_max_routing_fee_msat)}), then ${fmtAmount(signalCost(quote()!))} to hang up. Media goes directly between you; it is not billed. ${stunPref() ? `Uses your STUN server ${stunPref()} to find a route.` : 'No STUN server is set, so calls connect only on the same network (Settings).'}`
      : 'Reading their call price…');
  const place = (media: CallMedia) => { const q = quote(); if (q && !off()) props.actions.placeCall(props.peer, media, q); };
  return (
    <div class="call-buttons" data-call-buttons>
      <button type="button" class="soft call-button icon-btn" data-call="audio" disabled={off()} title={title()} aria-label={`Call ${props.name}${cost() !== null ? `, up to ${fmtAmount(cost()!)}` : ''}`} onClick={() => place('audio')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
      </button>
      <button type="button" class="soft call-button icon-btn" data-call="video" disabled={off()} title={title()} onClick={() => place('video')} aria-label={`Video call ${props.name}${cost() !== null ? `, up to ${fmtAmount(cost()!)}` : ''}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3z" /></svg>
      </button>
      <button type="button" class="soft call-button icon-btn quiet" data-call="meeting" disabled={off()} title={`Start a meeting with ${props.name} and up to ${MAX_PARTICIPANTS - 2} more contacts. The price shows before anyone is rung.`} aria-label={`Start a meeting with ${props.name}`} onClick={() => props.actions.planMeeting(props.peer)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14a5 5 0 0 1 4 5" /></svg>
      </button>
    </div>
  );
}

const CALL_TITLE: Record<CallView['phase'], string> = {
  idle: '', calling: 'Calling', ringing: 'Ringing', incoming: 'Incoming call', connecting: 'Connecting', live: 'On call', ended: 'Call ended',
};
const END_REASON: Record<string, string> = {
  hangup: 'Hung up', declined: 'Declined', busy: 'Busy', timeout: 'No answer', failed: 'Connection failed',
};

function MediaView(props: { stream: MediaStream | null; video: boolean; muted: boolean; kind: 'local' | 'remote' }) {
  let el: HTMLMediaElement | undefined;
  createEffect(() => { if (el) el.srcObject = props.stream; });
  return props.video
    ? <video ref={(v) => { el = v; }} autoplay playsinline muted={props.muted} class={`call-video ${props.kind}`} data-call-media={props.kind} />
    : <audio ref={(a) => { el = a; }} autoplay muted={props.muted} data-call-media={props.kind} />;
}

/** The call card: incoming (accept/decline with price), ringing, live (mute, camera, duration, hang up), ended. */
function CallPanel(props: {
  view: CallView;
  streams: { local: MediaStream | null; remote: MediaStream | null };
  nameOf: (id: string) => string;
  quote: (peer: string) => Promise<Outcome<CallQuote>>;
  accept: () => void;
  decline: () => void;
  hangup: () => void;
  mute: () => void;
  camera: () => void;
  dismiss: () => void;
}) {
  const [tick, setTick] = createSignal(Date.now());
  const [answer, setAnswer] = createSignal<number | null>(null);
  createEffect(() => {
    if (props.view.phase !== 'live') return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  createEffect(on(() => (props.view.phase === 'incoming' ? props.view.peer : null), (peer) => {
    setAnswer(null);
    if (peer) void props.quote(peer).then((r) => { if (r.ok) setAnswer(signalCost(r.value)); });
  }));
  const v = () => props.view;
  const who = () => (v().peer ? props.nameOf(v().peer!) : '');
  const price = (m: number | null) => (m === null ? '' : ` · ${sats(m)} ${satUnit(m)}`);
  return (
    <Show when={v().phase !== 'idle'}>
      <aside class="call-panel" data-call-panel={v().phase} role="dialog" aria-label={`${CALL_TITLE[v().phase]} ${who()}`}>
        <header>
          <strong data-call-title>{CALL_TITLE[v().phase]}{v().media === 'video' ? ' (video)' : ''}</strong>
          <span class="who">{who()}</span>
          <Show when={v().phase === 'live' && v().liveAt}>
            <span class="duration" data-call-duration>{duration(Math.max(0, tick() - v().liveAt!))}</span>
          </Show>
        </header>
        <CallNetworkNote />
        <Show when={v().media === 'video' && (v().phase === 'live' || v().phase === 'connecting')}>
          <div class="call-videos">
            <MediaView stream={props.streams.remote} video muted={false} kind="remote" />
            <MediaView stream={props.streams.local} video muted kind="local" />
          </div>
        </Show>
        <Show when={v().media === 'audio'}>
          <MediaView stream={props.streams.remote} video={false} muted={false} kind="remote" />
        </Show>
        <Show when={v().paidMsat > 0}>
          <p class="hint" data-call-paid>Paid {fmtAmount(v().paidMsat)} for this call’s signals. Media is direct and not billed.</p>
        </Show>
        <Show when={v().phase === 'ended'}>
          <p class="hint" data-call-ended>{v().error ?? END_REASON[v().reason ?? 'hangup']}</p>
        </Show>
        <div class="call-actions">
          <Switch>
            <Match when={v().phase === 'incoming'}>
              <button type="button" class="primary soft money" data-call-accept onClick={() => props.accept()}>Accept{price(answer())}</button>
              <button type="button" class="soft" data-call-decline onClick={() => props.decline()}>Decline{price(answer())}</button>
            </Match>
            <Match when={v().phase === 'ended'}>
              <button type="button" class="soft" data-call-dismiss onClick={() => props.dismiss()}>Close</button>
            </Match>
            <Match when={true}>
              <Show when={v().phase === 'live' || v().phase === 'connecting'}>
                <button type="button" class="soft" data-call-mute aria-pressed={v().muted} onClick={() => props.mute()}>Mute</button>
                <Show when={v().media === 'video'}>
                  <button type="button" class="soft" data-call-camera aria-pressed={v().camera} onClick={() => props.camera()}>Camera</button>
                </Show>
              </Show>
              <button type="button" class="danger soft" data-call-hangup onClick={() => props.hangup()}>
                {v().phase === 'calling' ? 'Cancel' : 'Hang up'}
              </button>
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
  );
}

const LEG_STATE: Record<LegState, string> = {
  waiting: 'Waiting', placing: 'Preparing…', ringing: 'Ringing', incoming: 'Ringing you', connecting: 'Connecting', live: 'Live', ended: 'Ended', nolink: 'No link',
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
        <aside class="call-panel meeting-panel" data-meeting-panel="planning" role="dialog" aria-label="Plan a meeting">
          <header><strong>Meeting</strong><span class="who">you and up to {MAX_PARTICIPANTS - 1} contacts</span></header>
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
                    <Match when={props.nodeMeets && !c.connected}><span class="hint" data-meeting-pick-note={c.id}> not connected</span></Match>
                    <Match when={props.nodeMeets && !c.meetings}><span class="hint" data-meeting-pick-note={c.id}> needs update</span></Match>
                    <Match when={quotes[c.id] === undefined}><span class="hint" data-meeting-pick-note={c.id}> reading price…</span></Match>
                    <Match when={!priced(c.id)}><span class="hint" data-meeting-pick-note={c.id}> does not take calls</span></Match>
                  </Switch>
                </li>
              )}
            </For>
          </ul>
          <Show when={!props.nodeMeets}><p class="hint" data-meeting-node-update>Your node needs an update before it can hold meetings.</p></Show>
          <Show when={props.blocked}><p class="hint" data-meeting-blocked>Payments are not ready yet, so nobody can be invited.</p></Show>
          <p class="hint" data-meeting-note>You ring each person you pick (their call price, once each). Picked contacts who are not each other’s contacts will not hear each other. Media goes directly between you; it is not billed.</p>
          <div class="call-actions">
            <button type="button" class="primary soft money" data-meeting-invite disabled={planCost() === null} onClick={() => props.invite(props.plan!, 'audio', shown(props.plan!))}
              aria-label={`Invite${planCost() !== null ? `, up to ${fmtAmount(planCost()!)}` : ''}`}>
              Invite{price(planCost())}
            </button>
            <button type="button" class="soft" data-meeting-invite-video disabled={planCost() === null} onClick={() => props.invite(props.plan!, 'video', shown(props.plan!))}
              aria-label={`Video invite${planCost() !== null ? `, up to ${fmtAmount(planCost()!)}` : ''}`}>
              Video invite{price(planCost())}
            </button>
            <button type="button" class="soft" data-meeting-cancel onClick={() => props.setPlan(null)}>Cancel</button>
          </div>
        </aside>
      </Show>
      <Show when={v().phase !== 'idle' && !planning()}>
        <aside class="call-panel meeting-panel" data-meeting-panel={v().phase} role="dialog" aria-label={`Meeting ${v().phase}`}>
          <header>
            <strong data-meeting-title>{v().phase === 'invited' ? 'Meeting invite' : v().phase === 'ended' ? 'Meeting ended' : `Meeting · ${v().roster.length} people`}</strong>
            <span class="who">{v().phase === 'invited' ? `${host()} invites you, with ${others() || 'nobody else'}` : ''}</span>
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
            <p class="hint" data-meeting-ignore>Ignore it: nothing is paid, and the invite ends by itself after a minute.</p>
          </Show>
          <Show when={v().paidMsat > 0}>
            <p class="hint" data-meeting-paid>Paid {fmtAmount(v().paidMsat)} for this meeting’s signals. Media is direct and not billed.</p>
          </Show>
          <Show when={v().phase === 'ended' && v().error}>
            <p class="hint" data-meeting-ended>{v().error}</p>
          </Show>
          <div class="call-actions">
            <Switch>
              <Match when={v().phase === 'invited'}>
                <button type="button" class="primary soft money" data-meeting-join disabled={joinPrice() === null} onClick={() => props.join(shown(v().roster))}
                  aria-label={`Join${joinPrice() !== null ? `, up to ${fmtAmount(joinPrice()!)}` : ''}`}>
                  Join{price(joinPrice())}
                </button>
                <button type="button" class="soft" data-meeting-decline disabled={declinePrice() === null} onClick={() => props.decline(shown(v().roster))}
                  aria-label={`Decline${declinePrice() !== null ? `, up to ${fmtAmount(declinePrice()!)}` : ''}`}>
                  Decline{declinePrice() !== null ? ` · up to ${sats(declinePrice()!)} ${satUnit(declinePrice()!)}` : ''}
                </button>
              </Match>
              <Match when={v().phase === 'active'}>
                <button type="button" class="soft" data-meeting-mute aria-pressed={v().muted} onClick={() => props.mute()}>Mute</button>
                <Show when={v().media === 'video'}>
                  <button type="button" class="soft" data-meeting-camera aria-pressed={v().camera} onClick={() => props.camera()}>Camera</button>
                </Show>
                <button type="button" class="danger soft" data-meeting-leave onClick={() => props.leave()}>Leave</button>
              </Match>
              <Match when={v().phase === 'ended'}>
                <button type="button" class="soft" data-meeting-dismiss onClick={() => props.dismiss()}>Close</button>
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
  const [err, setErr] = createSignal<'gone' | 'large' | 'save' | null>(null);
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
      else if (s.includes(FILE_NOT_STORED)) setErr('gone');
      // Other preview failures leave Save available.
    } finally {
      setBusy(false);
    }
  };

  onMount(() => { void loadPreview(); });

  const onSave = async () => {
    if (err() === 'large' || err() === 'gone' || busy() || saveDialogOpen) return;
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
        <Show when={err() === 'large'} fallback={
          <Show when={meta()} fallback={busy() ? '…' : ''}>
            {(b) => <>{kb(b().size_bytes)} · {shortMime(b().mime_type)}</>}
          </Show>
        }>
          Over 1.4 MB · not saved
        </Show>
        <Show when={err() === 'gone'}> · not stored</Show>
        <Show when={err() === 'save'}> · could not save</Show>
      </p>
      <Show when={err() !== 'large' && err() !== 'gone'}>
        <button type="button" class="link" data-file-save disabled={busy() || saved()} onClick={() => void onSave()}>
          {saved() ? 'Saved' : busy() ? '…' : 'Save'}
        </button>
      </Show>
    </div>
  );
}

function shortMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m.startsWith('image/')) return m.slice(6) || 'image';
  if (m.startsWith('audio/')) return m.slice(6) || 'audio';
  if (m.startsWith('text/')) return m.slice(5) || 'text';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/octet-stream') return 'file';
  return m || 'file';
}

function VoiceNote(props: { id: string; name: string; load: (messageId: string) => Promise<string> }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Why it cannot play: the file is gone, or it is not audio despite its name.
  const [missing, setMissing] = createSignal<'gone' | 'not_audio' | null>(null);
  const open = async () => {
    setBusy(true);
    try {
      setUrl(await props.load(props.id));
    } catch (e) {
      setMissing(String(e).includes(NOT_A_VOICE_NOTE) ? 'not_audio' : 'gone');
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
              ? `File · ${props.name} (not audio, not played)`
              : missing() === 'gone' ? 'Voice note · not stored on this device' : busy() ? 'Loading…' : '▶ Voice note'}
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
  spend_unknown: 'Outcome unknown / pending',
  payment_unknown: 'Payment unknown · not resent',
  failed_paid: 'Paid · refused by their node',
};

const DELIVERY_TEXT: Record<Delivery['status'], string> = {
  accepted: 'Delivered',
  sent: 'Sent',
  queued: 'Queued',
  delivered: 'Delivered',
  rejected: 'Rejected',
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
      <span class="sats">{sats(msat)}</span> {satUnit(msat)}
    </>
  );
  return (
    <div class="door-card" data-door={`${c.side}-${c.verdict}`} data-code={c.side === 'out' ? c.code : undefined} classList={{ refused: c.verdict === 'refused' }} role="note">
      <p class="door-rule">
        <span>{clock(props.at)} · door</span>
      </p>
      <Switch>
        <Match when={c.side === 'in' && c.verdict === 'admitted' && (c as Extract<DoorCard, { verdict: 'admitted' }>)}>
          {(x) => (
            <>
              <p class="door-head">
                <span class="id" title={x().sender}>{shortId(x().sender)}</span> paid <Show when={x().paid_msat !== null} fallback="your price">{amt(x().paid_msat!)}</Show> to reach you
              </p>
              <p class="door-proof">settled · recipient-bound · single-use</p>
              <p class="door-note">Not a contact, and not added. Nothing is kept beyond this message.</p>
            </>
          )}
        </Match>
        <Match when={c.side === 'in' && c.verdict === 'refused' && (c as Extract<DoorCard, { side: 'in'; verdict: 'refused' }>)}>
          {(x) => (
            <>
              <p class="door-head">
                Refused at your door · {gateWords(x().code)}
              </p>
              <p class="door-proof">
                <Show when={x().required_msat !== null}>needed {amt(x().required_msat!)}</Show>
                <Show when={x().required_msat !== null && x().paid_msat !== null}> · </Show>
                <Show when={x().paid_msat !== null}>paid {amt(x().paid_msat!)}</Show>
              </p>
              <p class="door-note">Signed by {props.nameOf(x().sender)}. Nothing was stored or delivered.</p>
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
                    <p class="door-head">Not sent · their price is above your cap</p>
                    <p class="door-proof">{x().detail}</p>
                    <p class="door-note">Nothing was paid. Reopen the track to read their current price.</p>
                  </>
                }
              >
                <p class="door-head">Not sent · they ask for admission again</p>
                <p class="door-proof">{x().detail}</p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function ArtifactView(props: { moneyBlocked: boolean; a: Artifact; delivery?: Delivery; nameOf: (id: string) => string; onRetry?: (id: string, approvedMsat?: number) => Promise<unknown>; onStop?: (pendingId: string | null) => Promise<unknown> }) {
  return (
    <Switch>
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
              <span class="kind">Invoice · you receive</span>
              <span class="sats big">{sats(inv().amount_msat)} <span class="unit">{satUnit(inv().amount_msat)}</span></span>
              <Show when={inv().note}>
                <span class="hint">{inv().note}</span>
              </Show>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Invoice as a QR code">
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <code class="address" data-bolt11>{inv().bolt11}</code>
              <span class="hint">Expires at {clock(inv().expires_at_ms)}. Paying it sends sats to your node.</span>
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
                  fallback={<span class="err-note">Payment of <span class="sats">{sats(r().amount_msat)}</span> {satUnit(r().amount_msat)} failed</span>}
                >
                  <span>You sent <span class="sats">{sats(r().amount_msat)}</span> {satUnit(r().amount_msat)}{r().method === 'keysend' ? ' · direct (keysend)' : ''}</span>
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
              <span class="kind">File</span>
              <span class="file-name">{r().filename} <span class="hint">{kb(r().size_bytes)}</span></span>
              <span class="stamp">
                <Bolt />
                <span class="sats">{sats((r().total_msat ?? r().amount_msat + (r().max_routing_fee_msat ?? 0)))}</span>
                <span>{satUnit((r().total_msat ?? r().amount_msat + (r().max_routing_fee_msat ?? 0)))} all-in ceiling ({feeCeiling(r().max_routing_fee_msat ?? 0)}) · {clock(r().sent_at_ms)}</span>
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
        <summary>Details</summary>
        <p>{copy().detail}</p>
      </details>
      <Show when={props.a.paid.retry && props.onRetry}>
        <Show
          when={props.a.admission}
          fallback={
            <button type="button" class="link" data-retry-delivery disabled={props.moneyBlocked || busy()} onClick={() => void run(() => props.onRetry!(props.a.id))}>
              {busy() ? 'Retrying…' : 'Retry delivery'}
            </button>
          }
        >
          {(adm) => (
            <>
              <p class="hint" data-admission-price={adm().total_msat} data-admission-line>{admissionCopy(adm()).body}</p>
              <details class="quiet-detail" data-admission-detail>
                <summary>Details</summary>
                <p>{admissionCopy(adm()).detail}</p>
              </details>
              <button type="button" class="link" data-retry-approve disabled={props.moneyBlocked || busy()} onClick={() => void run(() => props.onRetry!(props.a.id, adm().total_msat))}>
                {busy() ? 'Checking…' : props.a.ownerApproval ? 'Check approval and retry' : admissionCopy(adm()).action}
              </button>
            </>
          )}
        </Show>
      </Show>
      <Show when={props.onStop}>
        <button type="button" class="link" data-stop-retrying disabled={busy()} onClick={() => void run(() => props.onStop!(props.a.pendingId))}>
          Stop retrying
        </button>
      </Show>
      <Show when={props.a.ownerApproval}>
        {(approval) => <div data-retry-owner><p>Approve at your node, then check.</p><code class="address">{approval().owner_command}</code></div>}
      </Show>
      <Show when={props.a.note}>
        <p class="hint" data-retry-note>{props.a.note}</p>
      </Show>
    </div>
  );
}

/** The draft was paid for: it now lives on the undelivered card, not in the composer. */
const paidUndelivered = (r: Outcome<unknown>) => !r.ok && r.error.code === 'payment_settled_undelivered';

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

/** `sats` or `BTC`: the unit typed amounts are read in. */
const unitName = () => (denom() === 'btc' ? 'BTC' : 'sats');

/** Amount first: one big field in the chosen denomination. Refuses, never rounds, a finer amount. */
function AmountField(props: { data: 'pay' | 'request'; label: string; value: string; onInput: (v: string) => void }) {
  /** Why the typed amount cannot be used, before any review. */
  const problem = (): string | null => {
    if (props.value.trim() === '') return null;
    const msat = parseAmount(props.value, denom());
    if (msat === null) return `Use digits and one dot, at most ${denom() === 'btc' ? 11 : 3} decimals.`;
    return inPaymentBounds(msat) ? null : `Between ${fmtAmount(MIN_PAYMENT_MSAT)} and ${fmtAmount(MAX_PAYMENT_MSAT)}.`;
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
          aria-label={`${props.label} in ${unitName()}`}
          aria-invalid={invalid()}
        />
        <span class="amount-unit">{unitName()}</span>
      </label>
      <Show when={invalid()}>
        <p class="hint" data-amount-invalid>{problem()}</p>
      </Show>
    </>
  );
}

type Mode = 'message' | 'pay' | 'request' | 'file';
/** An invoice review: only the host's decode, paid as its canonical string. */
const invoiceReview = (read: InvoiceAmount): PayReview => ({ kind: 'invoice', bolt11: read.bolt11, msat: read.amount_msat, payee: read.payee });

type PayReview =
  | { kind: 'invoice'; bolt11: string; msat: number; payee: string }
  | { kind: 'keysend'; pubkey: string; msat: number; memo: string };

function Composer(props: {
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
  const [amount, setAmount] = createSignal('');
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
    setRecording(null);
    const clip = await r.rec.stop();
    if (generation !== voiceGeneration) return;
    composerRevision++;
    if (!clip) {
      setNote('Nothing was recorded.');
      return;
    }
    if (clip.size > FILE_MAX_BYTES) {
      setNote('That clip is over 1.4 MB, too large to send. Nothing was sent; record a shorter one.');
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
      setNote(e instanceof Error ? e.message : 'This window cannot record audio.');
    } finally {
      setStarting(false);
    }
  };
  // Inputs and navigation remain usable during a send. Only the submitted
  // revision may be cleared by its completion (including track A -> B -> A).
  let composerRevision = 0;
  // Going offline invalidates undispatched approvals, not unchanged inputs
  // belonging to an operation that already reached the host and succeeds.
  let approvalRevision = 0;
  const [ownerWait, setOwnerWait] = createSignal<{ approval: OwnerContactApproval; revision: number; send: () => Promise<void> } | null>(null);
  const cancelOwner = () => {
    const pending = untrack(ownerWait);
    setOwnerWait(null);
    if (pending) void props.actions.ownerCancel(pending.approval.id);
  };
  onCleanup(cancelOwner);
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
      setNote('Contact approval expired. Nothing was sent. Get a fresh quote to try again.');
    };
    const tick = async () => {
      if (ownerWait() !== pending) return;
      setOwnerCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      if (remote && Date.now() >= deadline) { expire(); return; }
      if (polling || Date.now() < nextPoll) return;
      polling = true;
      const result = await props.actions.ownerStatus(pending.approval.id);
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
          setBusy(true);
          try { await pending.send(); } finally { setBusy(false); }
        } else {
          delay = remote ? Math.min(delay * 2, 10000) : 1000;
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
        cancelOwner();
        setOwnerExpired(false);
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
  // Switching sats/BTC rewrites the typed amount, so it still means the same msat.
  createEffect(
    on(
      denom,
      (next, prev) => {
        if (!prev) return;
        const msat = parseAmount(untrack(amount), prev);
        if (msat !== null) setAmount(amountText(msat, next));
      },
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
        if (!p || p.key !== trackKey(props.track) || room()) return;
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
  /** A Touch ID grant is open, but not for this contact. */
  const lacksEnvelope = () => {
    if (props.actions.noEnvelopeFor() === target()) return true;
    const envelopes = budget()?.node_grant?.envelopes;
    if (!envelopes) return false;
    const until = envelopes[target()];
    return !until || until <= Date.now();
  };
  /** The next tap here is Touch ID for this contact. */
  const needsTouch = () =>
    touchable() && !budget()?.paused && props.spend?.state !== 'pending' &&
    (!(line().open || ((mode() === 'message' || mode() === 'file') && budget()?.autopay.state === 'open')) || lacksEnvelope());
  /**
   * Messages go through the budget unless the owner opened the ten-minute
   * window by hand with no budget approval, or the host has no budget to show.
   */
  const viaBudget = () => {
    const b = budget();
    // Messages and files share budget / window rules; pay & request stay manual.
    if ((mode() !== 'message' && mode() !== 'file') || !b) return false;
    return b.paused || b.waiting_for_owner || b.autopay.state === 'open' || !line().open;
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
    if (room()) return false;
    if (readmit()) return true;
    const kind = budgetStand(budget(), target(), false, null).kind;
    if (kind === 'first') return true;
    if (kind === 'ok' || kind === 'contact_used' || kind === 'total_used') return false;
    return props.firstContact;
  };
  const stand = () => budgetStand(budget(), target(), room(), shown().msat, readmit());
  createEffect(() => {
    if (props.moneyBlocked) { setDoor(null); return; }
    if (room() || !doorWanted() || (mode() !== 'message' && mode() !== 'file') || stand().kind !== 'first') return;
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
  const presetChosen = () => {
    const b = budget();
    const id = presetPick() ?? b?.preset ?? 'careful';
    return b?.presets.find((p) => p.id === id) ?? b?.presets[0] ?? null;
  };
  const blocked = (): string | null => {
    if (room() && props.roomQuote && props.roomQuote.unreachable.length > 0) {
      const names = props.roomQuote.unreachable.map(props.nameOf).join(', ');
      return `Not every member is a connected peer (${names}). Your node would skip them without telling you, so this room cannot send yet.`;
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
    if (ownerExpired()) return 'Contact approval expired · get a fresh quote';
    if (!room()) {
      if (props.quoteError) return props.quoteError;
      if (!props.quote) return 'price loading…';
      if (props.quote.send_unavailable) return peerNotReadyMessage(props.quote.send_unavailable, props.name) ?? `price unavailable · ${props.quote.send_unavailable}`;
    }
    if (readmitPrice()) return Number.isSafeInteger(readmitPrice()!.total_msat) && readmitPrice()!.total_msat > 0 ? null : 'price unavailable · invalid price';
    if (room()) return props.cost ? null : 'price loading…';
    if (doorWanted() && door()) {
      const d = door()!;
      if (d.loading) return 'price loading…';
      if (!d.quote) return peerNotReadyMessage(d.error, props.name) ?? 'price unavailable · first-contact quote unavailable';
      if (!Number.isSafeInteger(d.quote.total_msat) || d.quote.total_msat <= 0) return 'price unavailable · invalid price';
      if (d.quote.expires_at * 1000 <= props.now) return 'price unavailable · first-contact quote expired';
      return null;
    }
    const q = props.quote!;
    if (q.peer_msat === null) return 'price unavailable · peer has not shared a price';
    if (!Number.isSafeInteger(q.peer_msat) || q.peer_msat < 0) return 'price unavailable · invalid peer price';
    if (q.peer_stale) return 'price unavailable · peer price is stale';
    if (!Number.isSafeInteger(q.max_routing_fee_msat) || q.max_routing_fee_msat! < 0)
      return 'price unavailable · routing fee allowance missing';
    if (!props.cost || !Number.isSafeInteger(props.cost.msat)) return 'price unavailable · invalid price';
    return null;
  };
  const paymentResult = (result: Outcome<unknown>) => {
    if (!result.ok) {
      if (['spend_unknown', 'payment_unknown', 'failed_paid', 'payment_settled_undelivered'].includes(result.error.code))
        setPaidLine('paid amount unknown · check payment result');
      return;
    }
    const receipt = result.value as SendReceipt;
    setPaidLine(paidAmount(receipt.amount_msat + (receipt.readmission_msat ?? 0), receipt.fee_paid_msat));
  };
  // Display only: the parts of the ceiling when they provably add up to it.
  const breakdown = () =>
    mode() !== 'message' || room() || doorWanted() || readmitPrice() || paidLine() || priceProblem()
      ? null
      : priceBreakdown(props.quote, messageShown().msat);
  const priceLine = () => {
    if (paidLine()) return paidLine();
    if (priceProblem()) return priceProblem();
    const cap = messageShown().msat;
    if (cap === null) return 'price loading…';
    if (readmitPrice() || (raisedFrom() !== null && cap > raisedFrom()!)) return `price went up to ${fmtAmount(cap)}, send?`;
    return `up to ${fmtAmount(cap)} · includes max routing fee`;
  };

  /** What this mode costs, shown before the button is pressed. */
  /** What one message costs here, whatever the current mode (Send in chat uses it too). */
  const messageShown = (): { msat: number | null; estimate: boolean; basis: string } => {
    const problem = priceProblem();
    if (problem) return { msat: null, estimate: false, basis: problem };
    const again = readmitPrice();
    if (again) {
      return {
        msat: again.total_msat,
        estimate: false,
        basis: `${props.name} asks for admission again: ${sats(again.admission_msat)} ${satUnit(again.admission_msat)}, then ${fmtAmount(again.message_msat)} for this message; ${feeCeiling(again.max_routing_fee_msat ?? 0)}`,
      };
    }
    const q = doorWanted() ? doorQuote() : null;
    if (q) {
      return {
        msat: q.total_msat,
        estimate: false,
        basis: `${props.name}’s own quote: ${fmtAmount(q.admission_msat)} to open their door, then ${fmtAmount(q.message_msat)} for this message; ${feeCeiling(q.max_routing_fee_msat ?? 0)}`,
      };
    }
    const c = props.cost;
    if (!c) return { msat: null, estimate: false, basis: room() ? 'Reading each member’s price…' : 'Reading their price…' };
    const basis = doorWanted()
      ? `${c.basis}. First-contact admission must fit this ceiling; otherwise nothing is paid and a new price needs your confirmation.`
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
            ? { msat: null, estimate: false, basis: 'Paste an invoice to see what it asks for' }
            : { msat: allIn(invoiceMsat()!), estimate: false, basis: `Includes ${feeCeiling(routingFee(invoiceMsat()!))}` };
        }
        return amountMsat() === null
          ? { msat: null, estimate: false, basis: 'Enter an amount' }
          : { msat: allIn(amountMsat()!), estimate: false, basis: `Includes ${feeCeiling(routingFee(amountMsat()!))}` };
      case 'request':
        return { msat: 0, estimate: false, basis: 'Receiving is free' };
      case 'file':
        return props.filePrice === null
          ? { msat: null, estimate: false, basis: 'Reading the file price…' }
          : { msat: props.filePrice.total_msat, estimate: false, basis: `File price plus ${feeCeiling(props.filePrice.max_routing_fee_msat)}` };
    }
  };

  const ready = (): boolean => {
    if (blocked()) return false;
    switch (mode()) {
      case 'message':
        return draft().trim().length > 0 && messageShown().msat !== null;
      case 'pay':
        return payKind() === 'invoice' ? invoiceMsat() !== null : pubkey().trim().length > 0 && amountMsat() !== null;
      case 'request':
        return amountMsat() !== null;
      case 'file':
        return file() !== null && props.filePrice !== null;
    }
  };

  const label = () => {
    if (paying()) return 'Paying…';
    if (ownerWait()) return 'Waiting for contact approval';
    if (needsTouch()) return 'Approve with Touch ID';
    if (viaBudget()) {
      const s = shown();
      const price = s.msat === null ? '' : ` · ${s.estimate ? '≈ ' : ''}${sats(s.msat)} ${satUnit(s.msat)}`;
      switch (stand().kind) {
        case 'paused': return 'Resume payments';
        case 'waiting': return 'Waiting for approval';
        case 'off': return 'Send';
        case 'first': return `Send first ${mode() === 'file' ? 'file' : 'message'}${price}`;
        case 'contact_used':
        case 'total_used': return 'Budget used up';
        case 'grant_limited': return 'Node grant limit';
        default: return `Send${price}`;
      }
    }
    if (spends() && !line().open) {
      if (props.spend?.state === 'pending') return 'Waiting for approval';
      if (props.spend?.state === 'unavailable') return 'Spending unavailable';
      return 'Send';
    }
    const s = shown();
    const price = s.msat === null ? '' : ` · ${s.estimate ? '≈ ' : ''}${sats(s.msat)} ${satUnit(s.msat)}`;
    return { message: 'Send', pay: 'Pay', request: 'Create invoice', file: 'Send file' }[mode()] + (mode() === 'request' ? '' : price);
  };

  const sendTitle = () => needsTouch() ? 'Approve with Touch ID' : 'Send';
  /** Pay / Request / File panels close back to the single message bar. */
  const closePanel = () => {
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
    document.addEventListener('click', onDoc);
    onCleanup(() => document.removeEventListener('click', onDoc));
  });

  /**
   * `shownMsat`: the message price the owner saw on the button they pressed
   * (Send in chat). If the price is not that any more, nothing is sent: the
   * new price shows on Send, which needs another press.
   */
  const submit = async (shownMsat?: number | null) => {
    if (props.moneyBlocked || (spends() && props.budgetStale) || busy() || ownerWait()) return;
    if (mode() === 'message' && priceProblem()) { setNote(priceProblem()); return; }
    setNote(null);
    if (shownMsat !== undefined && (mode() !== 'message' || shown().msat !== shownMsat)) {
      setNote('The message price changed since you pressed. Nothing was sent. Check the price on Send and press it to send.');
      return;
    }
    if (needsTouch()) {
      // This contact is approved with Touch ID; the draft stays where it is.
      setBusy(true);
      await props.actions.approveContact(target(), shown().msat);
      setBusy(false);
      return;
    }
    if (viaBudget()) {
      const st = stand();
      if (st.kind === 'paused' || st.kind === 'off') {
        // The one approval (or resume). The draft stays where it is.
        setBusy(true);
        if (st.kind === 'paused') await props.actions.resume();
        else if (presetChosen()) await props.actions.approveBudget(presetChosen()!.ceiling_msat, presetChosen()!.id);
        setBusy(false);
        return;
      }
      if (st.kind !== 'first' && st.kind !== 'ok') return;
      if (!ready()) {
        // A press before the price is known must not look like a send: the draft
        // stays, and the owner sees why nothing moved (real-window step 10).
        setNote(draft().trim() ? 'The message price is not ready yet. Nothing was sent. Wait for the cost, then press Send.' : 'Type a message first.');
        return;
      }
      setBusy(true);
      const submittedRevision = composerRevision;
      const submittedApprovalRevision = approvalRevision;
      const submittedPeer = target();
      const submittedTrack = props.track;
      const submittedText = draft();
      const submittedFile = file();
      const submittedMode = mode();
      const cap = shown().msat!;
      if (submittedMode === 'message') { setPaidLine(null); setRaisedFrom(null); }
      const first = st.kind === 'first' ? firstPick() ?? st.suggest : undefined;
      const dispatch = async () => {
      const r = submittedMode === 'file'
        ? await props.actions.file(submittedTrack, submittedFile!, cap, first)
        : await props.actions.send(submittedTrack, submittedText, cap, first);
      const unchanged = composerRevision === submittedRevision;
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
      if ((r.ok || paidUndelivered(r)) && composerRevision === submittedRevision) {
        if (submittedMode === 'file') {
          setFile(null);
          if (fileInput) fileInput.value = '';
        } else {
          setDraft('');
          setDrafted(false);
        }
      } else if (!r.ok && unchanged && r.error.code === 'owner_contact_expired') {
        setOwnerExpired(true);
        setNote(r.error.message);
      } else if (!r.ok && unchanged && (isBudgetStop(r.error) || ['owner_only', 'owner_contact_unavailable'].includes(r.error.code))) setNote(r.error.message);
      };
      if (first !== undefined && !room()) {
        const request = await props.actions.ownerRequest(submittedPeer, cap, first);
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
          setOwnerWait({ approval: request.value, revision: submittedRevision, send: dispatch });
          setBusy(false);
          return;
        }
      }
      await dispatch();
      setBusy(false);
      return;
    }
    if (spends() && !line().open) {
      // The one tap: the draft stays where it is. With this Mac registered,
      // a single contact is approved with Touch ID; otherwise at the node.
      setBusy(true);
      await props.actions.approve();
      setBusy(false);
      return;
    }
    if (!ready()) {
      setNote(
        mode() === 'message' && draft().trim()
          ? 'The message price is not ready yet. Nothing was sent. Wait for the cost, then press Send.'
          : 'Nothing was sent yet — finish the fields first.',
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
        r = await props.actions.send(t, draft(), cap);
        if (unchanged()) {
          paymentResult(r);
          if (!r.ok && ['price_changed', 'price_cap_exceeded'].includes(r.error.code)) { setRaisedFrom(cap); setReadmitQuote(null); }
        }
        if (r.ok && readmitQuote()?.peer === peer) setReadmitQuote(null);
        if (!r.ok && r.error.code === 'readmission_quoted' && r.error.admission) setReadmitQuote({ peer, price: r.error.admission });
        if ((r.ok || paidUndelivered(r)) && unchanged()) {
          setDraft('');
          setDrafted(false);
        } else if (!r.ok && unchanged() && isBudgetStop(r.error)) setNote(r.error.message);
        break;
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
        if (r.ok && unchanged()) {
          setFile(null);
          if (fileInput) fileInput.value = '';
        } else if (!r.ok && unchanged() && isBudgetStop(r.error)) setNote(r.error.message);
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
    if (!inv || props.moneyBlocked || busy() || ownerWait()) return;
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
    props.moneyBlocked || (spends() && !!props.budgetStale) || busy() || !!ownerWait() || (mode() === 'message' && priceProblem() !== null) ||
    // Touch ID approves the contact, not the draft: no draft needed yet.
    (needsTouch() ? false : viaBudget()
      ? ['waiting', 'contact_used', 'total_used', 'grant_limited', 'unknown'].includes(stand().kind) || ((stand().kind === 'first' || stand().kind === 'ok') && !ready())
      : spends() && !line().open
      ? props.spend?.state === 'pending' || props.spend?.state === 'unavailable' || props.spend === null
      : !ready());

  return (
    <form
      class="composer"
      data-composer
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
          composerRevision++;
          setFile(e.currentTarget.files?.[0] ?? null);
        }}
        aria-label="File to send"
      />

      <Switch>
        <Match when={mode() === 'file'}>
          <div class="composer-panel file-panel" data-composer-panel="file">
            <div class="panel-head">
              <strong>Send a file</strong>
              <button type="button" class="link" data-composer-close aria-label="Close" onClick={closePanel}>✕</button>
            </div>
            <div class="composer-main">
              <button
                type="button"
                class="attach soft icon-btn"
                data-file-choose
                aria-label="Choose a file"
                title="Choose a file"
                onClick={() => fileInput?.click()}
              >
                +
              </button>
              <div class="file-chip" data-file-chip>
                <Show when={file()} fallback={<span class="hint">{recording() ? `Recording… up to ${duration(recording()?.rec.limitMs ?? VOICE_MAX_MS)}` : `Choose a file for ${props.name}`}</span>}>
                  {(f) => (
                    <Show when={voicePreview()} fallback={<span class="file-name">{f().name}</span>}>
                      <audio controls src={voicePreview()!} data-voice-preview aria-label="Voice note preview" />
                    </Show>
                  )}
                </Show>
                <button type="button" class="link" onClick={closePanel}>
                  Remove
                </button>
                <span class="hint">Up to 1.4 MB · pays like a message</span>
              </div>
              <button type="submit" class="primary soft money" disabled={disabled()} data-send>
                {label()}
              </button>
            </div>
          </div>
        </Match>
        <Match when={mode() === 'pay'}>
          <div class="fields pay-flow composer-panel" data-composer-panel="pay">
            <div class="panel-head">
              <strong>Pay {props.name}</strong>
              <button type="button" class="link" data-composer-close aria-label="Done" onClick={closePanel}>Done</button>
            </div>
            <div class="modes soft small" role="tablist" aria-label="How to pay">
              <button type="button" role="tab" aria-selected={payKind() === 'invoice'} onClick={() => { if (payKind() === 'invoice') return; composerRevision++; setPayKind('invoice'); }}>Invoice</button>
              <button type="button" role="tab" aria-selected={payKind() === 'keysend'} onClick={() => { if (payKind() === 'keysend') return; composerRevision++; setPayKind('keysend'); }}>Direct</button>
            </div>
            <Show
              when={payKind() === 'invoice'}
              fallback={
                <>
                  <AmountField data="pay" label="Amount to pay" value={amount()} onInput={setAmount} />
                  <input data-pay-pubkey placeholder="Their Lightning node ID" value={pubkey()} onInput={(e) => setPubkey(e.currentTarget.value)} aria-label="Lightning node pubkey" />
                  <input data-pay-note placeholder="Note (optional)" value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label="Note" />
                </>
              }
            >
              <div class="amount-field shown" data-pay-invoice-amount={invoiceMsat() ?? ''}>
                <span class="amount-value">{invoiceMsat() === null ? '0' : sats(invoiceMsat()!)}</span>
                <span class="amount-unit">{invoiceMsat() === null ? unitName() : satUnit(invoiceMsat()!)}</span>
              </div>
              <textarea data-pay-invoice rows={2} placeholder={`Paste an invoice from ${props.name}`} value={bolt11()} onInput={(e) => setBolt11(e.currentTarget.value)} aria-label="Lightning invoice" />
            </Show>
            <Show
              when={review()}
              fallback={
                <div class="composer-bar">
                  <div class="cost" data-cost>
                    <span class="label">Cost to send</span>
                    <Show when={shown().msat !== null} fallback={<span class="sats">…</span>}>
                      <span class="sats" data-cost-msat={shown().msat!}>
                        {sats(shown().msat!)}
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
                        <p class="pay-review-title">Pay a Lightning node directly</p>
                        <PayeeLine payee={(rv() as { pubkey: string }).pubkey.toLowerCase()} peer={target()} name={props.name} />
                      </>
                    }
                  >
                    {/* Whoever sent or pasted the invoice need not be who it pays. */}
                    <p class="pay-review-title">Pay this Lightning invoice</p>
                    <PayeeLine payee={(rv() as { payee: string }).payee} peer={target()} name={props.name} />
                  </Show>
                  <dl>
                    <dt>Amount</dt>
                    <dd data-review-amount>{fmtAmount(rv().msat)}</dd>
                    <dt>Network fee</dt>
                    <dd data-review-fee>up to {fmtAmount(routingFee(rv().msat))}</dd>
                    <dt>Total at most</dt>
                    <dd data-review-total>{fmtAmount(allIn(rv().msat))}</dd>
                    <Show when={rv().kind === 'keysend' && (rv() as { memo: string }).memo.trim()}>
                      <dt>Note</dt>
                      <dd>{(rv() as { memo: string }).memo.trim()}</dd>
                    </Show>
                  </dl>
                  <div class="composer-bar">
                    <button type="button" class="link" data-pay-back disabled={busy()} onClick={() => setReview(null)}>Back</button>
                    <span class="basis">You pay the real fee, never above this.</span>
                    <button type="button" class="primary soft money" data-pay-confirm disabled={busy() || props.moneyBlocked} onClick={() => void confirmPay()}>
                      Confirm and pay
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
              <strong>Request from {props.name}</strong>
              <button type="button" class="link" data-composer-close aria-label="Done" onClick={closePanel}>Done</button>
            </div>
            <AmountField data="request" label="Amount to request" value={amount()} onInput={setAmount} />
            <input data-request-note placeholder="What for? e.g. dinner" value={memo()} onInput={(e) => setMemo(e.currentTarget.value)} aria-label="What it is for" />
            <div class="composer-bar">
              <div class="cost" data-cost>
                <span class="basis" data-request-hint>Makes an invoice and QR here. Send it in chat so {props.name} can pay it. Receiving is free.</span>
              </div>
              <button type="submit" class="primary soft money" disabled={disabled()} data-send>
                {label()}
              </button>
            </div>
            <Show when={created()}>
              {(inv) => (
                <div class="composer-bar" data-request-created>
                  <span class="basis">
                    Invoice for {fmtAmount(inv().amount_msat)} is ready. Send it to {props.name} as a chat message; it pays like any message.
                  </span>
                  <button type="button" class="primary soft money" data-send-in-chat disabled={props.moneyBlocked || busy() || !!ownerWait()} onClick={() => void sendInChat()}>
                    Send in chat{chatPrice()}
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>

      {/* Above the capsule: the terms read before Send, which is the Touch ID tap. */}
      <Show when={needsTouch()}>
        <TouchApproval peer={target()} name={props.name} priceMsat={shown().msat} actions={props.actions} />
      </Show>
      <div class="composer-main signal-bar" data-composer-bar>
        <button
          type="button"
          class="attach soft icon-btn"
          data-emoji
          aria-label="Emoji"
          aria-expanded={emojiOpen()}
          title="Emoji"
          disabled={mode() !== 'message'}
          onClick={() => setEmojiOpen((v) => !v)}
        >
          🙂
        </button>
        <textarea
          ref={(el) => { draftInput = el; }}
          rows={1}
          placeholder={`Message ${props.name}`}
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
          aria-label={`Message ${props.name}`}
        />
        <Show when={!room()}>
          <button
            type="button"
            class="attach soft icon-btn voice-record"
            classList={{ recording: recording() !== null }}
            data-voice-record={recording() ? 'stop' : 'start'}
            aria-label={recording() ? 'Stop recording' : 'Record a voice note'}
            title={recording() ? 'Stop recording' : `Record a voice note (up to ${duration(VOICE_MAX_MS)})`}
            disabled={starting() || busy()}
            onClick={() => void (recording() ? stopRecording() : startVoice())}
          >
            {recording() ? `■ ${duration(recordedMs())}` : '🎙'}
          </button>
          <div class="composer-plus-wrap">
            <button
              type="button"
              class="attach soft icon-btn"
              data-composer-plus
              aria-label="More: attach, pay, request"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              title="Attach, pay or request"
              onClick={() => setMenuOpen((v) => !v)}
            >
              +
            </button>
            <div class="composer-menu" data-composer-menu role="menu" hidden={!menuOpen()}>
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
                      if (m === 'file') fileInput?.click();
                      // Reselecting the active mode is not an edit: it must not
                      // detach an in-flight send from the draft it will clear.
                      if (mode() === m) return;
                      composerRevision++;
                      setMode(m);
                      setNote(null);
                    }}
                  >
                    {{ message: 'Message', pay: 'Pay', request: 'Request', file: 'Attach' }[m]}
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
            onClick={(e) => { if (e.detail > 1) e.preventDefault(); }}
            title={sendTitle()}
            aria-label={sendTitle()}
          >
            {sendTitle()}
          </button>
        </Show>
      </div>
      <div class="composer-meta">
      <Show when={mode() === 'message'}>
        <div class="send-price" classList={{ priced: !priceProblem() && (paidLine() !== null || messageShown().msat !== null) }}>
          <span data-send-price aria-live="polite">{priceLine()}</span>
          <Show when={priceProblem() && priceProblem() !== 'price loading…'}>
            {' '}<button type="button" class="link" data-price-retry disabled={busy()} onClick={() => {
              if (doorWanted() && door()) setDoor(null);
              props.refreshPrice();
            }}>Retry</button>
          </Show>
        </div>
      </Show>
      <details class="composer-info" data-composer-info>
        <summary aria-label="Cost and rules" title="Cost and rules"><span aria-hidden="true">ⓘ</span></summary>
        <Show when={breakdown()}>
          {(b) => (
            <>
              <dl class="price-breakdown" data-price-breakdown>
                <dt>{props.name}’s price</dt>
                <dd>{fmtAmount(b().priceMsat)}</dd>
                <dt>Routing fee, at most</dt>
                <dd>{fmtAmount(b().routingMsat)}</dd>
                <dt class="total">You pay at most</dt>
                <dd class="total">{fmtAmount(b().ceilingMsat)}</dd>
              </dl>
              <p class="hint price-note">
                A ceiling, not a charge: the amount actually paid shows under the message.
                <Show when={b().routingMsat >= b().priceMsat}> Routing can cost more than the message itself.</Show>
              </p>
            </>
          )}
        </Show>
        <Show when={mode() === 'message' || mode() === 'file'}>
          <div class="composer-bar cost-only">
            <div class="cost" data-cost>
              <span class="label">Cost to send</span>
              <Show when={shown().msat !== null} fallback={<span class="sats">…</span>}>
                <span class="sats" data-cost-msat={shown().msat!}>
                  {shown().estimate ? '≈ ' : ''}
                  {sats(shown().msat!)}
                  <span class="unit">{satUnit(shown().msat!)}</span>
                </span>
              </Show>
              <span class="basis" title={shown().basis}>{shown().basis}</span>
            </div>
          </div>
        </Show>
        <Show when={mode() === 'pay'}>
          <p data-budget-payment><strong>Payment rules.</strong> App invoice payments and keysend reserve principal plus the network fee ceiling against the app daily all-in limit; any finite node grant still applies.</p>
        </Show>
        <Show when={mode() === 'file'}>
          <p data-budget-file><strong>File spend rules.</strong> Files reserve principal plus the network fee ceiling against the same app all-in limit and contact budget, including during the ten-minute window.</p>
        </Show>
      </details>
      </div>
      <Show when={emojiOpen()}>
        <div class="emoji-picker" data-emoji-picker role="listbox" aria-label="Emoji">
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

      <Show when={mode() === 'message' && readmitPrice()}>
        {(p) => (
          <>
            <p class="hint" data-readmission-quote>
              {props.name} asks for admission again, {sats(p().admission_msat)} {satUnit(p().admission_msat)}. Nothing was paid. Send again: {sats(p().total_msat)} {satUnit(p().total_msat)} in all.
            </p>
            <details class="quiet-detail" data-readmission-detail>
              <summary>Details</summary>
              <p>The same message keeps its operation, so it is never paid twice.</p>
            </details>
          </>
        )}
      </Show>
      <Show when={drafted()}>
        <p class="drafted" data-drafted>
          Drafted in the AI track. Check it and the cost, then {mode() === 'request' ? 'create the invoice' : 'send it'} yourself.
        </p>
      </Show>
      <Show when={blocked()}>
        <p class="err-note" data-room-blocked>{blocked()}</p>
      </Show>
      <Show when={note() && note() !== MONEY_NOT_READY}>
        <p class="err-note" data-composer-note>{note()}</p>
      </Show>
      <Show when={ownerExpired()}>
        <button type="button" class="link" data-contact-requote onClick={() => {
          setDoor(null);
          setOwnerExpired(false);
          setNote(null);
          props.refreshPrice();
        }}>Get a fresh quote</button>
      </Show>
      <Show when={ownerWait()}>
        {(pending) => <div class="approval" data-contact-approval="pending" data-contact-request={JSON.stringify(pending().approval.request)}>
          <p><strong>Approve this contact at your node.</strong> Run this command once in the owner’s terminal from the node’s data directory, with owner control enabled. The app never receives an owner credential.</p>
          <p>The command approves this contact’s budget and first-message cap. This draft sends after approval. Editing it or pressing Cancel stops the wait.</p>
          <Show when={pending().approval.approval_window_secs !== undefined}>
            <p role="status" data-contact-countdown>Waiting for remote approval · {Math.floor(ownerCountdown() / 60)}:{String(ownerCountdown() % 60).padStart(2, '0')} remaining</p>
          </Show>
          <textarea readonly aria-label="Owner approval command" data-contact-owner-command data-command={pending().approval.owner_command} value={pending().approval.owner_command} />
          <button type="button" class="link" onClick={async () => { try { await navigator.clipboard.writeText(pending().approval.owner_command); } catch { setNote('Select and copy the command above.'); } }}>Copy command</button>
          <button type="button" class="link" data-contact-cancel onClick={cancelOwner}>Cancel</button>
          <p class="hint">Cancel does not revoke an approval already issued at the node; it expires within {pending().approval.approval_window_secs !== undefined ? 'five' : 'two'} minutes.</p>
        </div>}
      </Show>
      <Show when={spends()}>
        <Show when={!props.budgetStale} fallback={<p class="spend-line" data-budget-stale>Spend grant stale — checking your node. Auto-pay unavailable until confirmed.</p>}>
          <Show
            when={viaBudget()}
            fallback={<SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} hasPending={props.hasPending} />}
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
              preset={presetChosen()}
              onPreset={(id) => { setPresetPick(id); saveSpendPreset(props.ownId, id); }}
              firstPick={firstPick()}
              onFirstPick={setFirstPick}
              error={props.budgetError}
              now={props.now}
              actions={props.actions}
              hasPending={props.hasPending}
            />
          </Show>
        </Show>
      </Show>
    </form>
  );
}

/**
 * The owner's spend window. One tap opens it for ten minutes; it can only
 * narrow what the node allows, never widen it.
 */
function SpendBar(props: { spend: SpendView | null; error: string | undefined; now: number; actions: Actions; hasPending?: boolean }) {
  const line = () => spendLine(props.spend, props.now);
  const minutes = (ms: number) => Math.max(1, Math.ceil((ms - props.now) / 60_000));
  // One Ask again at a time: a double click must not print two requests at the node.
  const [asking, setAsking] = createSignal(false);
  const askAgain = async () => {
    if (asking()) return;
    setAsking(true);
    try {
      await props.actions.approve();
    } finally {
      setAsking(false);
    }
  };
  return (
    <div class="spend" data-spend={props.spend?.state ?? 'unknown'}>
      <Switch>
        <Match when={props.spend?.state === 'open' && line().open}>
          <details class="quiet-detail passive-status" data-spend-status>
            <summary aria-label="Spending status" title="Spending status">ⓘ</summary>
            <p class="spend-line">
              <span class="dot ok" /> {line().text}.{' '}
              <button type="button" class="link" data-spend-lock onClick={() => void props.actions.lock()}>Lock now</button>
            </p>
            <details class="quiet-detail" data-spend-detail>
              <summary>Details</summary>
              <p>
                {props.spend?.basis === 'app_lock'
                  ? 'This node version does not limit app tokens, so this window is the app’s own lock, kept in memory only.'
                  : 'Your node’s owner grant is in effect; this app uses it for ten minutes per approval.'}
              </p>
            </details>
          </details>
        </Match>
        <Match when={props.spend?.state === 'pending' && props.spend.pending}>
          {(p) => (
            <div class="approval" data-approval="pending">
              <p>
                <strong>Confirm at your node.</strong> Your node asks its owner to approve this app spending. Run this on
                the node's computer. It shows the terms and asks for the short code your node's terminal shows:
              </p>
              <code class="address" data-owner-action>{p().owner_action}</code>
              <p class="hint">
                This app cannot approve it for you. The request lapses in {minutes(p().expires_at_ms)} min. Your draft is kept.{' '}
                <button type="button" class="link" data-spend-cancel onClick={() => void props.actions.cancelSpend()}>
                  Cancel request
                </button>
              </p>
            </div>
          )}
        </Match>
        <Match when={props.spend?.state === 'unavailable' && props.spend.pending}>
          {(p) => (
            <div class="approval" data-approval="unavailable">
              <p>
                <strong>This node cannot grant spending to the app.</strong> Receiving still works. Your node says:
              </p>
              <code class="address" data-owner-action>{p().owner_action}</code>
            </div>
          )}
        </Match>
        <Match when={props.spend?.state === 'expired' && props.spend.lapse}>
          {(lapse) => (
            <p class="spend-line" data-spend-lapse={lapse()}>
              <span class="dot" />{' '}
              {lapse() === 'lost'
                ? 'Your node can no longer approve that request (for example, it restarted).'
                : 'That request lapsed before it was approved.'}{' '}
              <button type="button" class="link" data-spend-ask-again disabled={asking()} onClick={() => void askAgain()}>
                Ask again
              </button>
            </p>
          )}
        </Match>
        <Match when={true}>
          <p class="spend-line">
            <span class="dot" /> {line().text}.{' '}
            {props.spend?.state === 'expired'
              ? 'Approve again to keep sending.'
              : 'Sending spends sats from your node. One approval covers the next ten minutes and is never saved.'}
          </p>
        </Match>
      </Switch>
      <DeviceSetup device={props.actions.device()} now={props.now} actions={props.actions} />
      <Reconcile actions={props.actions} hasPending={props.hasPending} />
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
  const [busy, setBusy] = createSignal(false);
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const minutes = (ms: number) => Math.max(1, Math.ceil((ms - props.now) / 60_000));
  return (
    <Switch>
      <Match when={props.device?.state === 'off' && props.device}>
        {(d) => (
          <p class="hint" data-device-off={d().off_reason ?? 'off'}>
            <strong>Touch ID approvals are off.</strong> {d().off_message}
          </p>
        )}
      </Match>
      <Match when={props.device?.state === 'none' || props.device?.state === 'lapsed'}>
        <p class="hint" data-device-setup={props.device?.state}>
          {props.device?.state === 'lapsed' ? 'Your last Touch ID setup request lapsed. ' : ''}
          Approve payments per contact with Touch ID on this Mac instead of at the node.{' '}
          <button type="button" class="link" data-device-register disabled={busy()} onClick={() => void run(props.actions.registerDevice)}>
            Set up Touch ID approvals
          </button>
        </p>
      </Match>
      <Match when={props.device?.state === 'pending' && props.device}>
        {(d) => (
          <div class="approval" data-device="pending">
            <p>
              <strong>Approve this Mac once at your node.</strong> Run this on the node’s computer. It shows this Mac’s key
              fingerprint <code data-device-fingerprint>{d().fingerprint}</code>; check that it matches, then type the short
              code your node’s terminal shows:
            </p>
            <code class="address" data-device-owner-action>{d().owner_action}</code>
            <p class="hint">
              This app cannot approve it for you.
              {d().expires_at_ms ? ` The request lapses in ${minutes(d().expires_at_ms!)} min.` : ''}{' '}
              <button type="button" class="link" data-device-cancel disabled={busy()} onClick={() => void run(props.actions.cancelDevice)}>
                Cancel
              </button>
            </p>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/**
 * One contact's envelope, approved with Touch ID: a slim line above the
 * composer. The terms and the contact's id show here before the tap, and the
 * system dialog repeats them. Send in the composer is the tap.
 */
export function TouchApproval(props: { peer: string; name: string; priceMsat: number | null; actions: Actions }) {
  const perAct = () => envelopePerAct(props.priceMsat);
  return (
    <div class="spend touch-line" data-touch-approval>
      <p class="spend-line">
        <span class="dot" />{' '}
        <span class="line-text">
          {/* The petname is local; Touch ID names the same key, never a name. */}
          <strong>Approve {props.name} (node <code data-touch-peer>{shortId(props.peer)}</code>) with Touch ID.</strong> Up
          to <span data-touch-budget>{fmtAmount(ENVELOPE_BUDGET_MSAT)}</span> a day, at most{' '}
          <span data-touch-per-act>{fmtAmount(perAct())}</span> per message, for 24 hours.
        </span>
      </p>
      <details class="quiet-detail" data-touch-detail>
        <summary>Details</summary>
        <p>
          Touch ID shows the same amounts for node {shortId(props.peer)}. Your node checks every payment against them;
          nothing else can be paid under this approval.
        </p>
      </details>
    </div>
  );
}

/** Read-only: match an unknown outcome to the node's own records. Never re-sends. */
function Reconcile(props: { actions: Actions; hasPending?: boolean }) {
  const [result, setResult] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(false);
  // Paid, not delivered: the owner may stop retrying (it dispatches nothing).
  // The record the check showed: Stop retrying names it, never whatever is pending later.
  const [undelivered, setUndelivered] = createSignal<string | null>(null);
  createEffect(on(props.actions.pendingRevision, () => {
    setUndelivered(null);
    setResult(null);
  }, { defer: true }));
  const reconcile = async () => {
    if (checking()) return;
    setChecking(true);
    const revision = props.actions.pendingRevision();
    const outcome = await props.actions.reconcile();
    if (revision !== props.actions.pendingRevision()) { setChecking(false); return; }
    setResult(outcome.ok ? outcome.value : outcome.error.message);
    setUndelivered(!outcome.ok && outcome.error.code === 'undelivered_pending' ? outcome.error.pending_id ?? null : null);
    setChecking(false);
  };
  const stop = async () => {
    if (checking()) return;
    setChecking(true);
    const outcome = await props.actions.stopRetrying(null, undelivered());
    setResult(outcome.ok ? outcome.value : outcome.error.message);
    setUndelivered(null);
    setChecking(false);
  };
  return (
    <>
      <button type="button" class="link" data-spend-reconcile disabled={checking()} onClick={() => void reconcile()}>
        Check pending result
      </button>
      <Show when={undelivered()}>
        <button type="button" class="link" data-stop-retrying disabled={checking()} onClick={() => void stop()}>
          Stop retrying
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
  return min < 60 ? `${min} min` : `${Math.ceil(min / 60)} h`;
};

const PRESET_NAME: Record<PresetId, string> = { careful: 'Careful', everyday: 'Everyday', generous: 'Generous' };

/**
 * Invisible payments (B2). Inside the owner's budget a message just goes: no
 * prompt, the price still shown, and the node still enforces each message's cap.
 * The bar says where the budget stands and is the only place that asks.
 */
function BudgetBar(props: {
  stand: BudgetStandT;
  budget: BudgetView;
  spend: SpendView | null;
  name: string;
  room: boolean;
  target: string;
  priceMsat: number | null;
  /** A stranger's signed quote, on a first paid message. */
  door: FirstContactQuote | null;
  preset: BudgetPreset | null;
  onPreset: (id: PresetId) => void;
  firstPick: number | null;
  onFirstPick: (msat: number) => void;
  error: string | undefined;
  now: number;
  actions: Actions;
  hasPending?: boolean;
}) {
  const worth = (msat: number) => messagesWorth(msat, props.priceMsat);
  const who = () => (props.room ? 'this room' : props.name);
  const firstOptions = (suggest: number, ceiling: number) =>
    [...new Set([suggest, suggest * 2, suggest * 5].map((v) => Math.min(v, ceiling)))].filter((v) => v >= (props.priceMsat ?? 0));
  return (
    <div class="spend budget" data-budget={props.stand.kind}>
      <Switch>
        <Match when={props.stand.kind === 'paused'}>
          <p class="spend-line" data-budget-paused>
            <span class="dot warn" /> <span class="line-text">Payments are paused. New app payments are blocked. In-flight payments, owner commands and background workers can still spend.</span>
          </p>
        </Match>
        <Match when={props.stand.kind === 'waiting'}>
          <div class="approval" data-approval="pending">
            <p>
              <strong>Confirm at your node.</strong> One approval lets messages pay for the next 24 hours, up to your app all-in payment limit.
              Run this on the node's computer. It shows the terms and asks for the short code your node's terminal shows:
            </p>
            <Show when={props.spend?.pending}>
              {(p) => <code class="address" data-owner-action>{p().owner_action}</code>}
            </Show>
            <p class="hint">This app cannot approve it for you. Your draft is kept.</p>
          </div>
        </Match>
        <Match when={props.stand.kind === 'off'}>
          <Show when={props.room || props.actions.device()?.state !== 'registered'}>
            <div class="approval slim-approval budget-setup" data-budget-setup>
              <span class="slim-label">
                <strong>Approval needed.</strong> {props.budget.autopay.state === 'expired' ? 'Your daily approval ended.' : 'Let messages pay as you chat.'} (Someone new always asks first)
              </span>
              <Show when={props.spend?.lapse}>
                {(lapse) => (
                  <p class="hint" data-budget-lapse={lapse()}>
                    {lapse() === 'lost'
                      ? 'Your node can no longer approve your last request (for example, it restarted). Approve again to ask again.'
                      : 'Your last request lapsed before it was approved. Approve again to ask again.'}
                  </p>
                )}
              </Show>
              <div class="presets" role="radiogroup" aria-label="App all-in payments limit, rolling 24 hours">
                <For each={props.budget.presets}>
                  {(p) => (
                    <button
                      type="button"
                      class="chip"
                      role="radio"
                      aria-checked={props.preset?.id === p.id}
                      data-preset={p.id}
                      onClick={() => props.onPreset(p.id)}
                    >
                      {PRESET_NAME[p.id]} · {fmtAmount(p.ceiling_msat)} a day
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Match>
        <Match when={props.stand.kind === 'first' && (props.stand as Extract<BudgetStandT, { kind: 'first' }>)}>
          {(st) => (
            <div class="approval budget-first" data-first-contact>
              <Show when={st().again ? props.door : null}>
                {(q) => (
                  <p class="door-quote" data-door-quote={q().total_msat} data-readmit>
                    {who()} reconnected and asks to be admitted again: <strong>{fmtAmount(q().admission_msat)}</strong>, then{' '}
                    <strong>{fmtAmount(q().message_msat)}</strong> for this message, <strong>{fmtAmount(q().total_msat)}</strong> in
                    all, including {feeCeiling(q().max_routing_fee_msat ?? 0)}. Nothing is paid until you send.
                  </p>
                )}
              </Show>
              <Show when={st().again ? null : props.door}>
                {(q) => (
                  <p class="door-quote" data-door-quote={q().total_msat}>
                    {who()}’s door: <strong>{fmtAmount(q().admission_msat)}</strong> once to reach them, then{' '}
                    <strong>{fmtAmount(q().message_msat)}</strong> a message. This first message costs{' '}
                    <strong>{fmtAmount(q().total_msat)}</strong> in all, including {feeCeiling(q().max_routing_fee_msat ?? 0)}. Nothing is paid until you send.
                  </p>
                )}
              </Show>
              <Show
                when={st().again}
                fallback={
                  <p>
                    <strong>First paid message to {who()}.</strong> Asked once. After it, messages to {who()} pay automatically, up to:
                  </p>
                }
              >
                <p>
                  <strong>Admit {who()} again.</strong> Asked once. After it, your node pays a reconnect to {who()} from their
                  budget without asking, up to:
                </p>
              </Show>
              <div class="presets" role="radiogroup" aria-label={`Daily budget for ${who()}`}>
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
                      {fmtAmount(msat)} a day<Show when={worth(msat)}> · {worth(msat)}</Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </Match>
        <Match when={props.stand.kind === 'grant_limited'}>
          <p class="spend-line" data-node-grant-limit>Your node’s spend grant cannot cover this payment. It has {fmtAmount(props.budget.node_grant?.remaining_msat ?? 0)} left and allows at most {fmtAmount(props.budget.node_grant?.per_call_max_msat ?? 0)} per payment. Ask your node’s owner for a new grant.</p>
        </Match>
        <Match when={props.stand.kind === 'contact_used' && (props.stand as Extract<BudgetStandT, { kind: 'contact_used' }>)}>
          {(st) => (
            <div class="approval budget-used" data-budget-used="contact">
              <p>
                <strong>Budget for {who()} used up.</strong> {fmtAmount(st().spent)} of {fmtAmount(st().limit)} in the last 24 hours, and this
                message costs {props.priceMsat === null ? '…' : fmtAmount(props.priceMsat)}.
                <Show when={budgetNote(props.budget.rows.find(r => r.target === props.target && r.room === props.room))}>{note => <> {note()}.</>}</Show>
                {' '}It frees up as older payments pass 24 hours.
              </p>
              <Show
                when={st().raiseTo}
                fallback={
                  <p class="hint">
                    This budget already equals your app all-in limit.{' '}
                    <button type="button" class="link" data-budget-raise-total onClick={() => void props.actions.approveBudget(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat), props.budget.preset)}>
                      Raise the app all-in limit to {fmtAmount(Math.min(props.budget.ceiling_msat * 2, props.budget.max_daily_msat))}
                    </button>
                  </p>
                }
              >
                {(to) => (
                  <button type="button" class="primary small money" data-budget-raise onClick={() => void props.actions.setBudget(props.target, props.room, to())}>
                    Raise to {fmtAmount(to())} a day
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
                <strong>Your app all-in limit is used up.</strong> {fmtAmount(st().spent)} of {fmtAmount(st().ceiling)} in the last 24 hours. Raising
                it is a new approval. {budgetNote(props.budget)}
              </p>
              <Show when={st().raiseTo}>
                {(to) => (
                  <button type="button" class="primary small money" data-budget-raise-total onClick={() => void props.actions.approveBudget(to(), props.budget.preset)}>
                    Approve {fmtAmount(to())} a day
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
                  Pays automatically · {fmtAmount(st().spent)} of {fmtAmount(st().limit)} to {who()} in 24 h
                  <Show when={budgetNote(props.budget.rows.find(r => r.target === props.target && r.room === props.room))}>{note => <> · {note()}</>}</Show>
                  {' '}· approval ends in{' '}
                  {hoursLeft(props.budget.autopay.open_until_ms, props.now, props.budget.window_ms)} h ·{' '}
                  <button type="button" class="link" data-pause-all onClick={() => void props.actions.pauseAll()}>Pause app payments</button>
                </span>
              </p>
            </div>
          )}
        </Match>
      </Switch>
      <Reconcile actions={props.actions} hasPending={props.hasPending} />
      <Show when={props.error}>
        <p class="err-note" data-budget-error>{props.error}</p>
      </Show>
    </div>
  );
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
  const [value, setValue] = createSignal('');
  const [note, setNote] = createSignal<string | null>(null);
  const pct = (spent: number, of: number) => `${Math.min(100, of > 0 ? (spent / of) * 100 : 0).toFixed(1)}%`;
  const save = async (row: BudgetRow) => {
    const n = Number(value());
    if (!Number.isFinite(n) || n < 0) return setNote('Enter a number of sats, or 0 to forget.');
    const r = await props.actions.setBudget(row.target, row.room, Math.round(n * 1000));
    if (r.ok) {
      setEditing(null);
      setNote(null);
    } else setNote(r.error.message);
  };
  const directPaymentName = (target: string) => target === 'app:invoice-payments' ? 'Invoice payments'
    : target === 'app:keysend-payments' ? 'Keysend payments' : null;
  const status = (b: BudgetView) => {
    if (b.paused) return 'Paused · new app payments blocked';
    if (b.waiting_for_owner) return 'Waiting for node approval';
    if (b.autopay.state === 'open') return `Autopay open · ${hoursLeft(b.autopay.open_until_ms, props.now, b.window_ms)} h left`;
    if (b.autopay.state === 'expired') return 'Daily approval ended';
    return 'Not approved this session';
  };
  const statusDetail = (b: BudgetView) => {
    if (b.paused) return 'In-flight payments and spending outside this app can continue.';
    if (b.waiting_for_owner) return 'Confirm the pending approval at your node.';
    if (b.autopay.state === 'open') return 'Messages and files pay inside this all-in limit until it ends.';
    if (b.autopay.state === 'expired') return 'Approve again from any conversation.';
    return 'Approve an app all-in limit from any conversation.';
  };
  return (
    <div class="panel" data-panel="budget">
      <h2>App payment budget</h2>
      <details class="quiet-detail hint" data-budget-scope>
        <summary><strong>App all-in · rolling 24 h</strong> — what it covers</summary>
        <p>
          Covers automatic and manual-window messages, room sends, files, app invoice payments and keysend, and admission, including their maximum network fees. Paid totals use reported principal and fees. In-flight ceilings are reserved separately; unreported fees remain unknown.
          Not covered: channel opening/closing, on-chain transfers and fees, owner-direct CLI/API, or background workers.
          G1 is a separate finite node grant; it does not refill daily. Not a wallet-wide limit.
        </p>
      </details>
      <Show when={props.budget} fallback={<Show when={!props.error} fallback={<p class="err-note">{props.error}</p>}><DelayedSpinner /></Show>}>
        {(b) => (
          <>
            <div class="tally" data-tally>
              <span class="label">Known paid in the last 24 hours</span>
              <span class="sats big" data-tally-total>
                {fmtAmount(b().spent_msat)} <span class="unit">/ {fmtAmount(b().ceiling_msat)}</span>
              </span>
              <span class="meter" aria-hidden="true"><span style={{ width: pct(b().spent_msat, b().ceiling_msat) }} /></span>
              <Show when={b().unsettled_msat > 0}>
                <span class="hint" data-unsettled>{fmtAmount(b().unsettled_msat)} reserved at send ceilings; outcome not known yet.</span>
              </Show>
              <Show when={b().fee_unknown}>
                <span class="hint" data-fee-unknown>{budgetNote({ ...b(), unsettled_msat: 0, accounted_msat: (b().accounted_msat ?? b().spent_msat) - b().unsettled_msat })}</span>
              </Show>
              <Show when={b().node_grant}>
                {(g) => (
                  <span class="hint" data-node-grant>
                    Your finite node grant allows {fmtAmount(g().remaining_msat)} of {fmtAmount(g().budget_msat)} more, at most {fmtAmount(g().per_call_max_msat)} per payment, for {timeLeft(g().expires_at_ms, props.now)}.
                  </span>
                )}
              </Show>
            </div>
            <p class="spend-line" classList={{ paused: b().paused }} data-autopay={b().paused ? 'paused' : b().autopay.state}>
              <span class={`dot ${b().paused ? 'warn' : b().autopay.state === 'open' ? 'ok' : ''}`} /> <span class="line-text">{status(b())}</span>
            </p>
            <details class="quiet-detail" data-budget-status-detail>
              <summary>Details</summary>
              <p>{statusDetail(b())}</p>
            </details>
            <Show
              when={b().paused}
              fallback={
                <button type="button" class="pause-all" data-pause-all onClick={() => void props.actions.pauseAll()}>
                  Pause app payments
                </button>
              }
            >
              <button type="button" class="primary money" data-resume onClick={() => void props.actions.resume()}>
                Resume payments
              </button>
            </Show>
            <h3>By action, contact and room</h3>
            <For each={b().rows} fallback={<p class="hint">No one has a budget yet. Your first paid message to someone sets theirs.</p>}>
              {(row) => {
                const key = () => `${row.room ? 'room' : 'peer'}:${row.target}`;
                return (
                  <div class="budget-row" data-budget-row={row.target}>
                    <div class="row" style={{ 'justify-content': 'space-between', gap: 'var(--s-2)' }}>
                      <span class="who">{directPaymentName(row.target) ?? props.nameOf(row.target, row.room)}</span>
                      <span class="sats" data-row-tally>
                        {fmtAmount(row.spent_msat)}
                        <span class="unit">{row.limit_msat === null ? ', approved by hand' : `/ ${fmtAmount(row.limit_msat)}`}</span>
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
                          <button type="button" class="link" data-budget-edit onClick={() => { setEditing(key()); setValue(String((row.limit_msat ?? 0) / 1000)); setNote(null); }}>
                            {row.limit_msat === null ? 'Set a budget' : 'Change'}
                          </button>
                        }
                      >
                        <form class="row" onSubmit={(e) => { e.preventDefault(); void save(row); }}>
                          <input inputmode="numeric" value={value()} onInput={(e) => setValue(e.currentTarget.value)} aria-label={`Sats a day for ${props.nameOf(row.target, row.room)}`} data-budget-input />
                          <button type="submit" class="small" data-budget-save>Save</button>
                          <button type="button" class="link" onClick={() => setEditing(null)}>Cancel</button>
                        </form>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={note() && note() !== MONEY_NOT_READY}><p class="err-note">{note()}</p></Show>
            <Show when={props.error}><p class="err-note">{props.error}</p></Show>
            <p class="hint">
              A budget can go up to the app all-in limit you approved; raising the total is a new approval. Budgets and this tally are
              saved on this device. Your approval is not: after a restart, approve once more. 0 forgets a contact, so they are asked
              again. Files, invoice payments and keysend still need the ten-minute manual approval and count against this app limit;
              any node grant applies separately. When a contact with a budget reconnects and
              asks to be admitted again, your node pays that from their budget without asking; anyone else asks you once.
            </p>
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
            setCandErr('The node status differs from the reviewed gift. Review the request again.');
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
    open() ? what : props.spend?.state === 'pending' ? 'Waiting for approval' : 'Approve first';
  const waiting = () => props.spend?.state === 'pending' || props.spend?.state === 'unavailable';

  return (
    <>
      <TrackHead title="Start something" onContext={props.onContext} />
      <SpendBar spend={props.spend} error={props.spendError} now={props.now} actions={props.actions} />
      <div class="stream">
        <Show
          when={mineLive()}
          fallback={
            <div class="empty-track" data-new-track>
              <h2>Share your node id</h2>
              <p class="hint">
                Anyone who knows it can offer to pay you to talk. Knowing an id is not admission: each message is
                admitted only when its payment settles. To open someone else’s profile card, use Browse.
              </p>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Your node id as a QR code">
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
                        {open() ? `Include starter bitcoin · ${fmtAmount(sponsor()!.gift_msat)}` : 'Include starter bitcoin · approve first'}
                      </button>
                      <p class="hint" data-starter-purse>
                        You fund it from your own node, only after you approve their request. {fmtAmount(sponsor()!.purse_used_msat)} of{' '}
                        {fmtAmount(sponsor()!.purse_msat)} used in the last 24 hours.
                      </p>
                    </>
                  }
                >
                  {(st) => (
                    <>
                      <p data-starter-offered>
                        Starter bitcoin: up to <strong>{fmtAmount(st().gift_msat)}</strong>, after you approve their request. It is theirs
                        once it arrives; every message still pays.
                      </p>
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
                  Your introduction expired. <button type="button" class="link" onClick={loadMine}>Make a new one</button>
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
              <h2>Your introduction</h2>
              <p class="hint">
                Let someone scan this, or send them the link. It shows your node key, where to reach it and your current
                prices, signed by your node. It is not admission: whoever uses it pays your price for every message.
              </p>
              <Show when={qr()}>
                <svg class="qr" viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Your introduction as a QR code">
                  <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                  <path d={qr()!.path} fill="#000000" />
                </svg>
              </Show>
              <p data-intro-prices>
                Admission: <strong>{fmtAmount(allIn(m().admission_msat))}</strong> including {feeCeiling(routingFee(m().admission_msat))}. Each message: <strong>{fmtAmount(allIn(m().message_msat))}</strong> including {feeCeiling(routingFee(m().message_msat))} (estimated ceilings).
              </p>
              <p class="hint">
                Valid for about {minutesLeft(m().expires_at)} min. <button type="button" class="link" onClick={loadMine}>New card</button>
              </p>
              <Show
                when={m().starter}
                fallback={
                  <Show when={sponsor()?.enabled}>
                    <button type="button" class="quiet" data-starter-include disabled={props.moneyBlocked} onClick={() => void includeStarter()}>
                      {open() ? `Include starter bitcoin · ${fmtAmount(sponsor()!.gift_msat)}` : 'Include starter bitcoin · approve first'}
                    </button>
                    <p class="hint" data-starter-purse>
                      You fund it from your own node, only after you approve their request. {fmtAmount(sponsor()!.purse_used_msat)} of{' '}
                      {fmtAmount(sponsor()!.purse_msat)} used in the last 24 hours.
                    </p>
                  </Show>
                }
              >
                {(st) => (
                  <p data-starter-offered>
                    Starter bitcoin: up to <strong>{fmtAmount(st().gift_msat)}</strong>, after you approve their request. It is theirs
                    once it arrives; every message still pays.
                  </p>
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
              <h2>Starter bitcoin request</h2>
              <p class="hint">Paste the request shown on their screen after they scanned your introduction.</p>
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
                aria-label="Starter bitcoin request"
              />
              <button type="submit" class="primary" classList={{ money: !open() }} data-starter-request-submit disabled={!request().trim() || requestLocked()}>
                {open() ? 'Review request' : 'Approve first'}
              </button>
              <Show when={cand()}>
                {(c) => (
                  <div class="artifact" data-starter-candidate={c().newcomer}>
                    <span class="kind">Starter bitcoin · {shortId(c().newcomer)}</span>
                    <p>
                      Lightning gift: <strong>{fmtAmount(c().gift_msat)}</strong>. Network fee: at most {fmtAmount(c().fee_max_msat)}.
                    </p>
                    <span class="hint">
                      They own it once it arrives and can keep or withdraw it. It is not a pass: their messages still pay.
                    </span>
                    <label class="door-allow">
                      <span>Code on their screen</span>
                      <input
                        data-starter-their-code
                        disabled={requestLocked()}
                        inputmode="numeric"
                        maxLength={6}
                        value={theirCode()}
                        onInput={(e) => setTheirCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                        aria-label="Code on their screen"
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
                        {giving() ? 'Preparing…' : `Sponsor up to ${fmtAmount(c().gift_msat + c().fee_max_msat)}`}
                      </button>
                      <button type="button" class="quiet" data-starter-cancel disabled={giving() || cancelling() || giftPending()} onClick={() => void cancelKit()}>
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
              </Show>
              <Show when={ownerRequired()}>
                <div class="approval" data-starter-owner-approval="pending">
                  <p><strong>Approve this gift at your node.</strong> Run this command once in the owner’s terminal from the node’s data directory, with owner control enabled. The app never receives an owner credential.</p>
                  <Show when={ownerWait()} fallback={<p>Review the request and compare the code to prepare the owner command.</p>}>
                    {(pending) => <>
                      <textarea readonly aria-label="Owner approval command" data-starter-owner-command value={pending().owner_command} />
                      <button type="button" class="link" onClick={() => void navigator.clipboard.writeText(pending().owner_command).catch(() => setCandErr('Select and copy the command above.'))}>Copy command</button>
                      <p class="hint">Waiting for the node to report this gift funded. Cancel asks the node to withdraw the kit before dispatch; tracking continues until withdrawal is confirmed, and it cannot undo a payment already sent.</p>
                    </>}
                  </Show>
                </div>
              </Show>
              <Show when={gift()}>
                {(g) => (
                  <p class={g().state === 'funded' ? 'ok-note' : 'err-note'} data-starter-gift={g().state}>
                    {g().state === 'funded'
                      ? `Sent ${fmtAmount(g().paid_msat)}. It is theirs now.`
                      : g().state === 'paying' || g().state === 'unknown'
                        ? 'Payment pending — do not send again. Your node keeps it reserved until the outcome is known.'
                        : `Gift ${g().state}. This kit is closed.`}
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
            <h2>Open an introduction</h2>
            <p class="hint">Paste a bitsov://introduce link someone showed or sent you. Reading it sends nothing.</p>
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
              aria-label="Introduction link"
            />
            <button type="submit" class="primary" disabled={!pasted().trim() || opening()}>
              Read card
            </button>
            <Show when={card()}>
              {(c) => (
                <div class="artifact" data-door-card={c().node_id}>
                  <span class="kind">Door card · {shortId(c().node_id)}</span>
                  <span>Signed by the key it names.</span>
                  <p data-door-prices>
                    Admission: <strong>{fmtAmount(allIn(c().admission_msat))}</strong> including {feeCeiling(routingFee(c().admission_msat))}. Each message: <strong>{fmtAmount(allIn(c().message_msat))}</strong> including {feeCeiling(routingFee(c().message_msat))} (estimated ceilings).
                  </p>
                  <Show when={c().starter}>
                    {(st) => (
                      <div class="door-starter" data-door-starter>
                        <p>
                          Starter bitcoin available after they approve: <strong>{fmtAmount(st().gift_msat)}</strong>.
                        </p>
                        <Show
                          when={ask()}
                          fallback={
                            <>
                              <span class="hint">
                                Requesting makes one invoice to your own node for exactly this amount and shows it as a QR for
                                them. Nothing is sent. It is a gift, not a pass: your messages still pay.
                              </span>
                              <button type="button" class="quiet" data-door-request-starter disabled={props.moneyBlocked} onClick={requestStarter}>
                                Request starter bitcoin
                              </button>
                            </>
                          }
                        >
                          {(a) => (
                            <>
                              <Show when={askQr()}>
                                <svg class="qr" viewBox={`0 0 ${askQr()!.extent} ${askQr()!.extent}`} shape-rendering="crispEdges" role="img" aria-label="Your starter-bitcoin request as a QR code">
                                  <rect width={askQr()!.extent} height={askQr()!.extent} fill="#ffffff" />
                                  <path d={askQr()!.path} fill="#000000" />
                                </svg>
                              </Show>
                              <p data-starter-code>
                                Show this to them. Code: <strong>{a().code.slice(0, 3)} {a().code.slice(3)}</strong>. They type it
                                before approving.
                              </p>
                              <p class="hint" data-starter-status={arrived() ? 'received' : 'waiting'}>
                                {arrived()
                                  ? `Received ${fmtAmount(arrived()!.amount_msat)} in your own node.`
                                  : 'Waiting for starter bitcoin…'}
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
                    Prices from their signed card. Before anything is paid, your node asks theirs for a fresh quote and you
                    confirm the total.
                  </span>
                  <Show when={c().reach === 'local'}>
                    <span class="hint" data-door-local>
                      Local network address ({c().endpoint}). Continue only if you are on the same network as them.
                    </span>
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
                      <span>Allow this local address</span>
                    </label>
                  </Show>
                  <details>
                    <summary>Details</summary>
                    <code class="address">{c().node_id}</code>
                    <span class="hint">Address {c().endpoint} · {c().network}</span>
                  </details>
                  <Show
                    when={cardLive()}
                    fallback={<span class="err-note" data-door-expired>This card has expired. Ask them for a fresh one.</span>}
                  >
                    <span class="hint">Continuing connects your node to theirs. It pays nothing and adds no contact.</span>
                    <span class="row" style={{ gap: 'var(--s-2)' }}>
                      <button
                        type="button"
                        class="primary"
                        data-door-continue
                        disabled={opening() || (c().reach === 'local' && !allowLocal(c()))}
                        onClick={continueCard}
                      >
                        {opening() ? 'Connecting…' : 'Continue'}
                      </button>
                      <button type="button" class="quiet" onClick={() => { readRevision += 1; setLocalConsent(null); setCard(null); }} disabled={opening()}>
                        Cancel
                      </button>
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
            <h2>Invite someone</h2>
            <p class="hint">
              An invite is bound to one person’s key and lets their node connect to yours. It is not a free pass: every
              message still pays to be admitted.
            </p>
            <input data-invitee placeholder="Their node id (64 hex)" value={invitee()} onInput={(e) => setInvitee(e.currentTarget.value)} aria-label="Their node id" />
            <input data-addr placeholder="Your node’s reachable address, host:port" value={addr()} onInput={(e) => setAddr(e.currentTarget.value)} aria-label="Your node's address" />
            <label class="row">
              <span class="hint">Valid for</span>
              <select value={hours()} onChange={(e) => setHours(Number(e.currentTarget.value))} aria-label="Valid for">
                <option value={24}>1 day</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <button type="submit" class="primary" classList={{ money: !open() }} data-invite-create-submit disabled={props.moneyBlocked || busy() || (open() ? !invitee() || !addr() : waiting())}>
              {button('Create invite')}
            </button>
            <Show when={made()}>
              {(m) => (
                <div class="artifact" data-invite-link>
                  <span class="kind">Invite · until {day(m().until)}</span>
                  <code class="address">{m().link}</code>
                  <span class="hint">Send it to them yourself. The app sends nothing on your behalf.</span>
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
            <h2>Accept an invite</h2>
            <p class="hint">Paste a bitsov://invite link someone sent you. Your node connects to theirs.</p>
            <textarea data-invite-token rows={3} placeholder="bitsov://invite/…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} aria-label="Invite link" />
            <button type="submit" class="primary" classList={{ money: !open() }} data-invite-accept-submit disabled={props.moneyBlocked || busy() || (open() ? !token().trim() : waiting())}>
              {button('Accept invite')}
            </button>
            <Show when={redeemed()}>
              {(r) => (
                <p class="ok-note" data-redeemed>
                  Accepted. Connecting to {shortId(r().inviter)} at {r().addr}. Messages between you still pay to be admitted.
                </p>
              )}
            </Show>
            <Show when={errs.redeem && errs.redeem !== MONEY_NOT_READY ? errs.redeem : null}>
              {(e) => <SoftError message={e()} data="invite-redeem-error" />}
            </Show>
          </form>
        </div>
        <p class="send-next">
          Invites change your node, so they use the same owner approval as spending. Profile cards live under Browse.
          <Show when={!props.nodeRooms}> This node does not support rooms yet.</Show>
        </p>
      </div>
    </>
  );
}

// ---- context panels ---------------------------------------------------------

function NodePanel(props: { overview: NodeOverview | null; link: LinkState | null; peers: Peer[]; now: number; error?: string; onReconnect: () => Promise<void> }) {
  const fresh = () => freshness(props.overview?.read_at ?? null, props.now);
  const linkText = () =>
    props.link === 'open' ? 'Live' : props.link === 'connecting' ? 'Connecting' : props.link === 'closed' ? 'Reconnecting' : 'Waiting';
  return (
    <div class="panel" data-panel="node">
      <h2>Your node</h2>
      <Show when={props.overview} fallback={<Show when={!props.error}><DelayedSpinner /></Show>}>
        {(o) => (
          <dl class="facts">
            <dt>Status</dt>
            <dd>
              <span class="row" style={{ 'justify-content': 'flex-end', gap: 'var(--s-2)' }}>
                <span class={`dot ${o().status === 'ok' ? 'ok' : 'warn'}`} />
                {o().status === 'ok' ? 'Healthy' : o().status}
              </span>
            </dd>
            <dt>Node id</dt>
            <dd class="id" title={o().node_id}>{shortId(o().node_id)}</dd>
            <Show when={custodyBadge(o().custody_mode)}>
              <dt>Keys</dt>
              <dd><CustodyBadgeView mode={o().custody_mode} /></dd>
            </Show>
            <dt>Live feed</dt>
            <dd data-link={props.link ?? 'none'}>{linkText()}</dd>
            <dt>Peers connected</dt>
            <dd class="sats">{o().connected_peers}</dd>
            <dt>Encrypted sessions</dt>
            <dd class="sats">{o().e2ee_sessions}</dd>
            <dt>Waiting to deliver</dt>
            <dd class="sats">{o().pending_deliveries}</dd>
            <dt>Block height</dt>
            <dd class="sats">{o().block_height !== null ? satsWhole(o().block_height!) : 'unknown'}</dd>
            <dt>Lightning</dt>
            <dd>{o().lightning_available ? o().lightning_backend ?? 'available' : 'unavailable'}</dd>
            <dt>Chain source</dt>
            <dd>{o().chain_backend ?? 'unknown'}</dd>
            <dt>Uptime</dt>
            <dd class="sats">{uptime(o().uptime_secs)}</dd>
            <dt>API</dt>
            <dd>{o().version ?? 'unknown'}</dd>
          </dl>
        )}
      </Show>
      <p class="fresh-line" classList={{ stale: fresh().stale }} data-freshness>
        {fresh().label}
      </p>
      <Show when={props.error}>
        <SoftError message={props.error!} onReconnect={props.onReconnect} />
      </Show>
      <h3>Peers</h3>
      <For each={props.peers} fallback={<p class="hint">Your node has no peers yet.</p>}>
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
      <p class="hint">Your peer list is private to this node. It is not who may reach you; payment decides that.</p>
    </div>
  );
}

function WalletPanel(props: { moneyBlocked: boolean; wallet: WalletOverview | null; error?: string; onReconnect: () => Promise<void>; fund?: JSX.Element }) {
  const active = () => props.wallet?.channels.filter((c) => c.active).length ?? 0;
  return (
    <>
      <div class="panel" data-panel="wallet">
        <h2>Wallet</h2>
        <p class="hint" data-budget-wallet-warning>Channel and on-chain actions, their fees, and owner-direct commands are outside the app daily all-in limit. Opening or closing a channel can commit funds and incur on-chain fees. Check the amount and fee policy at the owner action; this app limit will not stop it.</p>
        <Show when={props.wallet} fallback={<Show when={!props.error}><DelayedSpinner /></Show>}>
          {(w) => (
            <>
              <div class="big-balance">
                <span class="sats" data-balance>
                  {sats(w().balance_msat)}
                  <span class="unit">{satUnit(w().balance_msat)}</span>
                </span>
                <p class="hint">Node-reported total: one figure, not a spendable balance.</p>
              </div>
              <dl class="facts">
                <dt>{props.moneyBlocked ? 'Lightning outbound capacity (money not ready)' : 'Lightning outbound capacity'}</dt>
                <dd class="sats">{fmtAmount(w().lightning_spendable_sats == null ? w().lightning_outbound_msat : w().lightning_spendable_sats! * 1000)}</dd>
                <dt>Open channels</dt>
                <dd class="sats">
                  {active()} of {w().channels.length} active
                </dd>
              </dl>
              <h3>Channels</h3>
              <For each={w().channels} fallback={<p class="hint">No channels yet. A channel is needed before paid messages can be sent.</p>}>
                {(c) => {
                  const share = () => (c.capacity_msat > 0 ? (c.local_balance_msat / c.capacity_msat) * 100 : 0);
                  return (
                    <div class="channel" data-channel={c.channel_id}>
                      <div class="row">
                        <span class="id" title={c.peer_pubkey}>{shortId(c.peer_pubkey)}</span>
                        <span>{c.active ? 'active' : 'inactive'}</span>
                      </div>
                      <div class="liquidity" title="Yours (orange) against theirs">
                        <div style={{ width: `${share()}%`, opacity: c.active ? 1 : 0.4 }} />
                      </div>
                      <div class="row">
                        <span class="sats">{fmtAmount(c.local_balance_msat)} yours</span>
                        <span class="sats">{fmtAmount(c.remote_balance_msat)} theirs</span>
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
