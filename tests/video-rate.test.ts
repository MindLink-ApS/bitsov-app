/** What video may cost on the node's caps, and the step-down ladder. */
import { describe, expect, it } from 'vitest';
import { BAD_WINDOWS, NODE_CAPS, PAUSE_MS, RESERVED_BYTES, RESERVED_MESSAGES, STEP_UP_AFTER_MS, TIER_DEFAULT, TIER_HIGH, VideoRateController, pacerLimits, stepsFor, tierForLimits } from '../src/control/videoRate';
import { FRAGMENT_HEADER_BYTES, INNER_HEADER_BYTES, MAX_FRAGMENT_DATA, MAX_INNER_BYTES } from '../src/control/videoFrame';
import { callVideoFlag } from '../vite.config';
import { nodeRoutedAudio, nodeRoutedVideo } from '../src/control/callFlags';

describe('the fit against the node caps', () => {
  it('stays inside what the node leaves after its reservation, at both tiers', () => {
    expect(pacerLimits(TIER_DEFAULT)).toEqual({ bytes_per_second: 45260, messages_per_second: 34 });
    expect(pacerLimits(TIER_HIGH)).toEqual({ bytes_per_second: 212377, messages_per_second: 85 });
    for (const tier of [TIER_DEFAULT, TIER_HIGH]) {
      const pacer = pacerLimits(tier);
      expect(pacer.bytes_per_second).toBeLessThan(NODE_CAPS[tier].bytes - RESERVED_BYTES);
      expect(pacer.messages_per_second).toBeLessThan(NODE_CAPS[tier].messages - RESERVED_MESSAGES);
    }
  });

  it('every step fits its pacer with room left for key frames', () => {
    for (const tier of [TIER_DEFAULT, TIER_HIGH]) {
      const pacer = pacerLimits(tier);
      for (const step of stepsFor(tier)) {
        const framePayload = step.bitrate / 8 / step.fps;
        const fragments = Math.ceil(framePayload / MAX_FRAGMENT_DATA) * step.fps;
        const overhead = fragments * (4 + INNER_HEADER_BYTES + FRAGMENT_HEADER_BYTES);
        expect(step.bitrate / 8 + overhead).toBeLessThan(pacer.bytes_per_second * 0.85);
        expect(fragments).toBeLessThan(pacer.messages_per_second);
      }
    }
  });

  it('a full fragment plus the socket header stays one message inside the node cap', () => {
    expect(MAX_INNER_BYTES + 4).toBeLessThanOrEqual(4100);
    // A paced key frame of 30 KB fits one second of the default pacer.
    expect(30_000 + 8 * 25).toBeLessThan(pacerLimits(TIER_DEFAULT).bytes_per_second);
  });
});

describe('the flag', () => {
  it('is off unless the build says exactly node, and needs the node path', () => {
    expect(nodeRoutedVideo({})).toBe(false);
    expect(nodeRoutedVideo({ VITE_CALL_VIDEO: 'off' })).toBe(false);
    expect(nodeRoutedVideo({ VITE_CALL_VIDEO: 'NODE' })).toBe(false);
    expect(nodeRoutedVideo({ VITE_CALL_VIDEO: '1' })).toBe(false);
    expect(nodeRoutedVideo({ VITE_CALL_VIDEO: 'node' })).toBe(true);
    expect(nodeRoutedVideo({ VITE_CALL_VIDEO: 'node', VITE_CALL_MEDIA: 'webrtc' })).toBe(false);
    expect(nodeRoutedAudio({ VITE_CALL_VIDEO: 'node' })).toBe(true);
    expect(callVideoFlag({})).toBe('off');
    expect(callVideoFlag({ VITE_CALL_VIDEO: 'yes' })).toBe('off');
    expect(callVideoFlag({ VITE_CALL_VIDEO: 'node' })).toBe('node');
  });

  it('takes the higher tier only from a node that allows all of it', () => {
    expect(tierForLimits(null)).toBe(TIER_DEFAULT);
    expect(tierForLimits({ messages: 100, bytes: 65_536 })).toBe(TIER_DEFAULT);
    expect(tierForLimits({ messages: 160, bytes: 65_536 })).toBe(TIER_DEFAULT);
    expect(tierForLimits({ messages: 100, bytes: 262_144 })).toBe(TIER_DEFAULT);
    expect(tierForLimits({ messages: 159, bytes: 262_144 })).toBe(TIER_DEFAULT);
    expect(tierForLimits({ messages: 160, bytes: 262_144 })).toBe(TIER_HIGH);
    expect(tierForLimits({ messages: 1000, bytes: 1_048_576 })).toBe(TIER_HIGH);
  });
});

