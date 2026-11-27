/**
 * Node-routed call audio engine (M6 A1): the renderer half of the media path
 * app -> own node -> peer node -> peer app.
 *
 * Capture: the microphone stream (the call asks getUserMedia for plain
 * `audio: true`; echo cancellation and noise suppression are not requested
 * here, so they are whatever the webview defaults to) is cut into 20 ms
 * frames by an AudioWorklet, encoded, and handed to `transport.send` as one
 * payload per frame. The Rust host adds the wire `seq` and owns the socket.
 *
 * Playout: each received frame is decoded here and posted, with its `seq`, to
 * the playout AudioWorklet, whose jitter buffer (60-120 ms, adaptive)
 * reorders, conceals loss and drops late frames on the audio thread.
 *
 * Codec: Opus through WebCodecs where the webview has it (and the peer said
 * it decodes Opus), otherwise G.711 mu-law in pure TypeScript. Both apps
 * learn each other's codecs from in-band HELLO frames. Mu-law runs at 8 kHz:
 * each direction converts to and from the context rate as one continuous
 * stream (`StreamResampler`), so frame edges carry no step.
 *
 * Opus failing mid-call is not fatal: a failed encoder sends mu-law from the
 * next frame; a failed decoder withdraws Opus with a fresh HELLO, which the
 * peer honours on its next frame (it re-chooses the codec per frame). Only
 * when that cannot recover (the peer keeps sending Opus) or the audio graph
 * itself breaks does the engine report a fatal `onError`, and the call ends
 * rather than staying live with silent audio.
 *
 * Webviews without AudioWorklet fall back to a ScriptProcessorNode for
 * capture and scheduled AudioBufferSourceNodes for playout, with the same
 * jitter buffer on the main thread.
 */
import workletUrl from './callAudioWorklet.ts?worker&url';
import { CAP_OPUS, CAP_PCMU, audioPayload, chooseCodec, decodeFrame, helloPayload, parsePayload, type Codec } from './mediaFrame';
import { decodeMuLaw, encodeMuLaw, PCMU_RATE } from './g711';
import { Framer, SequencedResampler, StreamResampler, frameSamples } from './pcm';
import { JitterBuffer, type JitterStats } from './jitterBuffer';
import { AudioStatsRecorder, micSettings, ROW_MS, type AudioStatRow, type HostQueueStats } from './callAudioStats';
import { CAPTURE_PROCESSOR, PLAYOUT_PROCESSOR, PeakLimiter, type CaptureMessage, type PlayoutMessage, type PlayoutReport } from './callAudioShared';

export const OPUS_RATE = 48_000;
export const OPUS_BITRATE = 24_000;
/** Microseconds per 20 ms frame: the WebCodecs timestamp unit. */
const FRAME_US = 20_000;
/** Re-offer our codecs every second until the peer has answered. */
const HELLO_INTERVAL_MS = 1_000;
/** Opus frames we cannot decode: re-send our HELLO every this many (one second)... */
export const OPUS_REHELLO_FRAMES = 50;
/** ...and give up after this many (five seconds): the call ends instead of staying silent. */
export const OPUS_FALLBACK_FRAMES = 250;
/**
 * Captured frames of exact digital zero (ten seconds) before the microphone
 * counts as silenced. A phone OS that silences a hidden app's microphone
 * delivers exact zeros; a live microphone always carries some noise, even in
 * a quiet room or between quiet words.
 */
export const SILENT_FRAMES = 500;

export type MediaTransport = {
  send: (payload: Uint8Array) => void;
  /** Local read of the host's queue drop counts (running totals); null when it cannot say. */
  queueStats?: () => Promise<HostQueueStats | null>;
  /** Where this call's local audio statistics go (see `CallAudioDeps.onStats`). */
  report?: (row: AudioStatRow) => void;
};

