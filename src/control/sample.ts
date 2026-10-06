import { amount as fmtAmount, allIn, routingFee } from './format';
// Dev-mode sample data: the whole shell clickable with no node running. Nothing
// here reaches a network or the host. The sample deposit address is not valid
// bech32 on purpose, so it cannot receive funds by mistake.

import type { NodeStatus, PairingView } from '../onboarding/pairing';
import { seedPetnameIfEmpty } from './petnames';
import type { Source } from './source';
import type {
  InvoiceStatus,
  VoiceBlob,
  FileSaveResult,
  FundingAsk,
  Introduction,
  FrontDoor,
  PorchCard,
  PorchRead,
  ActionError,
  AiFreshness,
  BudgetPreset,
  BudgetRow,
  BudgetView,
  AiTopic,
  Amount,
  Disclosure,
  EnergyRead,
  EnergySpan,
  LocalStatus,
  MembraneEvent,
  MembraneRead,
  Preset,
  ProviderView,
  RemoteAnswer,
  ToolOutput,
  TopicRead,
  FundState,
  LiveEvent,
  Message,
  Peer,
  PriceQuote,
  Room,
  RoomQuote,
  SpendView,
  DeviceView,
  WalletOverview,
} from './types';

const hex = (c: string) => c.repeat(64);
export const SAMPLE_OWN_ID = '3f9a' + '1'.repeat(56) + 'c0de';
/** A sample stranger, reachable only through the sample introduction link. */
export const SAMPLE_STRANGER_ID = '5e1f' + '7'.repeat(56) + 'a11e';
export const SAMPLE_INTRO_LINK = 'bitsov://introduce#SAMPLE';
export const SAMPLE_FRONT_DOOR_LINK = 'bitsov://front-door#SAMPLE';
export const SAMPLE_EXPIRED_FRONT_DOOR_LINK = 'bitsov://front-door#EXPIRED';
export const SAMPLE_PUBLIC_FRONT_DOOR_LINK = 'bitsov://front-door#PUBLIC';
export const SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK = 'bitsov://front-door#HOSTILE';
export const SAMPLE_DISALLOWED_FRONT_DOOR_LINK = 'bitsov://front-door#DISALLOWED';

function sampleIntroduction(nodeId: string, endpoint: string, reach: Introduction['reach'], msat: number): Introduction {
  const now = Math.floor(Date.now() / 1000);
  return {
    node_id: nodeId,
    network: 'regtest',
    endpoint,
    reach,
    admission_msat: msat,
    message_msat: msat,
    issued_at: now,
    expires_at: now + 600,
    link: nodeId === SAMPLE_OWN_ID ? 'bitsov://introduce#AQdyZWd0ZXN0' + 'A'.repeat(240) : SAMPLE_INTRO_LINK,
  };
}

function sampleFrontDoor(
  nodeId: string,
  endpoint: string,
  reach: FrontDoor['reach'],
  name: string,
  opts?: {
    expired?: boolean;
    link?: string;
    media?: FrontDoor['media'];
    links?: FrontDoor['links'];
    avatar?: FrontDoor['profile']['avatar'];
  },
): FrontDoor {
  const now = Math.floor(Date.now() / 1000);
  const issued = opts?.expired ? now - 8 * 24 * 3600 : now;
  return {
    node_id: nodeId,
    network: 'regtest',
    endpoint,
    reach,
    seq: 1,
    issued_at: issued,
    expires_at: opts?.expired ? now - 24 * 3600 : now + 7 * 24 * 3600,
    prices: { admission_msat: 100_000, message_msat: 10_000, page_msat: 1_000, price_epoch: 0 },
    profile: {
      kind: 'person',
      display_name: name,
      tagline: 'Sample doorstep',
      about: 'A sample front-door card for Discover.',
      avatar: opts?.avatar,
    },
    media: opts?.media ?? [],
    links: opts?.links ?? [],
    link:
      opts?.link ??
      (nodeId === SAMPLE_OWN_ID ? 'bitsov://front-door#OWN' + 'A'.repeat(40) : SAMPLE_FRONT_DOOR_LINK),
    verified: true,
    fresh: !opts?.expired,
  };
}

/** The sample porch: Maya's node answers reads (`porch_read_v1`). */
const PORCH_READ_MSAT = 1000;
const SAMPLE_PORCH_PAGES: Record<string, string> = {
  '/index.md': '# Maya\n\nBuilding a **sovereign** mesh, one paid hop at a time.\n\n## Now\n\n- Pilot node in Lisbon\n- Writing `notes.txt` weekly\n\n> Every act paid, recipient-bound.\n\n<script>alert(1)</script> stays text. [Site](https://example.invalid) is never opened.',
  '/notes.txt': 'Plain notes.\nLine two.',
};
function samplePorchCard(nodeId: string): FrontDoor {
  return {
    ...sampleFrontDoor(nodeId, '34.90.12.8:9735', 'public', 'Maya'),
    site: { index_path: 'index.md', page_count: 2, titles: ['Maya', 'Notes'] },
    cv: { path: 'cv.md', hash: 'ab'.repeat(32), size: 120 },
  };
}

const NODE_PAYMENT_STATE = new Map<string, InvoiceStatus['state']>([
  ['Settled', 'paid'], ['Pending', 'waiting'], ['InFlight', 'waiting'], ['Failed', 'failed'], ['Expired', 'failed'],
]);
/**
 * The host's `act::invoice_status`, for the sample: it reads the node's
 * `GET /payments/{hash}` reply in the node's own names, so the sample cannot
 * show a state a real node never would.
 */
export function invoiceFromNode(http: number, body: Record<string, unknown>): InvoiceStatus {
  const unknown: InvoiceStatus = { state: 'unknown', amount_msat: null };
  if (http < 200 || http >= 300 || typeof body.status !== 'string' || typeof body.direction !== 'string') return unknown;
  if (body.direction.toLowerCase() !== 'incoming') return unknown;
  const state = NODE_PAYMENT_STATE.get(body.status);
  if (!state) return unknown;
  return { state, amount_msat: typeof body.amount_msat === 'number' ? body.amount_msat : null };
}

export const SAMPLE_PEERS: Peer[] = [
  { node_id: hex('a'), addr: '34.90.12.8:9735', label: 'Maya', connected: true, fingerprint: 'aaaaaaaa', porch: true },
  { node_id: hex('b'), addr: '35.204.77.3:9735', label: 'Josh', connected: true, fingerprint: 'bbbbbbbb' },
  { node_id: hex('c'), addr: '34.141.2.19:9735', label: null, connected: false, fingerprint: 'cccccccc' },
  // Connected, but its cached price table is stale: a send underpays and its node rejects it.
  { node_id: hex('d'), addr: '34.32.90.40:9735', label: 'Gamma VM', connected: true, fingerprint: 'dddddddd' },
];
export const SAMPLE_ROOM_ID = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
export const SAMPLE_OPEN_ROOM_ID = '7d2c9e10-4b6a-4f3e-9c21-5e8f0a1b2c3d';
export const SAMPLE_ROOMS: Room[] = [
  { id: SAMPLE_ROOM_ID, name: 'Mexico build', created_by: SAMPLE_OWN_ID, created_at: '2026-09-20T09:00:00Z' },
  { id: SAMPLE_OPEN_ROOM_ID, name: 'Open circle', created_by: SAMPLE_OWN_ID, created_at: '2026-09-25T18:00:00Z' },
];
const ROOM_MEMBERS: Record<string, string[]> = {
  [SAMPLE_ROOM_ID]: [SAMPLE_OWN_ID, hex('a'), hex('b')],
  // hex('c') is not a connected peer, so this room cannot send.
  [SAMPLE_OPEN_ROOM_ID]: [SAMPLE_OWN_ID, hex('a'), hex('c')],
};

const T0 = Date.UTC(2026, 8, 27, 8, 12);
let seq = 0;
const msg = (from: string, to: string, minutes: number, text: string, msat = 1000): Message => ({
  id: `sample-${(seq++).toString(16).padStart(4, '0')}`,
  kind: 0,
  sender: from,
  recipient: to,
  timestamp: T0 + minutes * 60_000,
  plaintext: text,
  payment_amount_msat: msat,
});

