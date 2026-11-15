import { expect, it } from 'vitest';

// The renderer sends video through its own host command. build.rs compiles the
// desktop set for desktop and the mobile set for iOS, Android and the mobile
// feature: both main windows need the grant, beside the rest of the media socket.
const files = import.meta.glob<string>([
  '../src-tauri/capabilities/default.json',
  '../src-tauri/mobile-capabilities/default.json',
], { query: '?raw', import: 'default', eager: true });

type Capability = { windows: string[]; permissions: (string | { identifier: string })[] };

const MEDIA = ['allow-call-media-open', 'allow-call-media-send', 'allow-call-media-video-send', 'allow-call-media-close'];

it.each(['../src-tauri/capabilities/default.json', '../src-tauri/mobile-capabilities/default.json'])('%s grants the main window every media socket command, video included', (path) => {
  expect(files[path], path).toBeTypeOf('string');
  const capability = JSON.parse(files[path]) as Capability;
  expect(capability.windows).toContain('main');
  const granted = capability.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const permission of MEDIA) expect(granted, `${path}: ${permission}`).toContain(permission);
});
