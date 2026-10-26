/**
 * Node-routed call audio engine (M6 A1): the renderer half of the media path
 * app -> own node -> peer node -> peer app.
 *
 * Capture: the microphone stream (echo cancellation and noise suppression
 * requested by the engine's getUserMedia constraints) is cut into 20 ms
 * frames by an AudioWorklet, encoded, and handed to `transport.send` as one
 * payload per frame. The Rust host adds the wire `seq` and owns the socket.
 *
 * Playout: each received frame is decoded here and posted, with its `seq`, to
 * the playout AudioWorklet, whose jitter buffer (60-120 ms, adaptive)
 * reorders, conceals loss and drops late frames on the audio thread.
 *
 * Codec: Opus through WebCodecs where the webview has it (and the peer said
 * it decodes Opus), otherwise G.711 mu-law in pure TypeScript. Both apps
 * learn each other's codecs from in-band HELLO frames.
 *
 * Webviews without AudioWorklet fall back to a ScriptProcessorNode for
 * capture and scheduled AudioBufferSourceNodes for playout, with the same
 * jitter buffer on the main thread.
 */
import workletUrl from './callAudioWorklet.ts?worker&url';
import { CAP_OPUS, CAP_PCMU, audioPayload, chooseCodec, decodeFrame, helloPayload, parsePayload, type Codec } from './mediaFrame';
import { decodeMuLaw, encodeMuLaw, PCMU_RATE } from './g711';
import { Framer, frameSamples, resample } from './pcm';
import { JitterBuffer, type JitterStats } from './jitterBuffer';
import { CAPTURE_PROCESSOR, PLAYOUT_PROCESSOR, type CaptureMessage, type PlayoutMessage, type PlayoutReport } from './callAudioShared';

export const OPUS_RATE = 48_000;
export const OPUS_BITRATE = 24_000;
/** Microseconds per 20 ms frame: the WebCodecs timestamp unit. */
const FRAME_US = 20_000;
/** Re-offer our codecs every second until the peer has answered. */
const HELLO_INTERVAL_MS = 1_000;

export type MediaTransport = { send: (payload: Uint8Array) => void };

export type CallAudioDeps = {
  stream: MediaStream;
  transport: MediaTransport;
  /** Test seam: builds the AudioContext (defaults to the webview's). */
  audioContext?: (options: AudioContextOptions) => AudioContext;
  workletUrl?: string;
  /** Test seam: `false` forces the mu-law path even where WebCodecs exists. */
  opus?: boolean;
  onError?: (message: string) => void;
};

export type CallAudio = {
  /** Resolves once capture and playout are wired; rejects when no audio graph could be built. */
  ready: Promise<void>;
  /** One downlink frame as the host delivered it: seq + payload. */
  feed: (frame: Uint8Array) => void;
  setMuted: (muted: boolean) => void;
  /** The codec this app sends with right now, and what each side offered. */
  codecs: () => { sending: Codec; localCaps: number; peerCaps: number | null };
  stats: () => Promise<JitterStats | null>;
  close: () => Promise<void>;
};

type Encoder = { encode: (pcm: Float32Array) => void; close: () => void };
type Decoder = { decode: (seq: number, data: Uint8Array) => void; close: () => void };

const webCodecs = () => typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' && typeof AudioData !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';

async function opusSupported(): Promise<boolean> {
  if (!webCodecs()) return false;
  try {
    const config = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: OPUS_BITRATE };
    const [encoder, decoder] = await Promise.all([AudioEncoder.isConfigSupported(config), AudioDecoder.isConfigSupported(config)]);
    return encoder.supported === true && decoder.supported === true;
  } catch {
    return false;
  }
}