describe('the ladder', () => {
  const size = (rate: VideoRateController) => { const s = rate.step(); return s ? `${s.width}x${s.height}@${s.fps}` : 'paused'; };

  it('steps down on backpressure, then pauses, and audio is not its concern', () => {
    const rate = new VideoRateController(TIER_DEFAULT, 0);
    expect(size(rate)).toBe('320x240@15');
    expect(rate.onBackpressure(1).changed).toBe(true);
    expect(size(rate)).toBe('320x240@10');
    rate.onBackpressure(2);
    expect(size(rate)).toBe('240x180@7');
    const paused = rate.onBackpressure(3);
    expect(paused).toMatchObject({ paused: true, step: null, changed: true });
    expect(rate.isPaused()).toBe(true);
    expect(rate.onBackpressure(4).changed).toBe(false);
  });

  it('comes back from a pause at the lowest step, then climbs after clean time', () => {
    const rate = new VideoRateController(TIER_DEFAULT, 0);
    for (let i = 0; i < 3; i++) rate.onBackpressure(i);
    expect(rate.tick(PAUSE_MS - 1).paused).toBe(true);
    expect(rate.tick(2 + PAUSE_MS)).toMatchObject({ changed: true, paused: false });
    expect(size(rate)).toBe('240x180@7');
    expect(rate.tick(2 + PAUSE_MS + STEP_UP_AFTER_MS).changed).toBe(true);
    expect(size(rate)).toBe('320x240@10');
  });

  it('needs bad windows in a row, and clean ones reset the count', () => {
    const rate = new VideoRateController(TIER_DEFAULT, 0);
    expect(rate.onReport(10, 2, 1).changed).toBe(false);
    expect(rate.onReport(15, 0, 2).changed).toBe(false);
    expect(rate.onReport(10, 2, 3).changed).toBe(false);
    expect(BAD_WINDOWS).toBe(2);
    expect(rate.onReport(10, 2, 4).changed).toBe(true);
    expect(size(rate)).toBe('320x240@10');
    // A window with no frames at all says nothing.
    const quiet = new VideoRateController(TIER_DEFAULT, 0);
    for (let t = 1; t < 5; t++) expect(quiet.onReport(0, 0, t).changed).toBe(false);
  });

  it('never goes above what the lower of the two sides asks for', () => {
    const rate = new VideoRateController(TIER_HIGH, 0);
    expect(size(rate)).toBe('640x360@30');
    expect(rate.setTier(TIER_DEFAULT, 1)).toMatchObject({ changed: true });
    expect(size(rate)).toBe('320x240@15');
    const same = new VideoRateController(TIER_HIGH, 0);
    expect(same.setTier(TIER_HIGH, 1).changed).toBe(false);
    // Learning the higher tier starts at its top, without waiting to climb.
    const up = new VideoRateController(TIER_DEFAULT, 0);
    expect(up.setTier(TIER_HIGH, 1)).toMatchObject({ changed: true });
    expect(size(up)).toBe('640x360@30');
    // The same tier again leaves a stepped-down ladder where it is.
    const held = new VideoRateController(TIER_DEFAULT, 0);
    held.onBackpressure(1);
    expect(held.setTier(TIER_DEFAULT, 2).changed).toBe(false);
    expect(size(held)).toBe('320x240@10');
  });

  it('the higher tier falls through its own steps into the default ones', () => {
    const rate = new VideoRateController(TIER_HIGH, 0);
    const seen = [size(rate)];
    for (let i = 0; i < stepsFor(TIER_HIGH).length - 1; i++) { rate.onBackpressure(i); seen.push(size(rate)); }
    expect(seen).toEqual(['640x360@30', '640x360@20', '480x270@15', '320x240@15', '320x240@10', '240x180@7']);
  });
});