export type CallAudioDeps = {
  stream: MediaStream;
  transport: MediaTransport;
  /** Test seam: builds the AudioContext (defaults to the webview's). */
  audioContext?: (options: AudioContextOptions) => AudioContext;
  workletUrl?: string;
  /** Test seam: `false` forces the mu-law path even where WebCodecs exists. */
  opus?: boolean;
  /**
   * Fatal: this engine can no longer carry audio (no graph at start, an
   * audio worklet crashed, or the peer kept sending Opus after we withdrew
   * it). Called at most once; the caller ends the call.
   */
  onError?: (message: string) => void;
  /**
   * The microphone has delivered only digital silence for SILENT_FRAMES
   * (true), or sound again (false). Reported on change only.
   */
  onSilence?: (silent: boolean) => void;
  /**
   * One row of local audio statistics (numbers only) about every five
   * seconds, and a last partial row at close. Defaults to the transport's
   * `report`; without either, nothing is measured.
   */
  onStats?: (row: AudioStatRow) => void;
  /** Test seam: a monotonic clock in milliseconds (defaults to `performance.now`). */
  clock?: () => number;
};

/** A codec as the call report names it. */
export type AudioCodecName = 'opus' | 'mulaw';

/** What carried this call's audio, for the call report. Codec names and a rate only. */
export type CallAudioDiagnostics = {
  /** Codecs this app sent audio with, in the order first used (empty: none sent yet). */
  sent: AudioCodecName[];
  /** Codecs the peer's audio arrived in, in the order first seen. */
  received: AudioCodecName[];
  /** The audio context's real sample rate (Opus needs 48 kHz). */
  contextRate: number | null;
};

const codecName = (codec: Codec): AudioCodecName => (codec === 'opus' ? 'opus' : 'mulaw');

