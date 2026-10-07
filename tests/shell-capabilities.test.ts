import { expect, it } from 'vitest';

type Capability = {
  permissions: (string | { identifier: string })[];
};

// Check every desktop/mobile capability, plus inline capabilities in config
// overlays. A shell execute grant (including args: true) must never return:
// only Rust owns sidecar execution, so the renderer needs no shell permission.
const files = import.meta.glob<string>([
  '../src-tauri/capabilities/**/*.json',
  '../src-tauri/mobile-capabilities/**/*.json',
  '../src-tauri/tauri*.conf.json',
], { query: '?raw', import: 'default', eager: true });

it('grants no webview shell permissions in desktop, mobile, or inline capabilities', () => {
  expect(Object.keys(files)).toContain('../src-tauri/capabilities/default.json');
  expect(Object.keys(files)).toContain('../src-tauri/mobile-capabilities/default.json');
  for (const [path, raw] of Object.entries(files)) {
    const document = JSON.parse(raw);
    const capabilities: Capability[] = path.includes('capabilities/')
      ? [document]
      : (document.app?.security?.capabilities ?? []).filter((cap: unknown) => typeof cap !== 'string');
    for (const capability of capabilities) {
      for (const permission of capability.permissions) {
        const identifier = typeof permission === 'string' ? permission : permission.identifier;
        expect(identifier, `${path}: Rust owns sidecar execution`).not.toMatch(/^shell:/);
      }
    }
  }
});
