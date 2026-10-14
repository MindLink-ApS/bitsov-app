/**
 * Mesh meetings of up to 4 (regtest prototype). A meeting is nothing but a set
 * of ordinary 1:1 calls ("legs") that share a meeting id and a fixed roster
 * `[host, ...invitees]`. The participant earlier in the roster places, and
 * pays for, each leg: the host rings everyone, the first invitee rings the
 * later ones, and so on. Every pair therefore has exactly one payer and two
 * people never ring each other at once. Each signal is the 1:1 `call_signal`:
 * the offer pays the callee's call price once, answers and hangups pay the
 * realtime price, all through the same budget, approval and journaled
 * exactly-once path, one paid signal at a time. The node refuses a leg out of
 * roster order before anything is paid.
 *
 * Media: full mesh, one RTCPeerConnection per leg sharing one capture. STUN
 * only if the owner set one; no relay, so nothing is billed per minute.
 */
import {
  CALL_ANSWER, CALL_HANGUP, CALL_ICE, CALL_OFFER, CONNECT_TIMEOUT_MS, DISCONNECT_GRACE_MS, GATHER_MS, RING_MS,
  callCost, gathered, newCallId, parseSignal, signalCost,
  type CallDeps, type CallMedia, type Signal,
} from './call';
import type { CallQuote, Message } from './types';

/** Host included. The node refuses a bigger roster. */
export const MAX_PARTICIPANTS = 4;
const NODE_ID = /^[0-9a-f]{64}$/;
const MEETING_ID = /^[0-9a-f]{32}$/;

/** A roster the node accepts: 2 to 4 distinct lowercase node ids. */
export function validRoster(roster: unknown): roster is string[] {
  return Array.isArray(roster)
    && roster.length >= 2 && roster.length <= MAX_PARTICIPANTS
    && roster.every((id) => typeof id === 'string' && NODE_ID.test(id))
    && new Set(roster).size === roster.length;
}

/** What inviting costs at most: each invitee's call ceiling (offer and one hangup). */
export function inviteCost(quotes: (CallQuote | null)[]): number | null {
  let total = 0;
  for (const q of quotes) {
    const c = q ? callCost(q) : null;
    if (c === null) return null;
    total += c;
  }
  return total;
}

/**
 * What joining costs at most: an answer and a hangup to each earlier
 * participant, a call (offer and hangup) to each later one.
 */
export function joinCost(roster: string[], own: string, quotes: Record<string, CallQuote | null>): number | null {
  const me = roster.indexOf(own);
  if (me < 0) return null;
  let total = 0;
  for (const [i, peer] of roster.entries()) {
    if (i === me) continue;
    const q = quotes[peer];
    if (!q) return null;
    const c = i < me ? 2 * signalCost(q) : callCost(q);
    if (c === null) return null;
    total += c;
  }
  return total;
}

/**
 * The quote a leg may pay under: the one the owner was shown, capped by the
 * live one. `null` when the live price is higher than what was shown (the leg
 * is refused, nothing paid) or when no price was shown at all.
 */
export function boundQuote(shown: CallQuote | null | undefined, live: CallQuote, offer: boolean): CallQuote | null {
  if (!shown) return null;
  if (offer && (shown.offer_msat === null || live.offer_msat === null || live.offer_msat > shown.offer_msat)) return null;
  if (live.signal_msat > shown.signal_msat) return null;
  const min = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.min(a, b));
  return {
    offer_msat: min(shown.offer_msat, live.offer_msat),
    offer_max_routing_fee_msat: Math.min(shown.offer_max_routing_fee_msat, live.offer_max_routing_fee_msat),
    signal_msat: Math.min(shown.signal_msat, live.signal_msat),
    signal_max_routing_fee_msat: Math.min(shown.signal_max_routing_fee_msat, live.signal_max_routing_fee_msat),
    call_total_msat: min(shown.call_total_msat, live.call_total_msat),
  };
}