export function createCallAudio(deps: CallAudioDeps): CallAudio {
  const makeContext = deps.audioContext ?? ((options: AudioContextOptions) => new AudioContext(options));
  let context: AudioContext | null = null;
  let closed = false;
  let muted = false;
  let localCaps = CAP_PCMU;
  let peerCaps: number | null = null;
  let sending: Codec = 'pcmu';
  let encoder: Encoder | null = null;
  let decoder: Decoder | null = null;
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  const cleanups: (() => void)[] = [];
  /** Where decoded frames go: the playout worklet, or the main-thread fallback. */
  let playFrame: (seq: number, pcm: Float32Array) => void = () => {};
  let playMarker: (seq: number) => void = () => {};
  let readStats: () => Promise<JitterStats | null> = async () => null;

  const fail = (message: string) => deps.onError?.(message);
  const send = (payload: Uint8Array) => { if (!closed) deps.transport.send(payload); };
  const sayHello = () => send(helloPayload(localCaps));

  /** One captured 20 ms frame at the context rate. */
  const captured = (pcm: Float32Array) => {
    if (closed || !context) return;
    const frame = muted ? new Float32Array(pcm.length) : pcm;
    sending = chooseCodec(localCaps, peerCaps);
    if (sending === 'opus' && encoder) {
      encoder.encode(frame);
      return;
    }
    send(audioPayload('pcmu', encodeMuLaw(resample(frame, context.sampleRate, PCMU_RATE))));
  };

  const makeOpus = (rate: number): { encoder: Encoder; decoder: Decoder } => {
    let frames = 0;
    const audioEncoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        send(audioPayload('opus', bytes));
      },
      error: () => { encoder = null; localCaps &= ~CAP_OPUS; },
    });
    audioEncoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE });
    const audioDecoder = new AudioDecoder({
      output: (audio) => {
        try {
          const pcm = new Float32Array(audio.numberOfFrames);
          audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          const seq = Math.round(audio.timestamp / FRAME_US) >>> 0;
          playFrame(seq, audio.sampleRate === rate ? pcm : resample(pcm, audio.sampleRate, rate));
        } finally {
          audio.close();
        }
      },
      error: () => { decoder = null; },
    });
    audioDecoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1 });
    return {
      encoder: {
        encode: (pcm) => {
          if (audioEncoder.state !== 'configured') return;
          // A fresh copy: WebCodecs wants a plain ArrayBuffer-backed view, and the worklet's buffer may be reused.
          const samples = new Float32Array(pcm);
          const data = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: samples.length, numberOfChannels: 1, timestamp: frames++ * FRAME_US, data: samples });
          try { audioEncoder.encode(data); } finally { data.close(); }
        },
        close: () => { try { audioEncoder.close(); } catch { /* already closed */ } },
      },
      decoder: {
        decode: (seq, data) => {
          if (audioDecoder.state !== 'configured') return;
          audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: seq * FRAME_US, data }));
        },
        close: () => { try { audioDecoder.close(); } catch { /* already closed */ } },
      },
    };
  };

  /** AudioWorklet capture and playout: the normal path. */
  const buildWorklet = async (ctx: AudioContext, source: MediaStreamAudioSourceNode) => {
    await ctx.audioWorklet.addModule(deps.workletUrl ?? workletUrl);
    const capture = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(capture).connect(sink).connect(ctx.destination);
    capture.port.onmessage = (event: MessageEvent<CaptureMessage>) => { if (event.data.type === 'frame') captured(event.data.pcm); };
    const playout = new AudioWorkletNode(ctx, PLAYOUT_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    playout.connect(ctx.destination);
    const post = (message: PlayoutMessage, transfer: Transferable[] = []) => playout.port.postMessage(message, transfer);
    playFrame = (seq, pcm) => post({ type: 'frame', seq, pcm }, [pcm.buffer]);
    playMarker = (seq) => post({ type: 'marker', seq });
    readStats = () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 500);
      playout.port.onmessage = (event: MessageEvent<PlayoutReport>) => { clearTimeout(timer); resolve(event.data.stats); };
      post({ type: 'stats' });
    });
    cleanups.push(() => {
      capture.port.onmessage = null;
      playout.port.onmessage = null;
      try { source.disconnect(); capture.disconnect(); sink.disconnect(); playout.disconnect(); } catch { /* graph already gone */ }
    });
  };

  /** Older webviews: ScriptProcessorNode capture, scheduled buffers for playout. */
  const buildFallback = (ctx: AudioContext, source: MediaStreamAudioSourceNode) => {
    const size = frameSamples(ctx.sampleRate);
    const framer = new Framer(size);
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      for (const frame of framer.push(event.inputBuffer.getChannelData(0))) captured(frame);
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor).connect(sink).connect(ctx.destination);
    const jitter = new JitterBuffer<Float32Array>();
    let nextAt = 0;
    const frameSeconds = size / ctx.sampleRate;
    const tick = () => {
      // Keep up to three frames scheduled ahead of the clock.
      while (nextAt < ctx.currentTime + 3 * frameSeconds) {
        if (nextAt < ctx.currentTime) nextAt = ctx.currentTime;
        const pulled = jitter.pull();
        if (pulled.frame) {
          const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
          buffer.getChannelData(0).set(pulled.frame);
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(ctx.destination);
          node.start(nextAt);
        }
        nextAt += frameSeconds;
      }
    };
    const timer = setInterval(tick, 10);
    playFrame = (seq, pcm) => { jitter.insert(seq, pcm); };
    playMarker = (seq) => { jitter.insert(seq, null); };
    readStats = async () => jitter.stats();
    cleanups.push(() => {
      clearInterval(timer);
      processor.onaudioprocess = null;
      try { source.disconnect(); processor.disconnect(); sink.disconnect(); } catch { /* graph already gone */ }
    });
  };

  const ready = (async () => {
    const ctx = makeContext({ sampleRate: OPUS_RATE, latencyHint: 'interactive' });
    context = ctx;
    await ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(deps.stream);
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') await buildWorklet(ctx, source);
    else buildFallback(ctx, source);
    if (deps.opus !== false && ctx.sampleRate === OPUS_RATE && await opusSupported()) {
      try {
        const opus = makeOpus(ctx.sampleRate);
        encoder = opus.encoder;
        decoder = opus.decoder;
        localCaps |= CAP_OPUS;
      } catch {
        encoder = null;
        decoder = null;
      }
    }
    if (closed) return;
    sayHello();
    helloTimer = setInterval(() => { if (peerCaps === null) sayHello(); else { clearInterval(helloTimer); helloTimer = undefined; } }, HELLO_INTERVAL_MS);
  })();
  ready.catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  return {
    ready,
    feed: (bytes) => {
      if (closed) return;
      const frame = decodeFrame(bytes);
      if (!frame) return;
      const payload = parsePayload(frame.payload);
      if (!payload) return;
      if (payload.type === 'hello') {
        const first = peerCaps === null;
        peerCaps = payload.caps;
        playMarker(frame.seq);
        // They may have missed ours: answer the first HELLO once.
        if (first) sayHello();
        return;
      }
      if (payload.codec === 'pcmu') {
        if (!context) return;
        playFrame(frame.seq, resample(decodeMuLaw(payload.data), PCMU_RATE, context.sampleRate));
      } else if (decoder) {
        decoder.decode(frame.seq, payload.data);
      } else {
        // Opus without a decoder here: no audio for this slot, but no gap either.
        playMarker(frame.seq);
      }
    },
    setMuted: (next) => { muted = next; },
    codecs: () => ({ sending, localCaps, peerCaps }),
    stats: () => readStats(),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(helloTimer);
      helloTimer = undefined;
      await ready.catch(() => undefined);
      for (const cleanup of cleanups.splice(0)) cleanup();
      encoder?.close();
      decoder?.close();
      encoder = null;
      decoder = null;
      const ctx = context;
      context = null;
      if (ctx) await ctx.close().catch(() => undefined);
    },
  };
}
