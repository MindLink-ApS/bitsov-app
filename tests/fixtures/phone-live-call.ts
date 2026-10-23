// Browser-test transport only. The production call engine and shell still own
// state, playback and teardown. No node, microphone, signalling or paid UI action.
import type { CallDeps, createCallEngine } from '../../src/control/call';
export function phoneLiveCall(factory: typeof createCallEngine, deps: CallDeps) {
  class Pc {
    connectionState = 'new'; iceGatheringState = 'complete';
    localDescription: unknown = null;
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    addTrack() { return { replaceTrack: async () => {} }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 fixture' }; }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    async getStats() { return new Map(); }
    addEventListener() {} removeEventListener() {} close() { this.connectionState = 'closed'; }
  }
  const pc = new Pc();
  const stream = new MediaStream();
  const sessions: boolean[] = [];
  const engine = factory({ ...deps,
    authorize: async () => true,
    getUserMedia: async () => stream,
    peerConnection: () => pc as unknown as RTCPeerConnection,
    audioSession: async live => { sessions.push(live); },
    signal: async (_peer, kind) => ({ ok: true, value: {
      message_id: 'fixture-offer', kind, amount_msat: 1000, total_msat: 1000,
      max_routing_fee_msat: 0, delivered: true, accepted: true, sent_at_ms: Date.now(),
    } }),
  });
  (window as any).phoneCall = {
    engine, sessions,
    start: async (peer: string) => {
      await engine.place(peer, 'audio', { offer_msat: 1000, offer_max_routing_fee_msat: 0,
        signal_msat: 1000, signal_max_routing_fee_msat: 0, call_total_msat: 3000 });
      pc.connectionState = 'connected'; pc.onconnectionstatechange?.();
      pc.ontrack?.({ streams: [stream] });
    },
  };
  return engine;
}
