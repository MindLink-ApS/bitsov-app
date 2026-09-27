// Where the shell's data comes from: the Rust host (Tauri commands + the
// `node-live` event), or sample data in dev mode. The renderer never talks to
// the node directly — no socket, no HTTP, no token (Gate G2). Every node call
// is a host command.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NodeStatus, PairingView } from '../onboarding/pairing';
import type {
  FundingAddress,
  FundState,
  LiveEvent,
  Message,
  NodeOverview,
  Peer,
  PriceQuote,
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
  wallet(): Promise<WalletOverview>;
  /** Subscribe to live events; resolves to an unsubscribe. */
  onLive(handler: (event: LiveEvent) => void): Promise<() => void>;
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
  wallet: () => invoke<WalletOverview>('payments_overview'),
  onLive: (handler) => listen<LiveEvent>(LIVE_EVENT, (e) => handler(e.payload)),
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