/** What declining costs at most: one hangup per ringing leg, at the shown price. */
export function declineCost(view: MeetingView, quotes: Record<string, CallQuote | null>): number | null {
  let total = 0;
  for (const l of view.legs.filter((x) => x.state === 'incoming')) {
    const q = quotes[l.peer];
    if (!q) return null;
    total += signalCost(q);
  }
  return total;
}

/** Shown quotes, by lowercase node id. */
export type ShownQuotes = Record<string, CallQuote | null>;

const NEEDS_UPDATE = 'Their node needs an update for meetings. Nothing was paid.';
const RAISED = 'Their call price went up since it was shown. Nothing was paid; start again to see the new price.';

/**
 * One leg as the owner sees it. `waiting`: not rung yet (ours to place once we
 * join, or theirs when they join); `nolink`: this pair has no leg (refused,
 * not a contact, no call price); the rest of the meeting goes on.
 */
export type LegState = 'waiting' | 'placing' | 'ringing' | 'incoming' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'nolink';

export type LegView = { peer: string; state: LegState; outgoing: boolean; paidMsat: number; error: string | null };

export type MeetingPhase = 'idle' | 'invited' | 'active' | 'ended';

export type MeetingView = {
  phase: MeetingPhase;
  id: string | null;
  roster: string[];
  media: CallMedia;
  /** One per other participant, in roster order. */
  legs: LegView[];
  /** msat this side paid for the meeting's signals, all-in as reported. */
  paidMsat: number;
  muted: boolean;
  camera: boolean;
  /** Why it ended, when not a plain leave. */
  error: string | null;
};

export const MEETING_IDLE: MeetingView = {
  phase: 'idle', id: null, roster: [], media: 'audio', legs: [], paidMsat: 0, muted: false, camera: false, error: null,
};

export type MeetingDeps = Pick<CallDeps, 'quote' | 'signal' | 'getUserMedia' | 'peerConnection' | 'newCallId' | 'iceServers'> & {
  ownId: () => string;
  /**
   * Both nodes take meeting legs (their node advertises `call_meeting_v1`
   * and so does ours). A node without it withdraws a meeting leg after it
   * was paid, so a leg to anyone else is refused here, before any quote.
   */
  canMeet: (peer: string) => boolean;
  onView: (v: MeetingView) => void;
  onStreams: (local: MediaStream | null, remote: Record<string, MediaStream>) => void;
  /** A 1:1 call holds the mic: a meeting invite rings out. */
  busy?: () => boolean;
  newMeetingId?: () => string;
};

type Leg = {
  peer: string;
  outgoing: boolean;
  state: LegState;
  callId: string | null;
  pc: RTCPeerConnection | null;
  remote: MediaStream | null;
  offerSdp: string | null;
  quote: CallQuote | null;
  videoSender: RTCRtpSender | null;
  paidMsat: number;
  error: string | null;
  timer?: ReturnType<typeof setTimeout>;
  drop?: ReturnType<typeof setTimeout>;
};

const terminal = (l: Leg) => l.state === 'ended' || l.state === 'nolink';

export type MeetingEngine = ReturnType<typeof createMeetingEngine>;

