/**
 * Node-routed call video (flag `VITE_CALL_VIDEO`): the renderer half of the path
 * camera -> encoder -> fragments -> own node -> peer node -> peer app ->
 * reassembly -> decoder -> canvas. It rides the same media socket as the audio
 * and never touches the audio engine. **Both nodes can read this video**; the
 * call card says so.
 *
 * Negotiation is in band and repeated until answered: nothing is captured for
 * sending or sent until the peer's VIDEO_HELLO says which codecs it decodes, so
 * a peer without video never receives a video byte beyond the hello, which it
 * ignores. Each direction uses H.264 if both sides can, otherwise VP8.
 *
 * A receiver that lost a frame shows the last good picture and asks for a key
 * frame until one comes. A sender whose host queue backs up, or whose receiver
 * reports loss or a queue building on the path, skips frames and steps down;
 * below the lowest step video pauses and audio carries on. Nothing that goes
 * wrong here ends the call.
 */
import {
  CODEC_H264, CODEC_VP8, Reassembler, VIDEO_FRAGMENT, VIDEO_HELLO, VIDEO_KEY_REQUEST, VIDEO_REPORT, VIDEO_STATE,
  MAX_INNER_BYTES, encodeInner, fragmentFrame, helloBody, parseFragment, parseHello, parseInner, parseReport, parseState, reportBody, stateBody,
  type AssembledFrame, type ReassemblerStats, type VideoCodecId,
} from './videoFrame';
import { DEPTH_HIGH, TIER_DEFAULT, TIER_HIGH, VideoRateController, pacerLimits, tierForLimits, type RateDecision, type VideoStep, type VideoTier } from './videoRate';
import { SEQ_BYTES } from './mediaFrame';

const HELLO_INTERVAL_MS = 1_000;
const REPORT_INTERVAL_MS = 1_000;
/** While waiting for a key frame, ask again this often. */
const KEY_REQUEST_INTERVAL_MS = 500;
/** How often a missing frame is checked for: loss shows within the gap timeout plus this. */
const HOUSEKEEPING_MS = 100;
/** A sender answers key frame requests at most this often. */
export const KEY_MIN_INTERVAL_MS = 1_000;
/** How long the host's queue must stay backed up before the ladder steps down: longer than one key frame, and than the host holding video while audio catches up. */
export const BACKLOG_STEP_DOWN_MS = 2_000;
/** Hellos unanswered before the card says the other side takes no video. */
const HELLOS_BEFORE_GIVING_UP = 5;
/** Raw frames the encoder may have waiting before the next one is skipped. */
const ENCODER_QUEUE_MAX = 2;
/** Encoded frames the decoder may have waiting before a key frame is needed instead. */
const DECODER_QUEUE_MAX = 8;
/** How far behind its arrival audio plays: the jitter buffer's 60 ms start, and the output. */
export const AUDIO_PLAYOUT_DELAY_MS = 70;
/** Longest a decoded picture is held back to line up with the audio. */
const MAX_HOLD_MS = 150;
/** Report windows the lowest arrival delay is remembered over: a minute. */
const DELAY_FLOOR_WINDOWS = 60;
/** Decoded pictures waiting for their time; past this the oldest goes undrawn. */
const MAX_RENDER_QUEUE = 8;
/** Frames the arrival-delay floor is measured over. */
const OFFSET_WINDOW = 64;

export const CODEC_STRINGS: Record<number, string> = {
  [CODEC_H264]: 'avc1.42E01F',
  [CODEC_VP8]: 'vp8',
};

export type VideoTransport = {
  /** One video payload to the host. Resolves to how many fragments wait to leave, when it knows. */
  send: (payload: Uint8Array) => Promise<number | void> | number | void;
};

/** Where captured pictures come from: a camera track in the app, a canvas in tests. */
export type VideoSource = {
  /** The current picture, scaled to `step`; null when there is none yet. The caller closes it. */
  grab: (step: VideoStep, timestampUs: number) => VideoFrame | null;
  close: () => void;
};

export type VideoStatus = {
  /** The peer said it takes video; null until it says anything. */
  peerVideo: boolean | null;
  peerCamera: boolean;
  /** This side stopped sending: the connection can't keep up. */
  sendingPaused: boolean;
  /** The other side stopped sending for the same reason. */
  peerPaused: boolean;
  /** No codec here can do this: audio carries on without video. */
  failed: boolean;
};

