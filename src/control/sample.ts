// Dev-mode sample data: the whole shell clickable with no node running. Nothing
// here reaches a network or the host. The sample deposit address is not valid
// bech32 on purpose, so it cannot receive funds by mistake.

import type { NodeStatus, PairingView } from '../onboarding/pairing';
import type { Source } from './source';
import type {
  ActionError,
  FundState,
  LiveEvent,
  Message,
  Peer,
  PriceQuote,
  Room,
  RoomQuote,
  SpendView,
  WalletOverview,
} from './types';

const hex = (c: string) => c.repeat(64);
export const SAMPLE_OWN_ID = '3f9a' + '1'.repeat(56) + 'c0de';
export const SAMPLE_PEERS: Peer[] = [
  { node_id: hex('a'), addr: '34.90.12.8:9735', label: 'Maya', connected: true, fingerprint: 'aaaaaaaa' },
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
  [hex('b'), 'Heading out, my node stays up.'],
  [hex('a'), 'Did the channel rebalance go through on your side?'],
];

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

const refuse = (code: ActionError['code'], message: string) => Promise.reject<never>({ code, message } satisfies ActionError);

/** The amount in a BOLT 11 prefix, mirroring the host's `bolt11_amount_msat` for sample invoices. */
export function sampleInvoiceMsat(bolt11: string): number | null {
  const m = /^(?:lightning:)?ln(?:bcrt|bc|tbs|tb|sb)(\d*)([munp]?)1/i.exec(bolt11.trim());
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  const per = { '': 100_000_000_000, m: 100_000_000, u: 100_000, n: 100, p: 0.1 }[m[2].toLowerCase() as '' | 'm' | 'u' | 'n' | 'p'];
  return Math.round(n * per);
}

/** A sample invoice: the right prefix and amount, and a body no wallet will accept. */
const sampleBolt11 = (msat: number) =>
  msat % 100 === 0 ? `lntbs${msat / 100}n1samplenotpayable0donotpay` : `lntbs${msat * 10}p1samplenotpayable0donotpay`;

