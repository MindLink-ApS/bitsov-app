import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appCommit } from '../vite.config';
import { APP_COMMIT, APP_VERSION, CopyVersions, VersionRows, versionsBlock } from '../src/control/BuildVersions';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { setLanguagePref } from '../src/i18n';
import type { NodeOverview } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); setLanguagePref('en'); });

function mountIn() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}

const overview = (extra: Partial<NodeOverview> = {}): NodeOverview => ({
  node_id: SAMPLE_OWN_ID, status: 'ok', version: '2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
  lightning_available: true, block_height: 100, uptime_secs: 60, lightning_backend: null, chain_backend: null,
  capabilities: ['energy_v1', 'call_meeting_v1'], network: 'signet', read_at: 0, ...extra,
});

const ENDPOINT = /bitsov:\/\/|https?:|\b\d{1,3}(?:\.\d{1,3}){3}\b|ticket|token|seed|stun:/i;

describe('build identity (vite.config.ts)', () => {
  const git = (head: string, status = '') => (args: string[]) => (args[0] === 'rev-parse' ? `${head}\n` : status);
  it('prefers CI GITHUB_SHA, shortened, and never marks it dirty', () => {
    expect(appCommit({ GITHUB_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' }, git('111111111111', ' M x'))).toBe('abcdef012345');
  });
  it('falls back to HEAD with -dirty for local changes, but not on CI', () => {
    expect(appCommit({}, git('0123456789ab'))).toBe('0123456789ab');
    expect(appCommit({}, git('0123456789ab', ' M src/x.ts\n'))).toBe('0123456789ab-dirty');
    expect(appCommit({ CI: 'true' }, git('0123456789ab', ' M src/x.ts\n'))).toBe('0123456789ab');
  });
  it('says unknown without git or with odd output', () => {
    expect(appCommit({}, () => { throw new Error('no git'); })).toBe('unknown');
    expect(appCommit({}, git('fatal: not a git repository'))).toBe('unknown');
  });
  it('vitest injects a fixed commit and the package version', () => {
    expect(APP_COMMIT).toBe('0123456789ab');
    expect(APP_VERSION).toBe('0.0.1');
  });
});

describe('versions block (M6 P2)', () => {
  it('carries every field, one per line, and no endpoint, token or ticket text', () => {
    const block = versionsBlock({
      overview: overview({ stun_url: 'stun:node.example:3478', stun_port: 3478, custody_mode: 'local_seed' }),
      commit: 'abcdef012345', version: '0.0.1', platform: 'ios', now: new Date('2026-11-02T10:00:00Z'),
    });
    expect(block.split('\n')).toEqual([
      'app_commit: abcdef012345',
      'app_version: 0.0.1',
      'platform: ios',
      `node_id: ${SAMPLE_OWN_ID.slice(0, 8)}…${SAMPLE_OWN_ID.slice(-8)}`,
      'node_api: 2',
      'node_capabilities: energy_v1,call_meeting_v1',
      'network: signet',
      'time: 2026-11-02T10:00:00.000Z',
    ]);
    expect(block).not.toMatch(ENDPOINT);
    expect(block).not.toContain(SAMPLE_OWN_ID);
  });
  it('drops node strings that are not in their known shape', () => {
    const block = versionsBlock({
      overview: overview({ version: 'http://node.example/x', network: 'bitsov://front-door#x', capabilities: ['token=abc', 'energy_v1', 'node.example:9735'], node_id: 'bitsov://invite/abc' }),
      commit: 'abcdef012345', version: '0.0.1', platform: 'desktop',
    });
    expect(block).not.toMatch(ENDPOINT);
    expect(block).toContain('node_capabilities: energy_v1');
    expect(block).toContain('node_api: unknown');
    expect(block).toContain('network: unknown');
    expect(block).toContain('node_id: unknown');
  });
});

describe('version rows and Copy versions', () => {
  it('renders the rows with the injected commit (EN)', () => {
    setLanguagePref('en');
    dispose = render(() => <dl><VersionRows overview={overview()} commit="fedcba987654-dirty" /></dl>, mountIn());
    expect(mount.querySelector('[data-version-app-build]')!.textContent).toBe('fedcba987654-dirty');
    expect(mount.querySelector('[data-version-node-api]')!.textContent).toBe('2');
    expect(mount.querySelector('[data-version-capabilities]')!.textContent).toBe('energy_v1, call_meeting_v1');
    expect(mount.querySelector('[data-version-network]')!.textContent).toBe('signet');
    expect([...mount.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['App build', 'Node API', 'Node capabilities', 'Network']);
  });
  it('words the rows and the button in Danish, and says none/unknown when the node does not', () => {
    setLanguagePref('da');
    dispose = render(() => <><dl><VersionRows overview={overview({ capabilities: undefined, network: null, version: null })} commit="unknown" /></dl><CopyVersions overview={overview()} copy={async () => {}} /></>, mountIn());
    expect([...mount.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['App-build', 'Node-API', 'Node-funktioner', 'Netværk']);
    expect(mount.querySelector('[data-version-app-build]')!.textContent).toBe('ukendt');
    expect(mount.querySelector('[data-version-capabilities]')!.textContent).toBe('ingen');
    expect(mount.querySelector('[data-version-network]')!.textContent).toBe('ukendt');
    expect(mount.querySelector('[data-versions-copy]')!.textContent).toBe('Kopiér versioner');
  });
  it('copies the block and confirms "Kopieret"', async () => {
    setLanguagePref('da');
    const copy = vi.fn(async (_text: string) => {});
    dispose = render(() => <CopyVersions overview={overview()} commit="abcdef012345" copy={copy} />, mountIn());
    expect(mount.querySelector('[data-versions-copied]')).toBeNull();
    (mount.querySelector('[data-versions-copy]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-versions-copied]')?.textContent).toBe('Kopieret.'));
    expect(copy).toHaveBeenCalledTimes(1);
    const text = copy.mock.calls[0][0];
    expect(text).toContain('app_commit: abcdef012345');
    expect(text).toContain('network: signet');
    expect(text).not.toMatch(ENDPOINT);
  });
  it('confirms in English, and says so when the copy fails', async () => {
    setLanguagePref('en');
    let fail = false;
    dispose = render(() => <CopyVersions overview={overview()} copy={async () => { if (fail) throw new Error('denied'); }} />, mountIn());
    expect(mount.querySelector('[data-versions-copy]')!.textContent).toBe('Copy versions');
    (mount.querySelector('[data-versions-copy]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-versions-copied]')?.textContent).toBe('Copied.'));
    fail = true;
    (mount.querySelector('[data-versions-copy]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-versions-copied]')?.textContent).toBe('Could not copy.'));
  });
  it('the Node panel shows the rows next to the node facts, with the build commit', async () => {
    setLanguagePref('en');
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    source.nodeOverview = async () => ({ ...base, network: 'signet', read_at: Date.now() });
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-version-app-build]')).not.toBeNull());
    const panel = mount.querySelector('[data-panel="node"]')!;
    expect(panel.querySelector('[data-version-app-build]')!.textContent).toBe('0123456789ab');
    expect(panel.querySelector('[data-version-network]')!.textContent).toBe('signet');
    expect(panel.querySelector('[data-versions-copy]')).not.toBeNull();
  });
});