const THREADS: Record<string, Message[]> = {
  [hex('a')]: [
    msg(hex('a'), SAMPLE_OWN_ID, 0, 'Morning. My node came back up on the new VM.', 2000),
    msg(SAMPLE_OWN_ID, hex('a'), 3, 'Seeing you connected. Channel looks healthy from here.'),
    msg(hex('a'), SAMPLE_OWN_ID, 5, 'Raised my price to 2 sats a message. The spam test last night was loud.', 2000),
    msg(SAMPLE_OWN_ID, hex('a'), 9, 'Fair. Two sats is still nothing for real conversation.'),
  ],
  [hex('b')]: [
    msg(hex('b'), SAMPLE_OWN_ID, 20, 'Can you check if my paid-open reached you?'),
    msg(SAMPLE_OWN_ID, hex('b'), 22, 'Got it, settled. First contact admitted.'),
  ],
  [SAMPLE_ROOM_ID]: [
    msg(hex('a'), SAMPLE_ROOM_ID, 30, 'Room is set for the Mexico demo. Two nodes here, one at home.', 2000),
    msg(hex('b'), SAMPLE_ROOM_ID, 34, 'Josh here. My VM is on rc7 as well.'),
    msg(SAMPLE_OWN_ID, SAMPLE_ROOM_ID, 41, 'Great. Every message in here pays each of you separately.'),
  ],
};

const LIVE_LINES: [string, string][] = [
  [hex('a'), 'Block 860,124 just landed. Fees are calm.'],
  // Not a contact: a stranger who paid the door price. Admitted, never added to peers.
  [hex('e'), 'Hi, saw your talk in Mexico. Paid your door to say thanks.'],
  [hex('b'), 'Heading out, my node stays up.'],
  [hex('a'), 'Did the channel rebalance go through on your side?'],
];

// ---- organism v2 sample (genome N1 / N2), only with `?sample&organism=v2` -----
// A node-wide ledger relative to now: it includes a contact whose track was never
// opened (Dana) and the stranger who paid the door, which the v1 sums cannot see.

export const SAMPLE_STRANGER = hex('e');
const STRANGER_LINE = msg(SAMPLE_STRANGER, SAMPLE_OWN_ID, 0, 'Hi, saw your talk in Mexico. Paid your door to say thanks.', 1000);
/** Sent (by their clock) a few seconds before the node admitted it, 44 min ago. */
const strangerThread = (): Message[] => [{ ...STRANGER_LINE, timestamp: Date.now() - 44 * 60_000 - 3_000 }];

/** [minutes ago, counterparty, kind, in msat, out msat]. Hours with nothing stay gaps. */
const LEDGER: [number, string, 'peer' | 'room', number, number][] = [
  [4, hex('a'), 'peer', 2000, 0],
  [12, SAMPLE_STRANGER, 'peer', 1000, 0],
  [25, hex('a'), 'peer', 0, 2000],
  [48, hex('b'), 'peer', 1000, 1000],
  [95, SAMPLE_ROOM_ID, 'room', 3000, 3000],
  [130, hex('a'), 'peer', 4000, 2000],
  [190, hex('d'), 'peer', 6000, 0],
  [260, hex('b'), 'peer', 0, 1000],
  [420, hex('a'), 'peer', 8000, 4000],
  [480, hex('d'), 'peer', 2000, 1000],
  [610, SAMPLE_ROOM_ID, 'room', 2000, 2000],
  [790, hex('a'), 'peer', 2000, 0],
  [1020, hex('b'), 'peer', 3000, 2000],
  [1110, hex('d'), 'peer', 1000, 0],
  [1300, hex('a'), 'peer', 6000, 2000],
];

function sampleEnergy(span: EnergySpan, now: number): EnergyRead {
  const spanMs = span === '1h' ? 3_600_000 : span === '24h' ? DAY_MS : 7 * DAY_MS;
  const bucketMs = span === '1h' ? 300_000 : span === '24h' ? 3_600_000 : DAY_MS;
  const buckets = new Map<number, { start_ms: number; in_msat: number; out_msat: number }>();
  const parties = new Map<string, EnergyRead['counterparties'][number]>();
  const totals = { in_msat: 0, out_msat: 0, in_count: 0, out_count: 0 };
  for (const [minAgo, id, kind, inMsat, outMsat] of LEDGER) {
    const at = now - minAgo * 60_000;
    if (now - at > spanMs) continue;
    const start = at - (at % bucketMs);
    const b = buckets.get(start) ?? { start_ms: start, in_msat: 0, out_msat: 0 };
    const c = parties.get(id) ?? { kind, id, in_msat: 0, out_msat: 0, in_count: 0, out_count: 0 };
    b.in_msat += inMsat;
    b.out_msat += outMsat;
    c.in_msat += inMsat;
    c.out_msat += outMsat;
    c.in_count += inMsat > 0 ? 1 : 0;
    c.out_count += outMsat > 0 ? 1 : 0;
    totals.in_msat += inMsat;
    totals.out_msat += outMsat;
    totals.in_count += inMsat > 0 ? 1 : 0;
    totals.out_count += outMsat > 0 ? 1 : 0;
    buckets.set(start, b);
    parties.set(id, c);
  }
  return {
    window: span,
    as_of_ms: now,
    bucket_ms: bucketMs,
    buckets: [...buckets.values()].sort((a, b) => a.start_ms - b.start_ms),
    counterparties: [...parties.values()].sort((a, b) => b.in_msat + b.out_msat - (a.in_msat + a.out_msat)),
    totals,
    truncated: false,
  };
}

let membraneSeqSample = 0;
const knock = (minAgo: number, e: Partial<MembraneEvent> & Pick<MembraneEvent, 'verdict' | 'code'>): MembraneEvent => ({
  seq: ++membraneSeqSample,
  at: Date.now() - minAgo * 60_000,
  direction: 'inbound',
  kind: 0,
  counterparty: null,
  first_contact: false,
  required_msat: null,
  paid_msat: null,
  cap_msat: null,
  ...e,
});

/** The node's ring as a sample: a stranger admitted by payment, and refusals at the door. */
function sampleKnocks(): MembraneEvent[] {
  membraneSeqSample = 0;
  return [
    knock(52, { verdict: 'refused', code: 'stale' }),
    knock(46, { verdict: 'refused', code: 'unpaid', counterparty: hex('f'), required_msat: 1000, paid_msat: 0 }),
    knock(44, { verdict: 'admitted', code: 'settled', counterparty: SAMPLE_STRANGER, first_contact: true, paid_msat: 1000 }),
    knock(31, { verdict: 'refused', code: 'bad_signature', paid_msat: 1000 }),
    knock(18, { verdict: 'refused', code: 'unpaid', counterparty: hex('f'), required_msat: 1000, paid_msat: 0 }),
    knock(9, { verdict: 'refused', code: 'proof_reused', counterparty: hex('b'), required_msat: null, paid_msat: 1000 }),
    knock(4, { verdict: 'admitted', code: 'settled', counterparty: hex('a'), paid_msat: 2000 }),
  ].reverse();
}

const PRICE_TABLES: Record<string, Pick<PriceQuote, 'peer_msat' | 'peer_age_secs' | 'peer_stale'>> = {
  [hex('a')]: { peer_msat: 2000, peer_age_secs: 240, peer_stale: false },
  [hex('d')]: { peer_msat: 1000, peer_age_secs: 86_400 * 3, peer_stale: true },
};

// Consistent with rc7: the combined balance is all Lightning (420k sats across
// three channels) plus 62.5k spendable on-chain; outbound counts active channels.
const WALLET: WalletOverview = {
  balance_msat: 482_500_000,
  lightning_outbound_msat: 400_000_000,
  channels: [
    { channel_id: 'sample-1', peer_pubkey: '02' + 'a1'.repeat(32), capacity_msat: 350_000_000, local_balance_msat: 250_000_000, remote_balance_msat: 100_000_000, active: true },
    { channel_id: 'sample-2', peer_pubkey: '03' + 'b2'.repeat(32), capacity_msat: 500_000_000, local_balance_msat: 150_000_000, remote_balance_msat: 350_000_000, active: true },
    { channel_id: 'sample-3', peer_pubkey: '02' + 'd4'.repeat(32), capacity_msat: 25_000_000, local_balance_msat: 20_000_000, remote_balance_msat: 5_000_000, active: false },
  ],
};

const SAMPLE_ADDRESS = 'tb1qsampledata0notarealaddress0donotsend';

const OWN_PRICE_MSAT = 1000;
const FILE_PRICE_MSAT = 3000;
const WINDOW_MS = 10 * 60 * 1000;
/** Status polls before the sample owner "types" the grant at their terminal. */
const GRANT_AFTER_POLLS = 2;

// B2 budgets, as the host keeps them: numbers and a rolling 24-hour ledger.
// The approval is memory only, so the sample starts with it off, like a restart.
const DAY_MS = 24 * 60 * 60 * 1000;
export const SAMPLE_PRESETS: BudgetPreset[] = [
  { id: 'careful', contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 },
  { id: 'everyday', contact_msat: 200_000, room_msat: 500_000, ceiling_msat: 2_000_000 },
  { id: 'generous', contact_msat: 1_000_000, room_msat: 2_500_000, ceiling_msat: 10_000_000 },
];
const MAX_DAILY_MSAT = 100_000_000;