export type CallVideoStats = {
  captured: number;
  encoded: number;
  encodedKey: number;
  skipped: number;
  sentFragments: number;
  sentBytes: number;
  keyRequestsSent: number;
  keyRequestsReceived: number;
  decoded: number;
  rendered: number;
  decodeErrors: number;
  reassembly: ReassemblerStats;
  step: VideoStep | null;
  codec: string | null;
  stepChanges: number;
};

export type CallVideo = {
  ready: Promise<void>;
  /** One downlink frame on the video path as the host delivered it: seq + payload. */
  feed: (frame: Uint8Array) => void;
  /** Camera on or off. Off stops capture and tells the peer. */
  setSource: (source: VideoSource | null) => void;
  /** The node link dropped and came back: what was in flight is gone. */
  linkReset: () => void;
  /** What this side's node allows, from its handshake: it decides the tier this side offers. */
  setNodeLimits: (limits: { messages: number; bytes: number }) => void;
  stats: () => CallVideoStats;
  status: () => VideoStatus;
  close: () => void;
};

type Rendering = { frame: VideoFrame; captureMs: number; due: number };

export type CallVideoDeps = {
  transport: VideoTransport;
  source: VideoSource | null;
  /** Draws decoded pictures. */
  canvas: HTMLCanvasElement;
  /** Test seam: milliseconds on a clock both directions read the same way. */
  now?: () => number;
  /** How far behind the audio plays: pictures are held back this long, up to a limit. */
  audioDelayMs?: () => number;
  onStatus?: (status: VideoStatus) => void;
  /** Test seam: called with each rendered picture before it is closed. */
  onRender?: (frame: VideoFrame, captureMs: number, now: number) => void;
};

const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';

function encoderConfig(codec: VideoCodecId, step: VideoStep): VideoEncoderConfig {
  const config: VideoEncoderConfig = { codec: CODEC_STRINGS[codec], width: step.width, height: step.height, framerate: step.fps, bitrate: step.bitrate, latencyMode: 'realtime' };
  // Annex B keeps the parameter sets in band, so a key frame alone starts a decoder.
  if (codec === CODEC_H264) config.avc = { format: 'annexb' };
  return config;
}

/** Which codecs this webview can encode and decode, as bit masks of `CODEC_*`. */
export async function localVideoCodecs(step: VideoStep): Promise<{ encodes: number; decodes: number }> {
  if (!hasWebCodecs()) return { encodes: 0, decodes: 0 };
  let encodes = 0;
  let decodes = 0;
  for (const codec of [CODEC_H264, CODEC_VP8] as const) {
    try {
      if ((await VideoEncoder.isConfigSupported(encoderConfig(codec, step))).supported) encodes |= codec;
      if ((await VideoDecoder.isConfigSupported({ codec: CODEC_STRINGS[codec] })).supported) decodes |= codec;
    } catch { /* This codec is out; the other may still work. */ }
  }
  return { encodes, decodes };
}

/** The codec for one direction: H.264 if the far side decodes it, else VP8. */
export function chooseVideoCodec(encodes: number, peerDecodes: number): VideoCodecId | null {
  const both = encodes & peerDecodes;
  if (both & CODEC_H264) return CODEC_H264;
  if (both & CODEC_VP8) return CODEC_VP8;
  return null;
}