export function createMeetingEngine(deps: MeetingDeps) {
  let view: MeetingView = MEETING_IDLE;
  let legs: Leg[] = [];
  let local: MediaStream | null = null;
  let joined = false;
  let inviteTimer: ReturnType<typeof setTimeout> | undefined;
  // The quotes the owner saw on Invite/Join: every leg pays at most these.
  let shown: ShownQuotes = {};
  // Bumped whenever a meeting starts or ends: stale async work stops there.
  let epoch = 0;
  // One paid signal at a time (the host allows one journaled spend at a time).
  let queue: Promise<unknown> = Promise.resolve();
  // Serialises the owner's actions: a double click never pays twice.
  let busy = false;

  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const guarded = async (run: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  };

  const active = () => view.phase === 'invited' || view.phase === 'active';
  const publish = () => {
    view = {
      ...view,
      legs: legs.map((l) => ({ peer: l.peer, state: l.state, outgoing: l.outgoing, paidMsat: l.paidMsat, error: l.error })),
      paidMsat: legs.reduce((s, l) => s + l.paidMsat, 0),
    };
    deps.onView(view);
  };
  const streams = () =>
    deps.onStreams(local, Object.fromEntries(legs.filter((l) => l.remote).map((l) => [l.peer, l.remote!])));

  const closeLeg = (l: Leg, state: 'ended' | 'nolink', error: string | null = null) => {
    clearTimeout(l.timer);
    clearTimeout(l.drop);
    l.pc?.close();
    l.pc = null;
    l.remote = null;
    l.videoSender = null;
    l.offerSdp = null;
    l.state = state;
    if (error) l.error = error;
  };
  const finish = (error: string | null = null) => {
    epoch += 1;
    clearTimeout(inviteTimer);
    legs.forEach((l) => { if (!terminal(l)) closeLeg(l, 'ended'); });
    stopAll(local);
    local = null;
    joined = false;
    view = { ...view, phase: 'ended', error };
    publish();
    streams();
  };
  // Once joined, the meeting is over when no leg can carry media any more.
  const settle = () => {
    if (active() && joined && legs.every(terminal)) finish();
    else {
      publish();
      streams();
    }
  };

  const start = (id: string, roster: string[], media: CallMedia, host: boolean) => {
    epoch += 1;
    const own = roster.indexOf(deps.ownId().toLowerCase());
    legs = roster.flatMap((peer, i) => i === own ? [] : [{
      peer, outgoing: i > own, state: 'waiting' as LegState, callId: null, pc: null, remote: null,
      offerSdp: null, quote: null, videoSender: null, paidMsat: 0, error: null,
    }]);
    joined = host;
    view = { ...MEETING_IDLE, phase: host ? 'active' : 'invited', id, roster, media, camera: media === 'video' };
    publish();
  };

  const stopAll = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());
  /**
   * The shared capture. If the meeting ended (or another began) while the
   * device was opening, the fresh stream is stopped at once and never kept.
   */
  const capture = async () => {
    if (local) return local;
    const e = epoch;
    const stream = await deps.getUserMedia({ audio: true, video: view.media === 'video' });
    if (e !== epoch || !active()) {
      stopAll(stream);
      throw new Error('the meeting ended');
    }
    if (local) {
      stopAll(stream);
      return local;
    }
    local = stream;
    streams();
    return local;
  };

  const connect = (l: Leg, stream: MediaStream) => {
    const conn = deps.peerConnection({ iceServers: deps.iceServers?.() ?? [] });
    l.pc = conn;
    stream.getTracks().forEach((t) => {
      const sender = conn.addTrack(t, stream);
      if (t.kind === 'video') l.videoSender = sender ?? null;
    });
    conn.ontrack = (e) => {
      l.remote = e.streams[0] ?? new MediaStream([e.track]);
      streams();
    };
    const changed = (state: string) => {
      if (l.pc !== conn) return;
      if (state === 'connected') {
        clearTimeout(l.drop);
        l.drop = undefined;
        clearTimeout(l.timer);
        if (l.state !== 'live') {
          l.state = 'live';
          publish();
        }
      } else if (state === 'disconnected') {
        // A blip may come back; a vanished peer ends this leg only (nothing paid).
        // Said as it is meanwhile; the one grace is armed once per drop, by whichever signal comes first.
        if (l.state === 'live') {
          l.state = 'reconnecting';
          publish();
        }
        if (l.drop === undefined) {
          l.drop = setTimeout(() => {
            if (l.pc === conn) {
              closeLeg(l, 'ended', 'The connection was lost.');
              settle();
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === 'failed' || state === 'closed') {
        closeLeg(l, 'ended', 'The direct connection failed.');
        settle();
      }
    };
    conn.onconnectionstatechange = () => changed(conn.connectionState);
    // WKWebView may report ICE failure before the aggregate connection state:
    // the same path as the aggregate one (no new timer, nothing paid).
    conn.oniceconnectionstatechange = () => {
      const state = conn.iceConnectionState;
      if (state === 'failed' || state === 'disconnected') changed(state);
      else if ((state === 'connected' || state === 'completed') && conn.connectionState === 'connected') changed('connected');
    };
    return conn;
  };

  const awaitConnect = (l: Leg, conn: RTCPeerConnection) => {
    clearTimeout(l.timer);
    l.timer = setTimeout(() => {
      if (l.pc === conn && l.state === 'connecting') {
        closeLeg(l, 'ended', 'The call could not connect.');
        settle();
      }
    }, CONNECT_TIMEOUT_MS);
  };

  const pay = async (l: Leg, kind: number, body: Omit<Signal, 'v' | 'call_id'>, maxMsat: number) => {
    const r = await deps.signal(l.peer, kind, JSON.stringify({ v: 1, call_id: l.callId!, ...body }), maxMsat);
    if (r.ok) l.paidMsat += r.value.total_msat;
    return r;
  };

  /** Ring a later participant: one offer at their call price, with the roster. */
  const placeLeg = (l: Leg, e: number) => serial(async () => {
    if (e !== epoch || l.state !== 'waiting') return;
    if (!deps.canMeet(l.peer)) {
      closeLeg(l, 'nolink', NEEDS_UPDATE);
      settle();
      return;
    }
    l.state = 'placing';
    l.error = null;
    publish();
    const q = await deps.quote(l.peer);
    if (e !== epoch || l.state !== 'placing') return;
    if (!q.ok || q.value.offer_msat === null) {
      closeLeg(l, 'nolink', q.ok ? 'Their node does not take calls. Nothing was paid.' : q.error.message);
      settle();
      return;
    }
    const bound = boundQuote(shown[l.peer], q.value, true);
    if (!bound) {
      closeLeg(l, 'nolink', RAISED);
      settle();
      return;
    }
    l.quote = bound;
    let conn: RTCPeerConnection;
    try {
      const stream = await capture();
      if (e !== epoch) return;
      conn = connect(l, stream);
      await conn.setLocalDescription(await conn.createOffer());
      await gathered(conn, GATHER_MS);
    } catch {
      if (e !== epoch) return;
      closeLeg(l, 'nolink', 'Microphone not available. Nothing was paid.');
      settle();
      return;
    }
    if (e !== epoch || l.state !== 'placing') return;
    l.callId = (deps.newCallId ?? newCallId)();
    const r = await pay(l, CALL_OFFER, { media: view.media, sdp: conn.localDescription!.sdp, meeting: { id: view.id!, roster: view.roster } },
      bound.offer_msat! + bound.offer_max_routing_fee_msat);
    // Left while the offer was in flight: the mic is already off; nothing more is sent.
    if (e !== epoch || l.state !== 'placing') {
      publish();
      return;
    }
    if (!r.ok) {
      closeLeg(l, 'nolink', r.error.message);
      settle();
      return;
    }
    l.state = 'ringing';
    publish();
    l.timer = setTimeout(() => {
      if (l.state === 'ringing') {
        closeLeg(l, 'ended', 'No answer.');
        settle();
      }
    }, RING_MS);
  });

  /** Answer an earlier participant's leg: one answer at the realtime price. */
  const answerLeg = (l: Leg, e: number) => serial(async () => {
    if (e !== epoch || l.state !== 'incoming' || !l.offerSdp) return;
    clearTimeout(l.timer);
    l.state = 'connecting';
    publish();
    const q = await deps.quote(l.peer);
    if (e !== epoch || l.state !== 'connecting') return;
    if (!q.ok) {
      closeLeg(l, 'nolink', q.error.message);
      settle();
      return;
    }
    const bound = boundQuote(shown[l.peer], q.value, false);
    if (!bound) {
      closeLeg(l, 'nolink', RAISED);
      settle();
      return;
    }
    l.quote = bound;
    let conn: RTCPeerConnection;
    try {
      const stream = await capture();
      if (e !== epoch) return;
      conn = connect(l, stream);
      await conn.setRemoteDescription({ type: 'offer', sdp: l.offerSdp! });
      await conn.setLocalDescription(await conn.createAnswer());
      await gathered(conn, GATHER_MS);
    } catch {
      if (e !== epoch) return;
      closeLeg(l, 'nolink', 'Microphone not available. Nothing was paid.');
      settle();
      return;
    }
    if (e !== epoch || l.state !== 'connecting') return;
    const r = await pay(l, CALL_ANSWER, { sdp: conn.localDescription!.sdp }, signalCost(bound));
    if (e !== epoch) {
      publish();
      return;
    }
    if (!r.ok) {
      closeLeg(l, 'nolink', r.error.message);
      settle();
      return;
    }
    if (l.state === 'connecting') awaitConnect(l, conn);
    publish();
  });

  return {
    view: () => view,
    active,

    /**
     * Invite 1 to 3 contacts. `quotes` are the prices the owner was shown:
     * each leg pays at most that (and at most the live price); a leg whose
     * live price went up is refused before anything is paid.
     */
    invite: (peers: string[], media: CallMedia, quotes: ShownQuotes) => guarded(async () => {
      if (active() || deps.busy?.()) return;
      const own = deps.ownId().toLowerCase();
      const invitees = [...new Set(peers.map((p) => p.toLowerCase()))].filter((p) => p !== own);
      const roster = [own, ...invitees];
      if (!validRoster(roster)) {
        view = { ...MEETING_IDLE, phase: 'ended', error: 'A meeting is you and 1 to 3 contacts. Nothing was paid.' };
        publish();
        return;
      }
      const id = deps.newMeetingId?.() ?? newCallId();
      start(id, roster, media, true);
      shown = { ...quotes };
      const e = epoch;
      await Promise.all(legs.map((l) => placeLeg(l, e)));
      if (e === epoch) settle();
    }),

    /**
     * Join the meeting we were invited to (the price was shown): answer every
     * ringing leg, then ring the later participants. Legs that ring after this
     * are answered without another click: joining was the consent, and their
     * price was in the Join ceiling.
     */
    join: (quotes: ShownQuotes) => guarded(async () => {
      if (view.phase !== 'invited') return;
      shown = { ...quotes };
      clearTimeout(inviteTimer);
      joined = true;
      view = { ...view, phase: 'active' };
      publish();
      const e = epoch;
      const work = legs.map((l) => {
        if (l.state === 'incoming') return answerLeg(l, e);
        if (l.outgoing) return placeLeg(l, e);
        if (l.state === 'waiting') {
          // An earlier participant who has not joined yet rings us when they do;
          // their own invite stops ringing within this window.
          l.timer = setTimeout(() => {
            if (l.state === 'waiting') {
              closeLeg(l, 'nolink', 'They did not join.');
              settle();
            }
          }, RING_MS);
        }
        return undefined;
      });
      await Promise.all(work);
      if (e === epoch) settle();
    }),

    /**
     * Decline: one paid hangup per ringing leg, so nobody keeps ringing, each
     * at most the shown price. (Ignoring is free: the invite ends by itself.)
     */
    decline: (quotes: ShownQuotes) => guarded(async () => {
      if (view.phase !== 'invited') return;
      const ringing = legs.filter((l) => l.state === 'incoming');
      finish('Declined');
      for (const l of ringing) {
        await serial(async () => {
          const q = await deps.quote(l.peer);
          const bound = q.ok ? boundQuote(quotes[l.peer], q.value, false) : null;
          if (bound) await pay(l, CALL_HANGUP, { reason: 'declined' }, signalCost(bound));
        });
      }
      publish();
    }),

    /**
     * Leave: media stops at once; then one paid hangup per leg the other side
     * knows about (a paid offer or answer of ours). A leg still being placed
     * is cancelled and pays nothing more. The others stay connected.
     */
    leave: async () => {
      if (view.phase !== 'active') return;
      const known = legs.filter((l) => !terminal(l) && l.state !== 'placing');
      finish();
      for (const l of known) {
        await serial(async () => {
          if (l.paidMsat > 0 && l.quote && l.callId) await pay(l, CALL_HANGUP, { reason: 'hangup' }, signalCost(l.quote));
        });
      }
      publish();
    },

    /** End without paying anything (the window is closing). Their legs time out. */
    endLocal: () => {
      if (active()) finish();
    },

    dismiss: () => {
      if (view.phase === 'ended') {
        stopAll(local);
        local = null;
        legs.forEach((l) => l.pc?.close());
        legs = [];
        view = MEETING_IDLE;
        deps.onView(view);
      }
    },

    toggleMute: () => {
      if (!local) return;
      const muted = !view.muted;
      local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      view = { ...view, muted };
      publish();
    },

    /** Camera off stops the camera (light off) on every leg; on captures it again. */
    toggleCamera: async () => {
      const stream = local;
      if (!stream || view.media !== 'video') return;
      if (view.camera) {
        stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
        await Promise.all(legs.map((l) => l.videoSender?.replaceTrack(null)));
        view = { ...view, camera: false };
        publish();
        streams();
        return;
      }
      let fresh: MediaStream;
      try {
        fresh = await deps.getUserMedia({ video: true });
      } catch {
        view = { ...view, error: 'Camera not available.' };
        publish();
        return;
      }
      const track = fresh.getVideoTracks()[0];
      fresh.getTracks().forEach((t) => { if (t !== track) t.stop(); });
      if (!track || local !== stream) { track?.stop(); return; }
      stream.addTrack(track);
      await Promise.all(legs.map((l) => l.videoSender?.replaceTrack(track)));
      view = { ...view, camera: true, error: null };
      publish();
      streams();
    },

    /** A 400-403 the node forwarded (already paid, and admitted by its call rules). */
    receive: async (m: Message, ownId: string) => {
      const own = ownId.toLowerCase();
      const peer = m.sender.toLowerCase();
      if (peer === own) return;
      const s = parseSignal(m.kind, m.plaintext);
      if (!s) return;
      if (m.kind === CALL_OFFER) {
        const mt = s.meeting;
        if (!mt || typeof mt.id !== 'string' || !MEETING_ID.test(mt.id) || !validRoster(mt.roster)) return;
        const from = mt.roster.indexOf(peer);
        const me = mt.roster.indexOf(own);
        // Only an earlier participant rings us (the node checks this too).
        if (from < 0 || me < 0 || from >= me) return;
        if (!active()) {
          // On a 1:1 call: let it ring out rather than pay to say so.
          if (deps.busy?.()) return;
          start(mt.id, mt.roster, s.media!, false);
          // Not joined in time: it ends here, nothing paid.
          inviteTimer = setTimeout(() => { if (view.phase === 'invited') finish('No answer'); }, RING_MS);
        } else if (view.id !== mt.id || view.roster.join() !== mt.roster.join()) {
          return;
        }
        const l = legs.find((x) => x.peer === peer);
        // One leg per peer per meeting.
        if (!l || l.outgoing || l.state !== 'waiting') return;
        clearTimeout(l.timer);
        l.state = 'incoming';
        l.callId = s.call_id;
        l.offerSdp = s.sdp!;
        l.timer = setTimeout(() => {
          if (l.state === 'incoming') {
            closeLeg(l, 'ended', 'No answer.');
            settle();
          }
        }, RING_MS);
        publish();
        if (joined) void answerLeg(l, epoch);
        return;
      }
      if (!active()) return;
      const l = legs.find((x) => x.peer === peer && x.callId === s.call_id);
      if (!l) return;
      switch (m.kind) {
        case CALL_ANSWER: {
          const conn = l.pc;
          if (!l.outgoing || l.state !== 'ringing' || !conn) return;
          clearTimeout(l.timer);
          l.state = 'connecting';
          publish();
          awaitConnect(l, conn);
          try {
            await conn.setRemoteDescription({ type: 'answer', sdp: s.sdp! });
          } catch {
            closeLeg(l, 'ended', 'Their answer could not be used.');
            settle();
          }
          return;
        }
        case CALL_ICE:
          if (l.pc) await l.pc.addIceCandidate({ candidate: s.candidate!, sdpMid: s.sdp_mid ?? null, sdpMLineIndex: s.sdp_mline_index ?? null }).catch(() => undefined);
          return;
        default:
          if (!terminal(l)) {
            closeLeg(l, 'ended', s.reason === 'declined' ? 'Declined.' : null);
            settle();
          }
      }
    },
  };
}