// ---- AI track sample ----------------------------------------------------------
// What the host's read broker would return for the sample node: the same
// wallet, peers and threads as above, projected to the broker's shapes. The
// remote model is a stand-in that answers from the preview body; nothing is
// sent anywhere.

const HOUR = 3_600_000;
const avail = (value: number, unit: string, source_field: string): Amount => ({ state: 'available', value, unit, source_field });
const msat = (value: number, field: string) => avail(value, 'msat', field);
const count = (value: number, field: string) => avail(value, 'count', field);

/** Paid messages with each contact, hours before now. Positive is sent. */
const SAMPLE_PAYMENTS: [string, number, number][] = [
  [hex('a'), 0.7, -2000],
  [hex('a'), 1.2, 2000],
  [hex('b'), 5, 1000],
  [hex('b'), 6.5, -1000],
  [hex('a'), 26, 2000],
  [hex('a'), 30, -2000],
  [hex('d'), 49, 1000],
  [hex('a'), 74, 2000],
  [hex('b'), 190, 1000],
];

function samplePayments(sinceMs: number | null): ToolOutput {
  const now = Date.now();
  const entries = SAMPLE_PAYMENTS.map(([peer, hours, signed]) => ({
    at_ms: Math.round(now - hours * HOUR),
    direction: signed > 0 ? ('sent' as const) : ('received' as const),
    amount: msat(Math.abs(signed), 'payment_amount_msat'),
    peer: { state: 'value' as const, value: peer },
  })).filter((e) => sinceMs === null || e.at_ms >= sinceMs);
  const total = (d: 'sent' | 'received') => entries.filter((e) => e.direction === d).reduce((n, e) => n + (e.amount.state === 'available' ? e.amount.value : 0), 0);
  return {
    tool: 'payments',
    report: {
      state: 'ready',
      value: {
        entries,
        sent_total: msat(total('sent'), 'payment_amount_msat'),
        received_total: msat(total('received'), 'payment_amount_msat'),
        unlisted: count(0, 'messages'),
        peers_read: count(SAMPLE_PEERS.length, 'node_id'),
        peers_unread: count(0, 'node_id'),
        partial_threads: count(0, 'messages'),
      },
    },
  };
}

const channelSummaries = WALLET.channels.map((c) => ({
  channel_id: { state: 'value' as const, value: c.channel_id },
  capacity: msat(c.capacity_msat, 'capacity_msat'),
  local_balance: msat(c.local_balance_msat, 'local_balance_msat'),
  remote_balance: msat(c.remote_balance_msat, 'remote_balance_msat'),
  active: c.active,
  short_channel_id: null,
}));
const sum = (pick: (c: WalletOverview['channels'][number]) => number) => WALLET.channels.reduce((n, c) => n + pick(c), 0);

function sampleOutputs(topic: AiTopic, sinceMs: number | null): ToolOutput[] {
  switch (topic) {
    case 'balance':
      return [{
        tool: 'balance',
        report: { state: 'ready', value: {
          label: 'ldk_onchain_plus_lightning',
          wallet_balance: msat(WALLET.balance_msat, 'balance_msat'),
          channel_local_balance: msat(sum((c) => c.local_balance_msat), 'local_balance_msat'),
          channel_remote_balance: msat(sum((c) => c.remote_balance_msat), 'remote_balance_msat'),
          channel_capacity: msat(sum((c) => c.capacity_msat), 'capacity_msat'),
        } },
      }];
    case 'channels':
      return [{
        tool: 'channels',
        report: { state: 'ready', value: {
          count: count(WALLET.channels.length, 'channel_id'),
          active_count: count(WALLET.channels.filter((c) => c.active).length, 'active'),
          channels: channelSummaries,
        } },
      }];
    case 'node':
      return [{
        tool: 'health',
        report: { state: 'ready', value: {
          liveness: 'ok',
          connected_peers: count(SAMPLE_PEERS.filter((p) => p.connected).length, 'connected_peers'),
          e2ee_sessions: count(3, 'e2ee_sessions'),
          pending_deliveries: count(0, 'pending_deliveries'),
          lightning_available: true,
          lightning_payment_capable: true,
          uptime: avail(3 * 86_400 + 4 * 3600, 'seconds', 'uptime_secs'),
          version: avail(2, 'protocol_version', 'version'),
          lightning_backend: 'ldk',
          chain_backend: 'esplora',
          block_height: avail(860_123, 'blocks', 'block_height'),
        } },
      }];
    case 'inbox':
      return [{
        tool: 'message_counts',
        report: { state: 'ready', value: {
          returned_count: count(7, 'messages'),
          senders: [
            { sender: hex('a'), count: count(4, 'sender') },
            { sender: hex('b'), count: count(3, 'sender') },
          ],
          withheld_senders: count(0, 'sender'),
        } },
      }];
    case 'prices':
      return [{
        tool: 'local_prices',
        report: { state: 'ready', value: {
          mode: 'static',
          prices: [
            { category: 'communication', price: msat(OWN_PRICE_MSAT, 'prices') },
            { category: 'files_media', price: msat(FILE_PRICE_MSAT, 'prices') },
            { category: 'structured_data', price: msat(1000, 'prices') },
            { category: 'collaboration', price: msat(2000, 'prices') },
          ],
          block_height: avail(860_123, 'blocks', 'block_height'),
        } },
      }];
    case 'payments':
      return [samplePayments(sinceMs)];
  }
}

/** As the host would describe the reads. The price table is the stale one. */
const SAMPLE_READS: Record<AiTopic, { routes: string[]; freshness: AiFreshness }> = {
  balance: {
    routes: ['GET /api/v1/payments/balance', 'GET /api/v1/payments/channels', 'GET /api/v1/health'],
    freshness: { state: 'fresh', age_ms: 38_000, fresh_for_ms: 60_000, node_as_of: true, node_stale: false, clock_skew: false },
  },
  channels: {
    routes: ['GET /api/v1/payments/channels'],
    freshness: { state: 'fresh', age_ms: 38_000, fresh_for_ms: 142_000, node_as_of: true, node_stale: false, clock_skew: false },
  },
  node: {
    routes: ['GET /api/v1/health'],
    freshness: { state: 'fresh', age_ms: 900, fresh_for_ms: 59_100, node_as_of: true, node_stale: false, clock_skew: false },
  },
  inbox: {
    routes: ['GET /api/v1/messages?limit=50'],
    freshness: { state: 'fresh', age_ms: 1_100, fresh_for_ms: 58_900, node_as_of: false, node_stale: false, clock_skew: false },
  },
  prices: {
    routes: ['GET /api/v1/pricing'],
    freshness: { state: 'stale', age_ms: 95_000, fresh_for_ms: 0, node_as_of: true, node_stale: true, clock_skew: false },
  },
  payments: {
    routes: ['GET /api/v1/peers', `GET /api/v1/messages?peer=… (${SAMPLE_PEERS.length} contacts)`],
    freshness: { state: 'fresh', age_ms: 1_400, fresh_for_ms: 58_600, node_as_of: true, node_stale: false, clock_skew: false },
  },
};

export function sampleRead(topic: AiTopic, sinceMs: number | null): TopicRead {
  return { state: 'live', topic, outputs: sampleOutputs(topic, sinceMs), ...structuredClone(SAMPLE_READS[topic]) };
}

export const SAMPLE_PROVIDERS: ProviderView[] = [
  { kind: 'local', label: 'On this computer', enabled: true, host: null, model: null, note: null, pays: { to: null, rail: 'none' }, data_leaves: null },
  { kind: 'shared', label: 'Shared open model (sample)', enabled: true, host: 'models.sample.invalid', model: 'open-8b-sample', note: null, pays: { to: 'models.sample.invalid', rail: 'fiat' }, data_leaves: 'counts' },
  { kind: 'frontier', label: 'Frontier model', enabled: false, host: null, model: null, note: 'Off. Not set up on this computer.', pays: { to: null, rail: 'none' }, data_leaves: null },
];

/** Sample Own-tier status: no server running; how-to only (no URL scheme — G2). */
export const SAMPLE_LOCAL_STATUS: LocalStatus = {
  running: false,
  kind: null,
  port: null,
  models: [],
  selected: null,
  selected_port: null,
  howto:
    'Start Ollama (`ollama serve`) or a llama.cpp server on this computer (listening on 127.0.0.1, usually port 11434 or 8080). Then pick a model here. BitSov does not download or install models; nothing leaves this computer.',
};

const looksLikeId = (text: string) => text.length >= 16 && /^[0-9a-f]+$/i.test(text);
const roundSats = (m: number) => {
  const s = Math.round(m / 1000);
  const digits = String(s).length;
  if (digits <= 2) return s;
  const step = 10 ** (digits - 2);
  return Math.round(s / step) * step;
};

/**
 * Sample-mode stand-in for the host's `narrow` (src-tauri/src/ai.rs), so the
 * preview looks like the real one. The host's version is the one that counts.
 */
