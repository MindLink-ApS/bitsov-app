import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDLE, type CallView } from '../src/control/call';
import { OutgoingRingback } from '../src/control/IncomingCallAlerts';

type Fake = { src: string; loop: boolean; paused: boolean };
let made: Fake[];
beforeEach(() => {
  made = [];
  vi.stubGlobal('Audio', class { src: string; loop = false; volume = 1; paused = true; currentTime = 0; constructor(src: string) { this.src = src; made.push(this); } play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } });
});
afterEach(() => vi.unstubAllGlobals());

const ringing: CallView = { ...IDLE, peer: 'a'.repeat(64), callId: 'c1', outgoing: true, phase: 'ringing', state: 'ringing' };
const playing = () => made.filter((a) => !a.paused).length;

it('rings while going out, once, and loops', () => {
  const [view, setView] = createSignal<CallView>({ ...ringing, phase: 'calling' });
  const dispose = render(() => <OutgoingRingback view={view()} />, document.body);
  expect(playing()).toBe(1);
  setView(ringing);
  expect(made).toHaveLength(1);
  expect(made[0].loop).toBe(true);
  dispose();
});

it.each<[string, Partial<CallView>]>([
  ['they answer', { phase: 'connecting' }],
  ['it goes live', { phase: 'live', liveAt: 1 }],
  ['they decline', { phase: 'ended', reason: 'declined' }],
  ['they are busy', { phase: 'ended', reason: 'busy' }],
  ['nobody answers', { phase: 'ended', reason: 'timeout' }],
  ['it fails', { phase: 'ended', reason: 'failed' }],
  ['it is refused', { phase: 'ended', reason: null, error: 'No.' }],
  ['the person hangs up', { phase: 'ended', reason: 'hangup' }],
  ['the card is dismissed', { phase: 'idle' }],
])('stops when %s', (_name, next) => {
  const [view, setView] = createSignal<CallView>(ringing);
  const dispose = render(() => <OutgoingRingback view={view()} />, document.body);
  expect(playing()).toBe(1);
  setView({ ...ringing, ...next });
  expect(playing()).toBe(0);
  dispose();
});

it('stops when the app closes the view', () => {
  const dispose = render(() => <OutgoingRingback view={ringing} />, document.body);
  expect(playing()).toBe(1);
  dispose();
  expect(playing()).toBe(0);
});

it('never rings for an incoming call', () => {
  const dispose = render(() => <OutgoingRingback view={{ ...ringing, outgoing: false, phase: 'incoming' }} />, document.body);
  expect(made).toHaveLength(0);
  dispose();
});