export function createCallVideo(deps: CallVideoDeps): CallVideo {
  const now = deps.now ?? (() => performance.timeOrigin + performance.now());
  /** This side's node, until its handshake says more. */
  let tier: VideoTier = TIER_DEFAULT;
  let peerTier: VideoTier = TIER_DEFAULT;
  const rate = new VideoRateController(TIER_DEFAULT, now());
  const reassembler = new Reassembler();
  const timers: ReturnType<typeof setInterval>[] = [];
  let closed = false;
  let source = deps.source;
  let streamSeq = 0;
  let controlSeq = 0;
  let localEncodes = 0;
  let localDecodes = 0;
  let peerHello = false;
  let peerDecodes = 0;

  let encoder: VideoEncoder | null = null;
  let sendCodec: VideoCodecId | null = null;
  let configured: VideoStep | null = null;
  let frameId = 0;
  let captureTimer: ReturnType<typeof setInterval> | undefined;
  let wantKey = true;
  let lastKeyAt = -Infinity;
  let hostDepth = 0;
  let backlogSince: number | null = null;
  const started = now();
  const captureAt = new Map<number, number>();

  let decoder: VideoDecoder | null = null;
  let decoderCodec = 0;
  let lastKeyRequestAt = -Infinity;
  let offsets: number[] = [];
  const renderQueue: Rendering[] = [];
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let windowDelay = Infinity;
  const delayFloors: number[] = [];
  let lastLost = 0;
  let lastComplete = 0;

  const status: VideoStatus = { peerVideo: null, peerCamera: true, sendingPaused: false, peerPaused: false, failed: false };
  const stats = { captured: 0, encoded: 0, encodedKey: 0, skipped: 0, sentFragments: 0, sentBytes: 0, keyRequestsSent: 0, keyRequestsReceived: 0, decoded: 0, rendered: 0, decodeErrors: 0, stepChanges: 0 };

  const publish = () => deps.onStatus?.({ ...status });

  /** What the host says is waiting. One key frame can fill the queue for a moment; only a lasting backlog counts. */
  const heardDepth = (depth: number) => {
    hostDepth = depth;
    if (depth <= DEPTH_HIGH) backlogSince = null;
    else backlogSince ??= now();
  };

  const sendRaw = (payload: Uint8Array) => {
    if (closed) return;
    try {
      const result = deps.transport.send(payload);
      if (typeof result === 'number') heardDepth(result);
      else if (result) void result.then((depth) => { if (typeof depth === 'number') heardDepth(depth); }, () => undefined);
    } catch { /* The next frame tries again; the link's state is the connection's concern. */ }
  };
  const sendControl = (type: number, body: Uint8Array) => sendRaw(encodeInner(type, controlSeq++, body));
  const sayHello = () => sendControl(VIDEO_HELLO, helloBody({ decodes: localDecodes, tier }));
  const sayState = () => sendControl(VIDEO_STATE, stateBody({ camera: source !== null, paused: rate.isPaused() }));

  const closeEncoder = () => {
    clearInterval(captureTimer);
    captureTimer = undefined;
    if (encoder) try { encoder.close(); } catch { /* already closed */ }
    encoder = null;
    configured = null;
  };

  const encoderFailed = () => {
    closeEncoder();
    if (!status.failed) {
      status.failed = true;
      publish();
    }
  };

  const onEncoded = (chunk: EncodedVideoChunk) => {
    if (closed || sendCodec === null) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    stats.encoded++;
    if (key) stats.encodedKey++;
    const captureMs = captureAt.get(chunk.timestamp) ?? now();
    captureAt.delete(chunk.timestamp);
    let payloads: Uint8Array[];
    try {
      payloads = fragmentFrame({ frameId: frameId >>> 0, key, codec: sendCodec, captureMs: Math.floor(captureMs) % 0x1_0000_0000, data }, streamSeq);
    } catch {
      // Too big to carry: the next frame must be a key frame again, at a lower step.
      apply(rate.onBackpressure(now()));
      wantKey = true;
      return;
    }
    frameId = (frameId + 1) >>> 0;
    streamSeq += payloads.length;
    for (const payload of payloads) {
      stats.sentFragments++;
      stats.sentBytes += payload.length;
      sendRaw(payload);
    }
  };

  const configure = (step: VideoStep) => {
    if (sendCodec === null) return;
    try {
      if (!encoder) {
        encoder = new VideoEncoder({ output: (chunk) => onEncoded(chunk), error: () => encoderFailed() });
      }
      encoder.configure(encoderConfig(sendCodec, step));
      configured = step;
      wantKey = true;
    } catch {
      encoderFailed();
    }
  };

  const capture = () => {
    if (closed || !source || !encoder) return;
    const step = configured;
    if (!step || encoder.state !== 'configured') return;
    if (encoder.encodeQueueSize > ENCODER_QUEUE_MAX) { stats.skipped++; return; }
    const at = now();
    if (hostDepth > DEPTH_HIGH) {
      stats.skipped++;
      if (backlogSince !== null && at - backlogSince >= BACKLOG_STEP_DOWN_MS) {
        backlogSince = at;
        apply(rate.onBackpressure(at));
      }
      // Skipped frames send nothing, so the host can't answer: assume it drains at the pacer's rate until it next can.
      const pacer = pacerLimits(tier);
      hostDepth = Math.max(0, hostDepth - pacer.bytes_per_second / MAX_INNER_BYTES / step.fps);
      return;
    }
    const timestamp = Math.round((at - started) * 1000);
    const frame = source.grab(step, timestamp);
    if (!frame) return;
    stats.captured++;
    const key = wantKey && at - lastKeyAt >= KEY_MIN_INTERVAL_MS;
    captureAt.set(timestamp, at);
    if (captureAt.size > 64) captureAt.delete(captureAt.keys().next().value as number);
    try {
      encoder.encode(frame, { keyFrame: key });
      if (key) {
        wantKey = false;
        lastKeyAt = at;
      }
    } catch {
      encoderFailed();
    } finally {
      frame.close();
    }
  };

  const startCapture = (step: VideoStep) => {
    clearInterval(captureTimer);
    captureTimer = setInterval(capture, 1000 / step.fps);
  };

  const apply = (decision: RateDecision) => {
    if (!decision.changed) return;
    stats.stepChanges++;
    if (decision.paused || !decision.step) {
      clearInterval(captureTimer);
      captureTimer = undefined;
      status.sendingPaused = true;
      publish();
      sayState();
      return;
    }
    if (status.sendingPaused) {
      status.sendingPaused = false;
      publish();
      sayState();
    }
    if (source) {
      configure(decision.step);
      startCapture(decision.step);
    }
  };

  /** Start or stop sending to match what we know now. */
  const reconsider = () => {
    if (closed || status.failed) return;
    const step = rate.step();
    if (!source || !peerHello || !step) {
      clearInterval(captureTimer);
      captureTimer = undefined;
      return;
    }
    const codec = chooseVideoCodec(localEncodes, peerDecodes);
    if (codec === null) {
      closeEncoder();
      return;
    }
    if (codec !== sendCodec) {
      closeEncoder();
      sendCodec = codec;
    }
    if (!configured) configure(step);
    if (encoder && !captureTimer) startCapture(configured ?? step);
  };

  // ---- the receiving half ----

  const askForKey = (at: number) => {
    if (at - lastKeyRequestAt < KEY_REQUEST_INTERVAL_MS) return;
    lastKeyRequestAt = at;
    stats.keyRequestsSent++;
    sendControl(VIDEO_KEY_REQUEST, new Uint8Array(0));
  };

  const draw = (next: { frame: VideoFrame; captureMs: number }) => {
    try {
      const canvas = deps.canvas;
      if (canvas.width !== next.frame.displayWidth || canvas.height !== next.frame.displayHeight) {
        canvas.width = next.frame.displayWidth;
        canvas.height = next.frame.displayHeight;
      }
      canvas.getContext('2d')?.drawImage(next.frame, 0, 0);
      stats.rendered++;
      deps.onRender?.(next.frame, next.captureMs, now());
    } finally {
      next.frame.close();
    }
  };

  /** Each picture has its time; when several are due only the newest is worth drawing. */
  const flushRender = () => {
    renderTimer = undefined;
    const at = now();
    let latest: Rendering | null = null;
    while (renderQueue.length > 0 && renderQueue[0].due <= at) {
      latest?.frame.close();
      latest = renderQueue.shift() as Rendering;
    }
    if (latest) draw(latest);
    scheduleRender();
  };

  const scheduleRender = () => {
    if (renderTimer !== undefined || renderQueue.length === 0) return;
    renderTimer = setTimeout(flushRender, Math.max(0, renderQueue[0].due - now()));
  };

  const onDecoded = (frame: VideoFrame) => {
    if (closed) { frame.close(); return; }
    stats.decoded++;
    const captureMs = frame.timestamp / 1000;
    const at = now();
    const floor = offsets.length ? Math.min(...offsets) : at - captureMs;
    const hold = Math.min(MAX_HOLD_MS, Math.max(0, captureMs + floor + (deps.audioDelayMs?.() ?? 0) - at));
    renderQueue.push({ frame, captureMs, due: at + hold });
    if (renderQueue.length > MAX_RENDER_QUEUE) (renderQueue.shift() as Rendering).frame.close();
    if (hold <= 0 && renderQueue.length === 1) {
      flushRender();
      return;
    }
    scheduleRender();
  };

  const makeDecoder = (codec: number): VideoDecoder | null => {
    const name = CODEC_STRINGS[codec];
    if (!name) return null;
    try {
      const made = new VideoDecoder({
        output: onDecoded,
        error: () => {
          stats.decodeErrors++;
          if (decoder === made) decoder = null;
          decoderCodec = 0;
          reassembler.reset();
          askForKey(now());
        },
      });
      made.configure({ codec: name, optimizeForLatency: true });
      return made;
    } catch {
      return null;
    }
  };

  const decode = (frame: AssembledFrame) => {
    if (frame.key && (!decoder || decoderCodec !== frame.codec)) {
      if (decoder) try { decoder.close(); } catch { /* already closed */ }
      decoder = makeDecoder(frame.codec);
      decoderCodec = decoder ? frame.codec : 0;
    }
    if (!decoder) return;
    if (decoder.decodeQueueSize > DECODER_QUEUE_MAX && !frame.key) {
      // Falling behind: this picture can't be decoded without the one skipped, so wait for a key frame.
      reassembler.reset();
      askForKey(now());
      return;
    }
    windowDelay = Math.min(windowDelay, frame.arrivedAt - frame.captureMs);
    offsets.push(frame.arrivedAt - frame.captureMs);
    if (offsets.length > OFFSET_WINDOW) offsets = offsets.slice(-OFFSET_WINDOW);
    try {
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: Math.round(frame.captureMs * 1000), data: frame.data }));
    } catch {
      stats.decodeErrors++;
      reassembler.reset();
      askForKey(now());
    }
  };

  /**
   * The last window's lowest arrival delay above the lowest of the last minute.
   * Frames that come late without being lost say a queue is building somewhere
   * on the path, in TCP buffers no one can reorder, and audio waits in it too.
   */
  const takeQueueDelay = () => {
    const low = windowDelay;
    windowDelay = Infinity;
    if (low === Infinity) return 0;
    delayFloors.push(low);
    if (delayFloors.length > DELAY_FLOOR_WINDOWS) delayFloors.shift();
    return low - Math.min(...delayFloors);
  };

  const onHousekeeping = () => {
    if (closed) return;
    const at = now();
    for (const frame of reassembler.expire(at)) decode(frame);
    const seen = reassembler.stats();
    // Before the first picture there is nothing to recover; the sender starts with a key frame.
    if (seen.waitingForKey && (seen.complete > 0 || seen.pending > 0 || seen.lost > 0 || seen.discarded > 0)) askForKey(at);
  };

  const sendReport = () => {
    const seen = reassembler.stats();
    const delayMs = takeQueueDelay();
    sendControl(VIDEO_REPORT, reportBody({ complete: seen.complete - lastComplete, lost: seen.lost - lastLost, waitingForKey: seen.waitingForKey, delayMs }));
    lastComplete = seen.complete;
    lastLost = seen.lost;
  };

  const feed = (bytes: Uint8Array) => {
    if (closed || bytes.length <= SEQ_BYTES) return;
    const inner = parseInner(bytes.subarray(SEQ_BYTES));
    if (!inner) return;
    const at = now();
    switch (inner.type) {
      case VIDEO_FRAGMENT: {
        const fragment = parseFragment(inner.body);
        if (!fragment) return;
        for (const frame of reassembler.insert(fragment, at)) decode(frame);
        if (reassembler.stats().waitingForKey && !fragment.key) askForKey(at);
        return;
      }
      case VIDEO_HELLO: {
        const hello = parseHello(inner.body);
        if (!hello) return;
        const first = !peerHello;
        peerHello = true;
        peerDecodes = hello.decodes;
        if (status.peerVideo !== (hello.decodes !== 0)) {
          status.peerVideo = hello.decodes !== 0;
          publish();
        }
        peerTier = (hello.tier === TIER_HIGH ? TIER_HIGH : TIER_DEFAULT);
        apply(rate.setTier(Math.min(tier, peerTier) as VideoTier, at));
        // They may have missed ours: answer the first once.
        if (first) { sayHello(); sayState(); }
        reconsider();
        return;
      }
      case VIDEO_KEY_REQUEST:
        stats.keyRequestsReceived++;
        wantKey = true;
        return;
      case VIDEO_REPORT: {
        const report = parseReport(inner.body);
        if (report) apply(rate.onReport(report.complete, report.lost, at, report.delayMs));
        return;
      }
      case VIDEO_STATE: {
        const state = parseState(inner.body);
        if (state && (status.peerCamera !== state.camera || status.peerPaused !== state.paused)) {
          status.peerCamera = state.camera;
          status.peerPaused = state.paused;
          publish();
        }
        return;
      }
      default:
    }
  };

  const ready = (async () => {
    const codecs = await localVideoCodecs(rate.step() as VideoStep);
    if (closed) return;
    localEncodes = codecs.encodes;
    localDecodes = codecs.decodes;
    if (codecs.encodes === 0 && codecs.decodes === 0) {
      status.failed = true;
      publish();
    }
    sayHello();
    let hellos = 0;
    timers.push(setInterval(() => {
      if (peerHello) return;
      sayHello();
      // An app without video never answers; a late answer still turns video on.
      if (++hellos === HELLOS_BEFORE_GIVING_UP && status.peerVideo === null) {
        status.peerVideo = false;
        publish();
      }
    }, HELLO_INTERVAL_MS));
    timers.push(setInterval(() => {
      if (peerHello) sendReport();
      apply(rate.tick(now()));
    }, REPORT_INTERVAL_MS));
    timers.push(setInterval(onHousekeeping, HOUSEKEEPING_MS));
    reconsider();
  })();

  return {
    ready,
    feed,
    setSource: (next) => {
      if (closed) return;
      const previous = source;
      source = next;
      if (previous && previous !== next) previous.close();
      if (!next) {
        clearInterval(captureTimer);
        captureTimer = undefined;
      } else {
        wantKey = true;
      }
      sayState();
      reconsider();
    },
    setNodeLimits: (limits) => {
      if (closed) return;
      const next = tierForLimits(limits);
      if (next === tier) return;
      tier = next;
      // The peer takes the lower of the two, so it needs to hear this.
      sayHello();
      apply(rate.setTier(Math.min(tier, peerTier) as VideoTier, now()));
    },
    linkReset: () => {
      delayFloors.length = 0;
      windowDelay = Infinity;
      reassembler.reset();
      lastKeyRequestAt = -Infinity;
      wantKey = true;
    },
    stats: () => ({ ...stats, reassembly: reassembler.stats(), step: rate.step(), codec: sendCodec !== null ? CODEC_STRINGS[sendCodec] : null }),
    status: () => ({ ...status }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      clearTimeout(renderTimer);
      for (const held of renderQueue.splice(0)) held.frame.close();
      closeEncoder();
      if (decoder) try { decoder.close(); } catch { /* already closed */ }
      decoder = null;
      source?.close();
      source = null;
    },
  };
}

/**
 * Pictures from a camera track, through a video element the owner never sees,
 * scaled onto a canvas of the current step's size. WKWebView has no
 * MediaStreamTrackProcessor (checked on macOS 26), so this is the one route.
 */
export function trackVideoSource(track: MediaStreamTrack): VideoSource {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([track]);
  void video.play().catch(() => undefined);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  return {
    grab: (step, timestamp) => {
      if (!context || video.readyState < 2 || video.videoWidth === 0) return null;
      if (canvas.width !== step.width) canvas.width = step.width;
      if (canvas.height !== step.height) canvas.height = step.height;
      // Crop to the step's shape instead of stretching a face.
      const scale = Math.max(step.width / video.videoWidth, step.height / video.videoHeight);
      const width = step.width / scale;
      const height = step.height / scale;
      context.drawImage(video, (video.videoWidth - width) / 2, (video.videoHeight - height) / 2, width, height, 0, 0, step.width, step.height);
      return new VideoFrame(canvas, { timestamp });
    },
    close: () => { video.srcObject = null; },
  };
}