export function sampleNarrow(value: unknown, preset: Preset): unknown {
  if (preset === 'exact') return value;
  if (Array.isArray(value)) {
    if (preset === 'counts' && value.some((v) => v && typeof v === 'object')) return { withheld_items: value.length };
    return value.map((v) => sampleNarrow(v, preset));
  }
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>;
    if ('unit' in map && 'source_field' in map) {
      const withheld = { state: 'withheld', unit: map.unit, source_field: map.source_field };
      if (map.state !== 'available') return map.state === 'rounded' && preset === 'counts' ? withheld : map;
      if (map.unit === 'count') return map;
      if (preset === 'counts') return withheld;
      if (map.unit === 'msat') return { state: 'rounded', unit: 'msat', source_field: map.source_field, sats: roundSats(map.value as number) };
      return map;
    }
    if (map.state === 'value' && 'value' in map) return { state: 'withheld' };
    return Object.fromEntries(
      Object.entries(map).map(([k, v]) => {
        if (k === 'at_ms' && typeof v === 'number') return [k, preset === 'rounded' ? Math.floor(v / 86_400_000) * 86_400_000 : { state: 'withheld' }];
        if (k === 'withheld_items') return [k, v];
        return [k, sampleNarrow(v, preset)];
      }),
    );
  }
  if (typeof value === 'string' && looksLikeId(value)) return 'withheld';
  if (typeof value === 'number' && preset === 'counts') return 'withheld';
  return value;
}

/** Same shape and wording as the host's `SYSTEM_PROMPT`. */
const SAMPLE_SYSTEM =
  "You answer a person's question about their own BitSov node, using only the JSON they send. Amounts are millisatoshis unless a field says sats. \"withheld\" and \"rounded\" mean the person chose not to share the exact value: do not guess it. If the data does not answer the question, say so in one sentence. Do not ask for more data, keys or passwords. Do not tell them to send or pay anything; the app does that only when they ask it to. Answer in at most four short sentences.";

function sampleRemoteText(topic: AiTopic, preset: Preset): string {
  const shared = { counts: 'the counts you shared', rounded: 'the rounded figures you shared', exact: 'the figures you shared' }[preset];
  const lead = `Sample reply: nothing left this computer. From ${shared}: `;
  switch (topic) {
    case 'payments':
      return lead + (preset === 'counts'
        ? '5 paid messages went out and 3 came in over the last 7 days. The amounts were withheld, so I cannot say what they cost.'
        : 'you spent about 8 sats on 5 paid messages this week and took in about 5. That is a very light week.');
    case 'balance':
      return lead + (preset === 'counts' ? 'your balance was withheld, so I cannot say how much you hold.' : 'your node holds about 480,000 sats, most of it in Lightning channels.');
    default:
      return lead + 'the data answers only part of your question.';
  }
}

const refuse = (code: ActionError['code'], message: string) => Promise.reject<never>({ code, message } satisfies ActionError);

/** The amount in a BOLT 11 prefix, mirroring the host's `bolt11_amount_msat` for sample invoices. */
export function sampleInvoiceMsat(bolt11: string): number | null {
  const m = /^(?:lightning:)?ln(?:bcrt|bc|tbs|tb|sb)(\d*)([munp]?)1/i.exec(bolt11.trim());
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  const per = { '': 100_000_000_000, m: 100_000_000, u: 100_000, n: 100, p: 0.1 }[m[2].toLowerCase() as '' | 'm' | 'u' | 'n' | 'p'];
  return Math.round(n * per);
}

/** The payee the sample host reports for every sample invoice. */
const SAMPLE_PAYEE = `02${'5a'.repeat(32)}`;

/** A sample invoice: the right prefix and amount, and a body no wallet will accept. */
const sampleBolt11 = (msat: number) =>
  msat % 100 === 0 ? `lntbs${msat / 100}n1samplenotpayable0donotpay` : `lntbs${msat * 10}p1samplenotpayable0donotpay`;

