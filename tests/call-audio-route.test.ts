import { afterEach, expect, it, vi } from 'vitest';
import { hostSource, type CallAudioRoute } from '../src/control/source';
import { sampleSource } from '../src/control/sample';

afterEach(() => { vi.unstubAllGlobals(); });

function host(reply: CallAudioRoute) {
  const calls: { cmd: string; args?: unknown }[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (cmd: string, args?: unknown) => { calls.push({ cmd, args }); return Promise.resolve(reply); },
  });
  return calls;
}

it('asks the host for speaker or earpiece and returns the resulting route', async () => {
  const calls = host('speaker');
  await expect(hostSource.callAudioRoute('speaker')).resolves.toBe('speaker');
  expect(calls).toEqual([{ cmd: 'call_audio_route', args: { route: 'speaker' } }]);
});

it('reads the current route without changing it', async () => {
  const calls = host('external');
  await expect(hostSource.callAudioRouteGet()).resolves.toBe('external');
  expect(calls.map(c => c.cmd)).toEqual(['call_audio_route_get']);
});

it('the sample (and desktop) source keeps the system route', async () => {
  const sample = sampleSource({});
  await expect(sample.callAudioRoute('speaker')).resolves.toBe('unsupported');
  await expect(sample.callAudioRouteGet()).resolves.toBe('unsupported');
});