export function sampleSource(opts: { liveEveryMs?: number; firstLiveMs?: number } = {}): Source {
  const liveEvery = opts.liveEveryMs ?? 30_000;
  const firstLive = opts.firstLiveMs ?? 7_000;
  let fund: FundState | null = null;
  let polls = 0;
  const status: NodeStatus = { ready: true, node_id: SAMPLE_OWN_ID, error: null };
  const pairing: PairingView = {
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
    const t = PRICE_TABLES[id];
    return t && !t.peer_stale && t.peer_msat !== null ? t.peer_msat : OWN_PRICE_MSAT;
  };
  const roomQuote = (id: string): RoomQuote => {
    const members = (ROOM_MEMBERS[id] ?? [])
      .filter((m) => m !== SAMPLE_OWN_ID)
      .map((m) => ({
        node_id: m,
        msat: Math.max(peerPrice(m), 1000),
        advertised: !!PRICE_TABLES[m] && !PRICE_TABLES[m].peer_stale,
        connected: SAMPLE_PEERS.some((p) => p.node_id === m && p.connected),
      }));
    return {
      room_id: id,
      members,
      total_msat: members.reduce((sum, m) => sum + m.msat, 0),
      unreachable: members.filter((m) => !m.connected).map((m) => m.node_id),
      estimate: members.some((m) => !m.advertised),
    };
  };
  const later = (ms: number, event: LiveEvent) => setTimeout(() => live?.(event), ms);
  const nextId = (prefix: string) => `${prefix}-${(sent++).toString(16).padStart(4, '0')}`;

  return {
    mode: 'sample',
    nodeStatus: () => ok(status),
    pairingStatus: () => ok(pairing),
    pairingRetry: () => ok(pairing),
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
        lightning_backend: 'ldk',
        chain_backend: 'esplora',
        read_at: Date.now(),
      }),
    peers: () => ok(SAMPLE_PEERS),
    rooms: () => ok(SAMPLE_ROOMS),
    roomMembers: (id) => ok(ROOM_MEMBERS[id.toLowerCase()] ?? []),
    messages: (peer) => ok(THREADS[peer.toLowerCase()] ?? []),
    priceQuote: (peer) =>
      ok({ kind: 0, own_msat: 1000, ...(PRICE_TABLES[peer ?? ''] ?? { peer_msat: null, peer_age_secs: null, peer_stale: false }) }),
    wallet: () => ok(WALLET),
    spendStatus: () => {
      settleSpend();
      if (spend.state === 'pending' && ++spendPolls >= GRANT_AFTER_POLLS) openWindow();
      return ok(spend);
    },
    spendRequest: () => {
      settleSpend();
      if (spend.state !== 'open' && spend.state !== 'pending') {
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
      }
      return ok(spend);
    },
    spendLock: () => {
      spend = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: WINDOW_MS };
      return ok(spend);
    },
    spendReconcile: () => ok('No pending spend.'),
    send: async (recipient, isRoom, plaintext, maxMsat) => {
      await gate();
      const to = recipient.toLowerCase();
      let amount: number;
      if (isRoom) {
        const q = roomQuote(to);
        if (q.unreachable.length > 0) {
          return refuse('room_unreachable', `${q.unreachable.length} member is not a connected peer, so the node would skip them without telling you. Rooms send only when every member is connected.`);
        }
        amount = q.total_msat;
      } else {
        const peer = SAMPLE_PEERS.find((p) => p.node_id === to);
        if (!peer?.connected) {
          return refuse('node', '/messages/compose failed (400): Recipient is offline. Message will be queued and sent when they reconnect.');
        }
        amount = Math.max(peerPrice(to), 1000);
      }
      if (amount > maxMsat) return refuse('price_changed', 'Price above confirmed ceiling. Nothing dispatched.');
      const id = nextId('sent');
      const at = Date.now();
      later(250, { type: 'message', room_id: isRoom ? to : null, message: { id, kind: 0, sender: SAMPLE_OWN_ID, recipient: to, timestamp: at, plaintext, payment_amount_msat: amount } });
      // Gamma's table is stale: it now asks 2 sats, so the 1 sat paid is rejected by its node.
      later(1200, to === hex('d')
        ? { type: 'delivery', message_id: id, status: 'rejected', reason: 'insufficient payment: required 2000 msat, got 1000 msat' }
        : { type: 'delivery', message_id: id, status: 'delivered', reason: null });
      return { message_id: id, recipient: to, is_room: isRoom, delivered: true, amount_msat: amount, sent_at_ms: at };
    },
    roomQuote: (id) => ok(roomQuote(id.toLowerCase())),
    invoiceCreate: (amountMsat, note) =>
      amountMsat < 1000
        ? refuse('invalid', 'the amount must be between 1 sat and 1 BTC')
        : ok({ bolt11: sampleBolt11(amountMsat), amount_msat: amountMsat, note: note.trim() || null, expires_at_ms: Date.now() + 3600_000 }),
    invoiceAmount: (bolt11) => {
      const msat = sampleInvoiceMsat(bolt11);
      if (msat === null) return refuse('invalid', 'This invoice names no amount. The app pays only invoices whose cost it can show first.');
      return ok({ amount_msat: msat, network: bolt11.toLowerCase().startsWith('lnbc') ? 'mainnet' : 'sample' });
    },
    pay: async (bolt11, amountMsat, maxMsat) => {
      await gate();
      if (amountMsat > maxMsat) return refuse('price_changed', 'Amount above confirmed ceiling.');
      if (sampleInvoiceMsat(bolt11) !== amountMsat) {
        return refuse('invalid', 'The invoice amount does not match the cost you confirmed. Nothing was paid.');
      }
      return { method: 'invoice', amount_msat: amountMsat, status: 'settled', paid_at_ms: Date.now() };
    },
    keysend: async (_dest, amountMsat, _memo, maxMsat) => {
      await gate();
      if (amountMsat > maxMsat) return refuse('price_changed', 'Amount above confirmed ceiling.');
      return { method: 'keysend', amount_msat: amountMsat, status: 'settled', paid_at_ms: Date.now() };
    },
    inviteCreate: async (invitee, _addr, hours) => {
      await gate();
      return { invite_id: nextId('invite'), invite_link: 'bitsov://invite/sample-not-a-real-invite', invitee: invitee.toLowerCase(), expires_at_ms: Date.now() + hours * 3600_000 };
    },
    inviteRedeem: async () => {
      await gate();
      return { inviter_pubkey: hex('b'), addr: '35.204.77.3:9735' };
    },
    filePrice: () => ok(FILE_PRICE_MSAT),
    fileSend: async (recipient, filename, _mime, dataB64, maxMsat) => {
      await gate();
      if (FILE_PRICE_MSAT > maxMsat) return refuse('price_changed', 'Price above confirmed ceiling.');
      const id = nextId('file');
      later(1200, { type: 'delivery', message_id: id, status: 'delivered', reason: null });
      const pad = (dataB64.match(/=+$/)?.[0].length ?? 0);
      return { message_id: id, recipient: recipient.toLowerCase(), filename, size_bytes: (dataB64.length / 4) * 3 - pad, delivered: true, amount_msat: FILE_PRICE_MSAT, sent_at_ms: Date.now() };
    },
    onLive: (handler) => {
      live = handler;
      let i = 0;
      const emit = () => {
        const [from, text] = LIVE_LINES[i++ % LIVE_LINES.length];
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