export function sampleSource(opts: { liveEveryMs?: number; firstLiveMs?: number; organism?: 'v1' | 'v2'; noPeers?: boolean } = {}): Source {
  // Demo convenience: sample peers carry remote labels; mirror them into local
  // petnames once so the rail shows owner names without treating labels as truth.
  for (const p of SAMPLE_PEERS) {
    if (p.label) seedPetnameIfEmpty(p.node_id, p.label);
  }
  // v1 (default) models a historical rc7 node: no energy read, no membrane events.
  const v2 = opts.organism === 'v2';
  let knocks = v2 ? sampleKnocks() : [];
  // v2 sample: Maya raises her price just before your first send to her, so the
  // send is refused at her door before any payment (a door card in her track).
  const raised: Record<string, number> = {};
  const liveEvery = opts.liveEveryMs ?? 30_000;
  const firstLive = opts.firstLiveMs ?? 7_000;
  let fund: FundState | null = null;
  let polls = 0;
  const status: NodeStatus = { ready: true, node_id: SAMPLE_OWN_ID, error: null };
  const pairing: PairingView = {
    remote: false,
    state: 'paired',
    scopes: ['read', 'receive'],
    short_code: 'SMPL-DATA',
    code_from_node: true,
    reason: null,
    bootstrap: null,
  };
  const ok = <T>(value: T) => Promise.resolve(structuredClone(value));

  // The sample node is paired and owner-run: a tap asks, and the owner grants.
  let spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
  let spendPolls = 0;
  let live: ((event: LiveEvent) => void) | null = null;
  let sent = 0;
  const settleSpend = () => {
    const now = Date.now();
    if (spend.state === 'open' && (spend.open_until_ms ?? 0) <= now) {
      spend = { ...spend, state: 'expired', basis: null, open_until_ms: null };
    }
  };
  // This Mac as a paired device: set up once, the owner approves at the node
  // (the sample approves after a few polls), then one Touch ID tap per contact.
  let device: DeviceView = {
    available: true,
    state: typeof window !== 'undefined' && (new URLSearchParams(window.location?.search).get('device') === 'registered' || window.localStorage?.getItem('bitsov.sample_device') === 'registered') ? 'registered' : 'none',
    fingerprint: typeof window !== 'undefined' && (new URLSearchParams(window.location?.search).get('device') === 'registered' || window.localStorage?.getItem('bitsov.sample_device') === 'registered') ? '3F9A-12C4' : null,
    owner_action: null,
    expires_at_ms: null,
  };
  let devicePolls = 0;
  const openWindow = () => {
    spend = { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + WINDOW_MS, pending: null, window_ms: WINDOW_MS };
  };
  const gate = (): Promise<void> => {
    settleSpend();
    if (spend.state === 'open') return Promise.resolve();
    return spend.state === 'expired'
      ? refuse('spend_expired', 'Your spending approval has expired. Approve again to send.')
      : refuse('spend_locked', 'Sending spends from your node. Approve spending first.');
  };
  const peerPrice = (id: string) => {
    if (raised[id] !== undefined) return raised[id];
    const t = PRICE_TABLES[id];
    return t && !t.peer_stale && t.peer_msat !== null ? t.peer_msat : OWN_PRICE_MSAT;
  };
  const roomQuote = (id: string): RoomQuote => {
    const members = (ROOM_MEMBERS[id] ?? [])
      .filter((m) => m !== SAMPLE_OWN_ID)
      .map((m) => ({
        node_id: m,
        msat: allIn(Math.max(peerPrice(m), 1000)),
        max_routing_fee_msat: routingFee(Math.max(peerPrice(m), 1000)),
        advertised: !!PRICE_TABLES[m] && !PRICE_TABLES[m].peer_stale,
        connected: SAMPLE_PEERS.some((p) => p.node_id === m && p.connected),
      }));
    return {
      room_id: id,
      max_routing_fee_msat: members.reduce((sum, m) => sum + m.max_routing_fee_msat, 0),
      members,
      total_msat: members.reduce((sum, m) => sum + m.msat, 0),
      unreachable: members.filter((m) => !m.connected).map((m) => m.node_id),
      estimate: members.some((m) => !m.advertised),
    };
  };
  const later = (ms: number, event: LiveEvent) => setTimeout(() => live?.(event), ms);

  // ---- budgets ----
  type Entry = { at: number; target: string; room: boolean; msat: number };
  const voiceNotes = new Map<string, VoiceBlob>();
  const receivedFiles = new Map<string, VoiceBlob>();
  const book = {
    preset: 'careful' as BudgetView['preset'],
    ceiling: 500_000,
    limits: new Map<string, number>([[`peer:${hex('a')}`, 50_000], [`peer:${hex('b')}`, 50_000], [`room:${SAMPLE_ROOM_ID}`, 100_000]]),
    paused: false,
    // Earlier today: what the sample threads show as paid.
    ledger: [
      { at: T0 + 3 * 60_000, target: hex('a'), room: false, msat: 2000 },
      { at: T0 + 9 * 60_000, target: hex('a'), room: false, msat: 2000 },
      { at: T0 + 22 * 60_000, target: hex('b'), room: false, msat: 1000 },
      { at: T0 + 41 * 60_000, target: SAMPLE_ROOM_ID, room: true, msat: 3000 },
    ].map((e) => ({ ...e, at: Date.now() - (T0 + 60 * 60_000 - e.at) })) as Entry[],
  };
  let autopay: { until: number; ceiling: number } | null = null;
  /** Invoices made in this sample session, and how often their status was read. */
  const issued = new Map<string, number>();
  let autopayExpired = false;
  const wants = { window: false, budget: null as number | null };
  const key = (target: string, room: boolean) => `${room ? 'room' : 'peer'}:${target}`;
  const live24 = (e: Entry) => e.at + DAY_MS > Date.now();
  const spentOn = (target: string, room: boolean) => book.ledger.filter((e) => live24(e) && e.target === target && e.room === room).reduce((n, e) => n + e.msat, 0);
  const spentAll = () => book.ledger.filter(live24).reduce((n, e) => n + e.msat, 0);
  const settleAutopay = () => {
    if (autopay && autopay.until <= Date.now()) {
      autopay = null;
      autopayExpired = true;
    }
  };
  const budgetView = (): BudgetView => {
    settleAutopay();
    const rows: BudgetRow[] = [...book.limits].map(([k, limit]) => {
      const [kind, target] = k.split(':') as ['peer' | 'room', string];
      return { target, room: kind === 'room', limit_msat: limit, spent_msat: spentOn(target, kind === 'room') };
    });
    for (const e of book.ledger.filter(live24)) {
      if (!rows.some((r) => r.target === e.target && r.room === e.room)) rows.push({ target: e.target, room: e.room, limit_msat: null, spent_msat: spentOn(e.target, e.room) });
    }
    rows.sort((a, b) => b.spent_msat - a.spent_msat || a.target.localeCompare(b.target));
    return {
      paused: book.paused,
      autopay: {
        state: autopay ? 'open' : autopayExpired ? 'expired' : 'off',
        open_until_ms: autopay?.until ?? null,
        ceiling_msat: autopay?.ceiling ?? null,
        basis: autopay ? 'node_grant' : null,
      },
      waiting_for_owner: wants.budget !== null && spend.state === 'pending',
      preset: book.preset,
      ceiling_msat: book.ceiling,
      spent_msat: spentAll(),
      unsettled_msat: 0,
      rows,
      presets: SAMPLE_PRESETS,
      window_ms: DAY_MS,
      max_daily_msat: MAX_DAILY_MSAT,
      node_grant: null,
    };
  };
  const requestElevation = () => {
    spendPolls = 0;
    spend = {
      state: 'pending',
      basis: null,
      open_until_ms: null,
      pending: {
        op_id: '5a3f0c9e21d4b7a8e6f10c2d',
        expires_at_ms: Date.now() + 15 * 60_000,
        owner_action: 'konsensus grant --op 5a3f0c9e21d4b7a8e6f10c2d',
        owner_can_grant: true,
      },
      window_ms: WINDOW_MS,
    };
  };
  /** The host's `budget::plan`: pause, the contact's budget, first contact, the daily total, then the window. */
  const planSend = (target: string, room: boolean, max: number, first: number | undefined, manual = false): Promise<number | null> => {
    settleAutopay();
    settleSpend();
    if (book.paused) return refuse('budget_paused', 'Payments are paused. Resume them to send.');
    const who = room ? 'this room' : 'this contact';
    const limit = book.limits.get(key(target, room));
    if (limit !== undefined && spentOn(target, room) + max > limit) {
      return refuse('budget_exhausted', `You have used ${fmtAmount(spentOn(target, room))} of ${fmtAmount(limit)} for ${who} in the last 24 hours, and this costs ${fmtAmount(max)}. Raise the budget to send.`);
    }
    const ceiling = Math.min(!manual && autopay ? autopay.ceiling : book.ceiling, book.ceiling);
    if (spentAll() + max > ceiling) {
      return refuse('ceiling_exhausted', `You have used ${fmtAmount(spentAll())} of your ${fmtAmount(ceiling)} app all-in payment limit (rolling 24 hours), and this costs ${fmtAmount(max)}. Raise the limit to send.`);
    }
    if (autopay && !manual) {
      let confirm: number | null = null;
      if (limit === undefined) {
        if (first === undefined) return refuse('first_contact', `Your first paid message to ${who} needs your OK once. Nothing was sent.`);
        confirm = Math.min(first, book.ceiling);
        if (confirm < max) return refuse('invalid', `A budget of ${fmtAmount(confirm)} does not cover this message.`);
      }
      return Promise.resolve(confirm);
    }
    return gate().then(() => (limit === undefined && first !== undefined && first >= max && first <= book.ceiling ? first : null));
  };
  const disclosures = new Map<string, { topic: AiTopic; preset: Preset }>();
  const porchHeld = new Map<string, PorchCard>();
  const nextId = (prefix: string) => `${prefix}-${(sent++).toString(16).padStart(4, '0')}`;

  return {
    mode: 'sample',
    nodeStatus: () => ok(status),
    nodeUnlock: () => Promise.reject('Unlock is not available with sample data.'),
    pairingStatus: () => ok(pairing),
    pairingRetry: () => ok(pairing),
    remoteAccessForget: () => Promise.reject('Remote access is not available with sample data.'),
    remoteAccessImport: () => Promise.reject('Remote access is not available with sample data.'),
    nodeRepairInitialized: async () => {},
    nodeRepairPriceFloor: async () => {},
    identityRestore: () => Promise.reject('Restore is not available with sample data.'),
    fundState: () => {
      if (fund && !fund.funded && ++polls >= 3) {
        fund = { ...fund, current_step: 'funding-seen', funded: true, funding_amount_sats_received: fund.funding_amount_sats_required ?? 0, funding_evidence: 'sample: no transaction' };
      }
      return ok(fund);
    },
    fundStart: (amount) => {
      fund = { current_step: 'awaiting-funding', tier: 'full', funding_address: SAMPLE_ADDRESS, funding_amount_sats_required: amount, funding_amount_sats_received: 0, funding_evidence: null, funded: false };
      polls = 0;
      return ok(fund);
    },
    fundingAddress: () => ok({ address: SAMPLE_ADDRESS, network: 'sample', note: null }),
    nodeOverview: () =>
      ok({
        node_id: SAMPLE_OWN_ID,
        status: 'ok',
        version: 'api v2',
        connected_peers: SAMPLE_PEERS.filter((p) => p.connected).length,
        e2ee_sessions: 3,
        pending_deliveries: 0,
        lightning_available: true,
        block_height: 860_123,
        uptime_secs: 3 * 86_400 + 4 * 3600,
        custody_mode: 'encrypted_seed',
        lightning_backend: 'ldk',
        chain_backend: 'esplora',
        capabilities: v2 ? ['energy_v1', 'membrane_v1', 'porch_read_v1'] : [],
        read_at: Date.now(),
      }),
    energy: (span) => (v2 ? ok(sampleEnergy(span, Date.now())) : Promise.reject('not found: this node has no energy read (N1)')),
    membrane: (limit) =>
      v2
        ? ok({
            capacity: 500,
            totals: {
              admitted: knocks.filter((k) => k.verdict === 'admitted').length,
              first_contacts: knocks.filter((k) => k.first_contact).length,
              refused: knocks.filter((k) => k.verdict === 'refused').length,
              outbound_refused: 0,
            },
            events: knocks.slice(0, limit ?? 50),
            read_at: Date.now(),
          } satisfies MembraneRead)
        : Promise.reject('not found: this node has no membrane read (N2)'),
    // `?sample&peers=0`: a node with no contacts yet (shows Welcome home).
    peers: () => ok(opts.noPeers ? [] : SAMPLE_PEERS),
    rooms: () => ok(SAMPLE_ROOMS),
    roomMembers: (id) => ok(ROOM_MEMBERS[id.toLowerCase()] ?? []),
    roomThread: () => ok([]),
    messages: (peer) => ok(THREADS[peer.toLowerCase()] ?? (v2 && peer.toLowerCase() === SAMPLE_STRANGER ? strangerThread() : [])),
    priceQuote: (peer) =>
      ok({
        kind: 0,
        max_routing_fee_msat: routingFee(Math.max(peerPrice(peer ?? ""), 1000)),
        own_msat: 1000,
        ...(PRICE_TABLES[peer ?? ''] ?? { peer_msat: null, peer_age_secs: null, peer_stale: false }),
        ...(peer && raised[peer] !== undefined ? { peer_msat: raised[peer], peer_age_secs: 1, peer_stale: false } : {}),
      }),
    // Sample strangers open their door at 2 sats and ask 2 sats a message.
    firstContactQuote: (peer) =>
      ok({ recipient: peer, admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, expires_at: Math.floor(Date.now() / 1000) + 60 }),
    // K1: sample cards are not signed; the host verifies real ones.
    introductionMine: () => ok(sampleIntroduction(SAMPLE_OWN_ID, 'node.example.org:9735', 'public', 10_000)),
    introductionRead: (text) =>
      text.trim() === SAMPLE_INTRO_LINK
        ? ok(sampleIntroduction(SAMPLE_STRANGER_ID, '192.168.1.20:9735', 'local', 2000))
        : Promise.reject('That is not an introduction.'),
    introductionOpen: (text, _allowLocal) =>
      text.trim() === SAMPLE_INTRO_LINK
        ? ok(sampleIntroduction(SAMPLE_STRANGER_ID, '192.168.1.20:9735', 'local', 2000))
        : Promise.reject('That is not an introduction.'),
    frontDoorMine: () => ok(sampleFrontDoor(SAMPLE_OWN_ID, 'node.example.org:9735', 'public', 'You')),
    frontDoorRead: (text) => {
      const t = text.trim();
      if (t === SAMPLE_FRONT_DOOR_LINK) {
        return ok(sampleFrontDoor(SAMPLE_STRANGER_ID, '192.168.1.20:9735', 'local', 'Ada'));
      }
      if (t === SAMPLE_PUBLIC_FRONT_DOOR_LINK) {
        return ok(
          sampleFrontDoor(SAMPLE_STRANGER_ID, 'node.example.org:9735', 'public', 'Ada', {
            link: SAMPLE_PUBLIC_FRONT_DOOR_LINK,
          }),
        );
      }
      if (t === SAMPLE_EXPIRED_FRONT_DOOR_LINK) {
        return ok(
          sampleFrontDoor(SAMPLE_STRANGER_ID, '192.168.1.20:9735', 'local', 'Ada', {
            expired: true,
            link: SAMPLE_EXPIRED_FRONT_DOOR_LINK,
          }),
        );
      }
      if (t === SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK) {
        return ok(
          sampleFrontDoor(SAMPLE_STRANGER_ID, 'node.example.org:9735', 'public', 'Ada', {
            link: SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK,
            // Hostile mime must not become an executable data: URL.
            media: [
              {
                hash: 'ab'.repeat(32),
                size: 12,
                mime: 'image/png" onerror="alert(1)',
                thumb_b64: 'AAAA',
                title: 'x',
              },
            ],
            links: [{ label: 'Website', url: 'https://example.invalid/path' }],
          }),
        );
      }
      if (t === SAMPLE_DISALLOWED_FRONT_DOOR_LINK) {
        return ok(
          sampleFrontDoor(SAMPLE_STRANGER_ID, '0.0.0.0:9', 'public', 'Ada', {
            link: SAMPLE_DISALLOWED_FRONT_DOOR_LINK,
          }),
        );
      }
      return Promise.reject('That is not a front-door card.');
    },
    frontDoorOpen: (text, allowLocal) => {
      const t = text.trim();
      if (t === SAMPLE_EXPIRED_FRONT_DOOR_LINK) {
        return Promise.reject('This front door has expired. Ask for a fresh one.');
      }
      if (t === SAMPLE_DISALLOWED_FRONT_DOOR_LINK) {
        return Promise.reject(
          'front_door_invalid: the node dialed an address this front door does not allow',
        );
      }
      if (t === SAMPLE_FRONT_DOOR_LINK) {
        if (!allowLocal) {
          return Promise.reject('This front door points to a local network address. Allow it on the card first.');
        }
        return ok(sampleFrontDoor(SAMPLE_STRANGER_ID, '192.168.1.20:9735', 'local', 'Ada'));
      }
      if (t === SAMPLE_PUBLIC_FRONT_DOOR_LINK || t === SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK) {
        return ok(
          sampleFrontDoor(SAMPLE_STRANGER_ID, 'node.example.org:9735', 'public', 'Ada', {
            link: t,
          }),
        );
      }
      return Promise.reject('That is not a front-door card.');
    },
    porchQuote: (peer, path) => {
      if (!SAMPLE_PEERS.some((p) => p.porch && p.node_id === peer.toLowerCase())) {
        return refuse('porch_unsupported', 'Their node does not offer porch reads (it does not advertise porch_quote_v1 or legacy porch_read_v1). Nothing was paid.');
      }
      if (path !== '/front-door.json' && !SAMPLE_PORCH_PAGES[path]) {
        return refuse('porch_not_found', 'Not found or empty: their node has no content at this path. Nothing was paid.');
      }
      return ok({ principal_msat: PORCH_READ_MSAT, max_routing_fee_msat: routingFee(PORCH_READ_MSAT), total_msat: allIn(PORCH_READ_MSAT) });
    },
    porchRead: async (peer, path, maxMsat) => {
      const target = peer.toLowerCase();
      if (!SAMPLE_PEERS.some((p) => p.porch && p.node_id === target)) {
        return refuse('porch_unsupported', 'Their node does not offer porch reads (it does not advertise porch_quote_v1 or legacy porch_read_v1). Nothing was paid.');
      }
      if (allIn(PORCH_READ_MSAT) > maxMsat) return refuse('price_changed', 'Price above confirmed ceiling.');
      if (await planSend(target, false, maxMsat, undefined) !== null) {
        return refuse('porch_needs_contact', 'Porch reads go to contacts you have already paid. Knock or send them a message first. Nothing was paid.');
      }
      book.ledger.push({ at: Date.now(), target, room: false, msat: maxMsat });
      const paid = { amount_msat: PORCH_READ_MSAT, total_msat: maxMsat, message_id: nextId('porch') };
      if (path === '/front-door.json') {
        const card: PorchCard = { ...samplePorchCard(target), cached: false, stale: false };
        porchHeld.set(target, { ...card, cached: true });
        return { node_id: target, path, status: 'ok', kind: 'card', body: '', card, ...paid } satisfies PorchRead;
      }
      const body = SAMPLE_PORCH_PAGES[path];
      return body === undefined
        ? ({ node_id: target, path, status: 'not_found', kind: 'none', body: '', card: null, ...paid } satisfies PorchRead)
        : ({ node_id: target, path, status: 'ok', kind: path.endsWith('.md') ? 'markdown' : 'text', body, card: null, ...paid } satisfies PorchRead);
    },
    porchCards: () => ok([...porchHeld.values()]),
    frontDoorHashBytes: async (bytesB64) => {
      // Deterministic stand-in for blake3 in the sample source (tests only).
      let h = 0;
      for (let i = 0; i < bytesB64.length; i++) h = (h * 31 + bytesB64.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(64, '0').slice(0, 64);
    },
    frontDoorPublish: (fields) =>
      ok({
        ...sampleFrontDoor(SAMPLE_OWN_ID, 'node.example.org:9735', 'public', fields.display_name),
        profile: {
          kind: fields.kind ?? 'person',
          display_name: fields.display_name,
          tagline: fields.tagline ?? '',
          about: fields.about ?? '',
          avatar: fields.avatar,
        },
        prices: {
          admission_msat: fields.admission_msat ?? 100_000,
          message_msat: fields.message_msat ?? 10_000,
          page_msat: fields.page_msat ?? 1_000,
          price_epoch: 0,
        },
        media: fields.media ?? [],
        cv: fields.cv,
        links: fields.links ?? [],
        seq: 2,
      }),
    // K1 slice 2: a sample kit. Nothing here is signed or paid.
    sponsorStatus: () => ok({ enabled: true, gift_msat: 20_000_000, fee_msat: 100_000, purse_msat: 100_000_000, purse_used_msat: 0, kits_per_day: 2, kits_today: 0 }),
    sponsorOffer: () => {
      const card = sampleIntroduction(SAMPLE_OWN_ID, 'node.example.org:9735', 'public', 10_000);
      return ok({ ...card, starter: { gift_msat: 20_000_000, expires_at: card.expires_at }, offer_link: `${card.link}.SAMPLEOFFER` });
    },
    sponsorCandidate: (request) =>
      request.trim().startsWith('bitsov://sponsor-request#')
        ? ok({ intro_id: 'ab'.repeat(16), newcomer: SAMPLE_STRANGER_ID, payment_hash: 'cd'.repeat(32), gift_msat: 20_000_000, fee_max_msat: 100_000, code: '482913', expires_at: Math.floor(Date.now() / 1000) + 540 })
        : Promise.reject('That is not a starter-bitcoin request (bitsov://sponsor-request#…).'),
    sponsorOwnerApproval: (_candidate, code) =>
      code === '482913'
        ? ok({ owner_command: '# Sample only: no real gift request or owner command.' })
        : Promise.reject({ code: 'sponsor_code_mismatch', message: 'The code does not match this request. Nothing was paid.' }),
    sponsorReconcile: () => ok(undefined),
    sponsorCancel: () => ok(undefined),
    sponsorRequest: (text) =>
      text.includes('SAMPLEOFFER')
        ? ok<FundingAsk>({ request: 'bitsov://sponsor-request#SAMPLE', code: '482913', sponsor: SAMPLE_STRANGER_ID, amount_msat: 20_000_000, payment_hash: 'ef'.repeat(32), expires_at: Math.floor(Date.now() / 1000) + 540 })
        : Promise.reject('This introduction offers no starter bitcoin.'),
    sponsorRequestStatus: (hash) => ok({ payment_hash: hash, state: 'received' as const, amount_msat: 20_000_000 }),
    firstContactRequest: async () => null,
    firstContactStatus: async () => { throw new Error('Sample data has no independent owner request.'); },
    firstContactCancel: async () => {},
    wallet: () => ok(WALLET),
    spendStatus: () => {
      settleSpend();
      if (spend.state === 'pending' && ++spendPolls >= GRANT_AFTER_POLLS) {
        // The owner's grant opens only what was asked for.
        if (wants.window) openWindow();
        else spend = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
        if (wants.budget !== null) {
          autopay = { until: Date.now() + DAY_MS, ceiling: wants.budget };
          autopayExpired = false;
        }
        wants.window = false;
        wants.budget = null;
      }
      return ok(spend);
    },
    spendRequest: () => {
      settleSpend();
      if (book.paused) return refuse('budget_paused', 'Payments are paused. Resume them first.');
      if (spend.state !== 'open' && spend.state !== 'pending') {
        wants.budget = null;
        requestElevation();
      }
      wants.window = true;
      return ok(spend);
    },
    spendCancel: () => {
      spend = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
      wants.window = false;
      wants.budget = null;
      return ok(spend);
    },
    deviceKeyStatus: () => {
      if (device.state === 'pending' && ++devicePolls >= GRANT_AFTER_POLLS) {
        device = { ...device, state: 'registered', owner_action: null, expires_at_ms: null };
      }
      return ok(device);
    },
    deviceKeyRegister: () => {
      devicePolls = 0;
      device = {
        available: true,
        state: 'pending',
        fingerprint: '3F9A-12C4-77B0-E51D',
        owner_action: 'konsensus device approve --op 7c2e91d04b5a3f6e8d1c0b2a --config /Users/you/bitsov/konsensus.toml',
        expires_at_ms: Date.now() + 15 * 60_000,
      };
      return ok(device);
    },
    deviceKeyCancel: () => {
      device = { available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null };
      return ok(device);
    },
    relationApprove: () => {
      if (device.state !== 'registered') return refuse('device_not_registered', 'Set up Touch ID approvals first.');
      if (book.paused) return refuse('budget_paused', 'Payments are paused. Resume them first.');
      openWindow();
      return ok(spend);
    },
    spendLock: () => {
      spend = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
      wants.window = false;
      wants.budget = null;
      return ok(spend);
    },
    budgetStatus: () => ok(budgetView()),
    budgetApprove: (ceilingMsat, preset) => {
      if (book.paused) return refuse('budget_paused', 'Payments are paused. Resume them first.');
      if (ceilingMsat < 1000 || ceilingMsat > MAX_DAILY_MSAT) return refuse('invalid', 'A daily total is between 1 and 100,000 sats.');
      book.preset = preset;
      book.ceiling = ceilingMsat;
      for (const [k, v] of book.limits) book.limits.set(k, Math.min(v, ceilingMsat));
      settleAutopay();
      if (autopay && ceilingMsat <= autopay.ceiling) autopay.ceiling = ceilingMsat;
      else {
        if (spend.state !== 'pending') {
          wants.window = false;
          requestElevation();
        }
        wants.budget = ceilingMsat;
      }
      return ok(budgetView());
    },
    budgetSet: (target, room, limitMsat) => {
      const k = key(target.toLowerCase(), room);
      if (limitMsat === 0) book.limits.delete(k);
      else if (limitMsat > book.ceiling) return refuse('invalid', `That is above your approved daily total of ${fmtAmount(book.ceiling)}. Raise the total first.`);
      else book.limits.set(k, limitMsat);
      return ok(budgetView());
    },
    budgetPause: () => {
      autopay = null;
      book.paused = true;
      spend = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
      wants.window = false;
      wants.budget = null;
      return ok(budgetView());
    },
    budgetResume: () => {
      book.paused = false;
      // Resume is the owner's tap for the total already on the book.
      if (spend.state !== 'pending') requestElevation();
      wants.budget = book.ceiling;
      return ok(budgetView());
    },
    spendReconcile: () => ok('No pending spend.'),
    // The sample never leaves a payment settled but undelivered.
    retry: () => refuse('retry_unavailable', 'Nothing to retry.'),
    dismissUndelivered: () => refuse('retry_unavailable', 'Nothing is waiting for delivery.'),
    send: async (recipient, isRoom, plaintext, maxMsat, _caps, firstContactMsat) => {
      const to = recipient.toLowerCase();
      const confirm = await planSend(to, isRoom, maxMsat, firstContactMsat);
      let amount: number;
      let fee: number;
      if (isRoom) {
        const q = roomQuote(to);
        if (q.unreachable.length > 0) {
          return refuse('room_unreachable', `${q.unreachable.length} member is not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.`);
        }
        fee = q.max_routing_fee_msat ?? 0;
        amount = q.total_msat - fee;
      } else {
        const peer = SAMPLE_PEERS.find((p) => p.node_id === to);
        if (!peer?.connected) {
          return refuse('node', '/messages/compose failed (400): Recipient is offline. Message will be queued and sent when they reconnect.');
        }
        amount = Math.max(peerPrice(to), 1000);
        fee = routingFee(amount);
      }
      if (v2 && !isRoom && to === hex('a') && raised[to] === undefined) {
        raised[to] = 3000;
        return refuse('price_changed', `Maya's price rose to 3 sats, above your ${fmtAmount(maxMsat)} cap. Nothing was dispatched; refresh the quote.`);
      }
      if (amount + fee > maxMsat) return refuse('price_changed', 'Price above confirmed ceiling. Nothing dispatched.');
      if (confirm !== null) book.limits.set(key(to, isRoom), confirm);
      book.ledger.push({ at: Date.now(), target: to, room: isRoom, msat: amount + fee });
      const id = nextId('sent');
      const at = Date.now();
      later(250, { type: 'message', room_id: isRoom ? to : null, message: { id, kind: 0, sender: SAMPLE_OWN_ID, recipient: to, timestamp: at, plaintext, payment_amount_msat: amount } });
      // Gamma's table is stale: it now asks 2 sats, so the 1 sat paid is rejected by its node.
      later(1200, to === hex('d')
        ? { type: 'delivery', message_id: id, status: 'rejected', reason: 'insufficient payment: required 2000 msat, got 1000 msat' }
        : { type: 'delivery', message_id: id, status: 'delivered', reason: null });
      return { message_id: id, recipient: to, is_room: isRoom, delivered: true, amount_msat: amount, total_msat: amount + fee, max_routing_fee_msat: fee, sent_at_ms: at };
    },
    roomQuote: (id) => ok(roomQuote(id.toLowerCase())),
    invoiceCreate: (amountMsat, note) => {
      if (amountMsat < 1000) return refuse('invalid', 'the amount must be between 1 sat and 1 BTC');
      const bolt11 = sampleBolt11(amountMsat);
      issued.set(bolt11, 0);
      return ok({ bolt11, amount_msat: amountMsat, note: note.trim() || null, expires_at_ms: Date.now() + 3600_000 });
    },
    invoiceAmount: (bolt11) => {
      const msat = sampleInvoiceMsat(bolt11);
      if (msat === null) return refuse('invalid', 'This invoice names no amount. The app pays only invoices whose cost it can show first.');
      // Sample invoices are not signed: a fixed sample payee stands in for the host's decode.
      const canonical = bolt11.trim().toLowerCase().replace(/^lightning:/, '');
      return ok({
        amount_msat: msat,
        network: canonical.startsWith('lnbc') ? 'mainnet' : 'sample',
        payee: SAMPLE_PAYEE,
        expires_at_ms: Date.now() + 3600_000,
        bolt11: canonical,
        payment_hash: '00'.repeat(32),
        description: null,
      });
    },
    invoiceStatus: (bolt11) => {
      // A sample invoice made here is paid by the sample payer after a few reads.
      const key = bolt11.trim().toLowerCase();
      if (!issued.has(key)) return ok(invoiceFromNode(502, { error: 'payment not found' }));
      const reads = (issued.get(key) ?? 0) + 1;
      issued.set(key, reads);
      const status = reads >= 3 ? 'Settled' : reads === 2 ? 'InFlight' : 'Pending';
      return ok(invoiceFromNode(200, { payment_hash: '00'.repeat(32), status, amount_msat: sampleInvoiceMsat(key), direction: 'Incoming', liquidity: null }));
    },
    pay: async (bolt11, amountMsat, maxMsat) => {
      await gate();
      if (allIn(amountMsat) > maxMsat) return refuse('price_changed', 'Amount above confirmed ceiling.');
      if (sampleInvoiceMsat(bolt11) !== amountMsat) {
        return refuse('invalid', 'The invoice amount does not match the cost you confirmed. Nothing was paid.');
      }
      await planSend('app:invoice-payments', false, maxMsat, undefined, true);
      book.ledger.push({ at: Date.now(), target: 'app:invoice-payments', room: false, msat: allIn(amountMsat) });
      return { method: 'invoice', amount_msat: amountMsat, max_routing_fee_msat: routingFee(amountMsat), status: 'settled', paid_at_ms: Date.now() };
    },
    keysend: async (_dest, amountMsat, _memo, maxMsat) => {
      await gate();
      if (allIn(amountMsat) > maxMsat) return refuse('price_changed', 'Amount above confirmed ceiling.');
      await planSend('app:keysend-payments', false, maxMsat, undefined, true);
      book.ledger.push({ at: Date.now(), target: 'app:keysend-payments', room: false, msat: allIn(amountMsat) });
      return { method: 'keysend', amount_msat: amountMsat, max_routing_fee_msat: routingFee(amountMsat), status: 'settled', paid_at_ms: Date.now() };
    },
    inviteCreate: async (invitee, _addr, hours) => {
      await gate();
      return { invite_id: nextId('invite'), invite_link: 'bitsov://invite/sample-not-a-real-invite', invitee: invitee.toLowerCase(), expires_at_ms: Date.now() + hours * 3600_000 };
    },
    inviteRedeem: async () => {
      await gate();
      return { inviter_pubkey: hex('b'), addr: '35.204.77.3:9735' };
    },
    filePrice: () => ok({ principal_msat: FILE_PRICE_MSAT, max_routing_fee_msat: 5000, total_msat: FILE_PRICE_MSAT + 5000 }),
    fileSend: async (recipient, filename, mime, dataB64, maxMsat, firstContactMsat) => {
      if (allIn(FILE_PRICE_MSAT) > maxMsat) return refuse('price_changed', 'Price above confirmed ceiling.');
      const target = recipient.toLowerCase();
      // Same budget / window route as messages (not forced-manual like invoice pay).
      const confirm = await planSend(target, false, maxMsat, firstContactMsat);
      if (confirm !== null) book.limits.set(key(target, false), confirm);
      book.ledger.push({ at: Date.now(), target, room: false, msat: allIn(FILE_PRICE_MSAT) });
      const id = nextId('file');
      const pad = (dataB64.match(/=+$/)?.[0].length ?? 0);
      const size_bytes = (dataB64.length / 4) * 3 - pad;
      const blob = { filename, mime_type: mime, size_bytes, data_b64: dataB64 };
      receivedFiles.set(id, blob);
      if (mime.toLowerCase().startsWith('audio/')) voiceNotes.set(id, blob);
      later(1200, { type: 'delivery', message_id: id, status: 'delivered', reason: null });
      return { message_id: id, recipient: recipient.toLowerCase(), filename, size_bytes, delivered: true, amount_msat: FILE_PRICE_MSAT, total_msat: allIn(FILE_PRICE_MSAT), max_routing_fee_msat: routingFee(FILE_PRICE_MSAT), sent_at_ms: Date.now(), accepted: true, state: 'acked' };
    },
    callQuote: () => ok({ offer_msat: 10_000, offer_max_routing_fee_msat: 5000, signal_msat: 1000, signal_max_routing_fee_msat: 5000, call_total_msat: 21_000 }),
    callSignal: () => refuse('invalid', 'Calls need a real node. Sample data cannot ring anyone.'),
    voiceNote: async (messageId) => {
      const note = voiceNotes.get(messageId);
      return note ? note : refuse('invalid', 'voice note not stored on this node');
    },
    fileFetch: async (messageId) => {
      const file = receivedFiles.get(messageId);
      if (!file) return refuse('invalid', 'file not stored on this node');
      if (file.size_bytes > 1_400_000) return refuse('invalid', 'file over 1.4 MB');
      return file;
    },
    fileSave: async (messageId) => {
      const file = receivedFiles.get(messageId);
      if (!file) return refuse('invalid', 'file not stored on this node');
      if (file.size_bytes > 1_400_000) return refuse('invalid', 'file over 1.4 MB');
      // Sample has no native dialog: treat as saved (tests inject their own host).
      const result: FileSaveResult = { saved: true, filename: file.filename, mime_type: file.mime_type, size_bytes: file.size_bytes };
      return result;
    },
    aiRead: async (topic, sinceMs) => {
      await new Promise((r) => setTimeout(r, 350));
      return sampleRead(topic, sinceMs);
    },
    aiProviders: () => ok(SAMPLE_PROVIDERS),
    aiDisclose: async (provider, topic, sinceMs, preset, question) => {
      const remote = SAMPLE_PROVIDERS.find((p) => p.kind === provider && p.enabled && p.host);
      if (!remote) return refuse('invalid', 'That model is off on this computer. Nothing was prepared.');
      const read = sampleRead(topic, sinceMs);
      if (read.state !== 'live') return refuse('node', 'Your node could not be read, so nothing was prepared.');
      const user = {
        question: question.trim().slice(0, 500),
        topic,
        shared: preset,
        freshness: { state: read.freshness.state, age_seconds: read.freshness.age_ms === null ? null : Math.floor(read.freshness.age_ms / 1000), node_stale: read.freshness.node_stale },
        data: read.outputs.map((o) => sampleNarrow(o, preset)),
      };
      const body = JSON.stringify(
        { model: remote.model, temperature: 0, messages: [{ role: 'system', content: SAMPLE_SYSTEM }, { role: 'user', content: JSON.stringify(user, null, 2) }] },
        null,
        2,
      );
      const id = `sample${(sent++).toString(16).padStart(26, '0')}`;
      disclosures.set(id, { topic, preset });
      return { id, provider, label: remote.label, host: remote.host!, model: remote.model!, preset, body, bytes: new TextEncoder().encode(body).length, key_env: null, expires_in_ms: 300_000 } satisfies Disclosure;
    },
    aiSend: async (id) => {
      const held = disclosures.get(id);
      disclosures.delete(id);
      if (!held) return refuse('invalid', 'That preview expired or was already used. Nothing was sent.');
      await new Promise((r) => setTimeout(r, 600));
      const remote = SAMPLE_PROVIDERS[1];
      return { provider: remote.kind, label: remote.label, host: remote.host!, model: remote.model!, text: sampleRemoteText(held.topic, held.preset), sent_bytes: 0 } satisfies RemoteAnswer;
    },
    aiCancel: (id) => ok(disclosures.delete(id)),
    aiLocalStatus: async () => ok({ ...SAMPLE_LOCAL_STATUS }),
    aiLocalSelect: async () =>
      refuse('invalid', SAMPLE_LOCAL_STATUS.howto),
    aiLocalClear: () => ok(SAMPLE_PROVIDERS.map((p) => ({ ...p }))),
    liveLink: () => {
      live?.({ type: 'link', state: 'open', detail: null });
      return ok(live ? ('open' as const) : null);
    },
    onLive: (handler) => {
      live = handler;
      let i = 0;
      const emit = () => {
        const [from, text] = LIVE_LINES[i++ % LIVE_LINES.length];
        if (v2) {
          // The node reports its gate decision first, then delivers the message.
          const admitted: MembraneEvent = {
            seq: knocks.length + i + 1000,
            at: Date.now(),
            direction: 'inbound',
            verdict: 'admitted',
            code: 'settled',
            kind: 0,
            counterparty: from,
            first_contact: !SAMPLE_PEERS.some((p) => p.node_id === from),
            required_msat: null,
            paid_msat: from === hex('a') ? 2000 : 1000,
            cap_msat: null,
          };
          knocks = [admitted, ...knocks].slice(0, 500);
          handler({ type: 'membrane', event: admitted });
        }
        const event: LiveEvent = {
          type: 'message',
          message: { ...msg(from, SAMPLE_OWN_ID, 0, text, from === hex('a') ? 2000 : 1000), timestamp: Date.now() },
          room_id: null,
        };
        handler(event);
      };
      handler({ type: 'link', state: 'open', detail: null });
      let interval: ReturnType<typeof setInterval> | undefined;
      const first = setTimeout(() => {
        emit();
        interval = setInterval(emit, liveEvery);
      }, firstLive);
      return Promise.resolve(() => {
        live = null;
        clearTimeout(first);
        if (interval) clearInterval(interval);
      });
    },
  };
}
