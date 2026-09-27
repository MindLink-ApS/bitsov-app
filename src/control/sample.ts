// Dev-mode sample data: the whole shell clickable with no node running. Nothing
// here reaches a network or the host. The sample deposit address is not valid
// bech32 on purpose, so it cannot receive funds by mistake.

import type { NodeStatus, PairingView } from '../onboarding/pairing';
import type { Source } from './source';
import type { FundState, LiveEvent, Message, Peer, PriceQuote, Room, WalletOverview } from './types';

const hex = (c: string) => c.repeat(64);
export const SAMPLE_OWN_ID = '3f9a' + '1'.repeat(56) + 'c0de';
export const SAMPLE_PEERS: Peer[] = [
  { node_id: hex('a'), addr: '34.90.12.8:9735', label: 'Maya', connected: true, fingerprint: 'aaaaaaaa' },
  { node_id: hex('b'), addr: '35.204.77.3:9735', label: 'Josh', connected: true, fingerprint: 'bbbbbbbb' },
  { node_id: hex('c'), addr: '34.141.2.19:9735', label: null, connected: false, fingerprint: 'cccccccc' },
  { node_id: hex('d'), addr: '34.32.90.40:9735', label: 'Gamma VM', connected: false, fingerprint: 'dddddddd' },
];
export const SAMPLE_ROOM_ID = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
export const SAMPLE_ROOMS: Room[] = [
  { id: SAMPLE_ROOM_ID, name: 'Mexico build', created_by: SAMPLE_OWN_ID, created_at: '2026-09-20T09:00:00Z' },
];
const ROOM_MEMBERS = [SAMPLE_OWN_ID, hex('a'), hex('b')];

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
    roomMembers: (id) => ok(id === SAMPLE_ROOM_ID ? ROOM_MEMBERS : []),
    messages: (peer) => ok(THREADS[peer.toLowerCase()] ?? []),
    priceQuote: (peer) =>
      ok({ kind: 0, own_msat: 1000, ...(PRICE_TABLES[peer ?? ''] ?? { peer_msat: null, peer_age_secs: null, peer_stale: false }) }),
    wallet: () => ok(WALLET),
    onLive: (handler) => {
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
        clearTimeout(first);
        if (interval) clearInterval(interval);
      });
    },
  };
}