export type CallAudio = {
  /** Resolves once capture and playout are wired; rejects when no audio graph could be built. */
  ready: Promise<void>;
  /** One downlink frame as the host delivered it: seq + payload. */
  feed: (frame: Uint8Array) => void;
  /** The owner's own mute: sends silence, and is no evidence of a silenced microphone. */
  setMuted: (muted: boolean) => void;
  /** The codec this app sends with right now, and what each side offered. */
  codecs: () => { sending: Codec; localCaps: number; peerCaps: number | null };
  /** Which codecs carried audio each way, and the context rate. */
  diagnostics?: () => CallAudioDiagnostics;
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
  let failed = false;
  /** Opus frames received with no decoder to play them. */
  let undecodable = 0;
  const cleanups: (() => void)[] = [];
  /** Where decoded frames go: the playout worklet, or the main-thread fallback. */
  let playFrame: (seq: number, pcm: Float32Array) => void = () => {};
  let playMarker: (seq: number) => void = () => {};
  let readStats: () => Promise<JitterStats | null> = async () => null;
  /** Kept after close, so the call report can still name it. */
  let contextRate: number | null = null;
  const sentCodecs = new Set<AudioCodecName>();
  const receivedCodecs = new Set<AudioCodecName>();
  /** Mu-law uplink: context rate down to 8 kHz, one stream while we keep sending mu-law. */
  let uplink: StreamResampler | null = null;
  let lastSent: Codec | null = null;
  /** Mu-law downlink, and Opus decoded at another rate: one stream per run of consecutive seqs. */
  const pcmuDownlink = new SequencedResampler();
  const opusDownlink = new SequencedResampler();
  const clock = deps.clock ?? (() => performance.now());
  /** Local statistics: only when there is a sink. They read frames the engine already holds. */
  const sink = deps.onStats ?? deps.transport.report;
  const rec = sink ? new AudioStatsRecorder(clock()) : null;
  let rowTimer: ReturnType<typeof setInterval> | undefined;
  let loopTimer: ReturnType<typeof setInterval> | undefined;
  let rowBusy = false;
  const mic = () => micSettings(deps.stream.getAudioTracks?.()[0]);
  const emit = (row: AudioStatRow) => { try { sink?.(row); } catch { /* a sink must not touch the call */ } };
  const bounded = <T,>(read: () => Promise<T | null>): Promise<T | null> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 500);
    read().then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
  const closeRow = async () => {
    if (!rec || closed || failed || rowBusy) return;
    rowBusy = true;
    try {
      const [jitter, host] = await Promise.all([bounded(readStats), deps.transport.queueStats ? bounded(deps.transport.queueStats) : Promise.resolve(null)]);
      if (!closed && !failed) emit(rec.close(clock(), { codec: sending, mic: mic(), jitter, host }));
    } finally { rowBusy = false; }
  };
  /** Decoded audio on its way to playout (measured before the buffer is transferred). */
  const play = (seq: number, pcm: Float32Array) => { rec?.played(pcm); playFrame(seq, pcm); };

  const fail = (message: string) => {
    if (closed || failed) return;
    failed = true;
    // The statistics stop with the audio: no timer is left for the caller's close.
    clearInterval(rowTimer);
    clearInterval(loopTimer);
    rowTimer = undefined;
    loopTimer = undefined;
    deps.onError?.(message);
  };
  const send = (payload: Uint8Array) => { if (!closed) deps.transport.send(payload); };
  const sayHello = () => send(helloPayload(localCaps));

  /** The Opus encoder broke: send mu-law from now on (every peer decodes it). */
  const encoderFailed = () => {
    encoder?.close();
    encoder = null;
  };
  /** The Opus decoder broke: stop offering Opus so the peer switches to mu-law. */
  const decoderFailed = () => {
    if (!decoder) return;
    decoder.close();
    decoder = null;
    localCaps &= ~CAP_OPUS;
    sayHello();
  };

  let zeroFrames = 0;
  let silent = false;
  /** Brings the microphone down to -1 dBFS before encoding; made with the context. */
  let uplinkLimiter: PeakLimiter | null = null;
  /** Count exact-zero frames from the microphone; our own mute is no evidence either way. */
  const listen = (pcm: Float32Array) => {
    if (!deps.onSilence) return;
    let zero = !muted;
    for (let i = 0; zero && i < pcm.length; i++) if (pcm[i] !== 0) zero = false;
    zeroFrames = zero ? zeroFrames + 1 : 0;
    const now = zeroFrames >= SILENT_FRAMES;
    if (now !== silent) {
      silent = now;
      deps.onSilence(now);
    }
  };

  /** One captured 20 ms frame at the context rate. */
  const captured = (pcm: Float32Array) => {
    if (closed || !context) return;
    rec?.captured(pcm);
    listen(pcm);
    // A microphone (or its gain control) driving past full scale is brought
    // down to -1 dBFS before the encoder, which would clip it hard. Measured
    // above (raw), sent limited.
    if (!uplinkLimiter) uplinkLimiter = new PeakLimiter(context.sampleRate);
    const frame = muted ? new Float32Array(pcm.length) : uplinkLimiter.process(pcm);
    sending = encoder ? chooseCodec(localCaps, peerCaps) : 'pcmu';
    if (sending === 'opus' && encoder) {
      try {
        encoder.encode(frame);
        sentCodecs.add('opus');
        lastSent = 'opus';
        return;
      } catch {
        encoderFailed();
        sending = 'pcmu';
      }
    }
    if (!uplink || uplink.from !== context.sampleRate) uplink = new StreamResampler(context.sampleRate, PCMU_RATE);
    // Mu-law (re)starts after Opus frames: what the filter holds is no longer this stream.
    else if (lastSent !== 'pcmu') uplink.reset();
    lastSent = 'pcmu';
    sentCodecs.add('mulaw');
    send(audioPayload('pcmu', encodeMuLaw(uplink.push(frame))));
  };

  const makeOpus = (rate: number): { encoder: Encoder; decoder: Decoder } => {
    let frames = 0;
    const audioEncoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        send(audioPayload('opus', bytes));
      },
      error: () => encoderFailed(),
    });
    audioEncoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE });
    const audioDecoder = new AudioDecoder({
      output: (audio) => {
        try {
          const pcm = new Float32Array(audio.numberOfFrames);
          audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          const seq = Math.round(audio.timestamp / FRAME_US) >>> 0;
          play(seq, opusDownlink.push(seq, pcm, audio.sampleRate, rate));
        } finally {
          audio.close();
        }
      },
      error: () => decoderFailed(),
    });
    audioDecoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1 });
    return {
      encoder: {
        encode: (pcm) => {
          if (audioEncoder.state !== 'configured') throw Object.assign(new Error(), { name: 'OpusEncoderClosed' });
          // A fresh copy: WebCodecs wants a plain ArrayBuffer-backed view, and the worklet's buffer may be reused.
          const samples = new Float32Array(pcm);
          const data = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: samples.length, numberOfChannels: 1, timestamp: frames++ * FRAME_US, data: samples });
          try { audioEncoder.encode(data); } finally { data.close(); }
        },
        close: () => { try { audioEncoder.close(); } catch { /* already closed */ } },
      },
      decoder: {
        decode: (seq, data) => {
          if (audioDecoder.state !== 'configured') throw Object.assign(new Error(), { name: 'OpusDecoderClosed' });
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
    // A crashed worklet means no capture or no playout for the rest of the call.
    capture.onprocessorerror = () => fail('audio_capture_failed');
    playout.onprocessorerror = () => fail('audio_playout_failed');
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
      capture.onprocessorerror = null;
      playout.onprocessorerror = null;
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
    // The worklet's own playout limits its output; this path does the same.
    const limiter = new PeakLimiter(ctx.sampleRate);
    let nextAt = 0;
    const frameSeconds = size / ctx.sampleRate;
    const tick = () => {
      // Keep up to three frames scheduled ahead of the clock.
      while (nextAt < ctx.currentTime + 3 * frameSeconds) {
        if (nextAt < ctx.currentTime) nextAt = ctx.currentTime;
        const pulled = jitter.pull();
        if (pulled.frame) {
          const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
          const channel = buffer.getChannelData(0);
          channel.set(pulled.frame);
          limiter.process(channel);
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
    contextRate = ctx.sampleRate;
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
    if (rec && !failed) {
      rowTimer = setInterval(() => void closeRow(), ROW_MS);
      rec.startTicking(clock());
      loopTimer = setInterval(() => rec.tick(clock()), 20);
    }
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
      if (rec) {
        rec.arrived(clock());
        if (payload.type !== 'hello') rec.received(payload.codec === 'opus' ? 'opus' : 'pcmu');
      }
      if (payload.type === 'hello') {
        const first = peerCaps === null;
        peerCaps = payload.caps;
        playMarker(frame.seq);
        // They may have missed ours: answer the first HELLO once.
        if (first) sayHello();
        return;
      }
      receivedCodecs.add(codecName(payload.codec));
      if (payload.codec === 'pcmu') {
        if (!context) return;
        play(frame.seq, pcmuDownlink.push(frame.seq, decodeMuLaw(payload.data), PCMU_RATE, context.sampleRate));
      } else {
        if (decoder) {
          try {
            decoder.decode(frame.seq, payload.data);
            return;
          } catch {
            decoderFailed();
          }
        }
        // Opus without a decoder here: no audio for this slot, but no gap either.
        playMarker(frame.seq);
        // Our HELLO without Opus may have been lost on a reconnect: repeat it,
        // and end the call rather than stay live and silent if it never lands.
        undecodable++;
        if (undecodable >= OPUS_FALLBACK_FRAMES) fail('peer_kept_sending_opus');
        else if (undecodable % OPUS_REHELLO_FRAMES === 0) sayHello();
      }
    },
    setMuted: (next) => {
      if (next === muted) return;
      muted = next;
      rec?.setMuted(next, clock());
      // Muting or unmuting starts a fresh observation: what the microphone
      // delivered before says nothing about what it delivers now.
      zeroFrames = 0;
      if (silent) {
        silent = false;
        deps.onSilence?.(false);
      }
    },
    codecs: () => ({ sending, localCaps, peerCaps }),
    diagnostics: () => ({ sent: [...sentCodecs], received: [...receivedCodecs], contextRate }),
    stats: () => readStats(),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(helloTimer);
      helloTimer = undefined;
      clearInterval(rowTimer);
      clearInterval(loopTimer);
      // The last, partial row: no round trips here, so teardown takes no longer.
      if (rec && clock() - rec.rowStartedAt() >= 500) emit(rec.close(clock(), { codec: sending, mic: mic(), jitter: null, host: null }, true));
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
