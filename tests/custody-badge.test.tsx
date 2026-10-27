import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { custodyBadge, CustodyBadgeView } from '../src/control/custody';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { CustodyMode } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); });

function mountIn() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}

describe('custody badge (node REMOTE-SIGNER.md §2)', () => {
  it('words each mode, with hosted custody as the warning that says who can spend', () => {
    expect(custodyBadge('local_seed')).toMatchObject({ label: 'Seed on this machine', tone: 'warn' });
    expect(custodyBadge('encrypted_seed')).toMatchObject({ label: 'Encrypted seed', tone: 'ok' });
    const hosted = custodyBadge('hosted_custody')!;
    expect(hosted).toMatchObject({ label: 'Hosted custody', tone: 'warn' });
    expect(hosted.title).toContain('Seed on another computer or server, or this connection is not proven local.');
    expect(hosted.title).toContain('Whoever can reach that machine can spend its bitcoin and read its messages.');
    expect(hosted.title).not.toContain('Use this Mac instead');
    const money = custodyBadge('money_signer')!;
    expect(money).toMatchObject({ label: 'Money on your device', tone: 'warn' });
    expect(money.title).toContain('NodeId chat-identity private key stays on the server');
    const remote = custodyBadge('remote_signer')!;
    expect(remote).toMatchObject({ label: 'Your keys, remote node', tone: 'ok' });
    expect(remote.title).toContain('identity root stay on your device');
    expect(remote.title).toContain('Transport and storage keys');
  });

  it.each(['local_seed', 'encrypted_seed'] as const)('guards funding and sending for %s', async (mode) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    source.nodeOverview = async () => ({ ...base, custody_mode: mode, money_ready: true, read_at: Date.now() });
    source.spendStatus = async () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600_000, pending: null, window_ms: 600_000 });
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />}
      fund={(_source, blocked) => <button data-fund-start disabled={blocked()}>Fund</button>} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-send]')).not.toBeNull());
    (mount.querySelector('[data-composer-mode="pay"]') as HTMLButtonElement).click();
    [...mount.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Direct')!.click();
    for (const [selector, value] of [['[data-pay-pubkey]', `02${'11'.repeat(32)}`], ['[data-pay-amount]', '10']]) {
      const input = mount.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await vi.waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(mode === 'local_seed'));
    (mount.querySelector('[data-tab="wallet"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector<HTMLButtonElement>('[data-fund-start]')!.disabled).toBe(mode === 'local_seed'));
    if (mode === 'local_seed') expect(mount.textContent).toContain('Your recovery phrase is unencrypted on disk');
  });

  it('claims nothing for an older node or an unknown value', () => {
    expect(custodyBadge(undefined)).toBeNull();
    expect(custodyBadge(null)).toBeNull();
    expect(custodyBadge('trust_me' as CustodyMode)).toBeNull();
    dispose = render(() => <CustodyBadgeView mode={undefined} />, mountIn());
    expect(mount.querySelector('[data-custody]')).toBeNull();
  });

  it.each([
    ['hosted_custody', 'Hosted custody'],
    ['encrypted_seed', 'Encrypted seed'],
  ] as const)('the Node panel shows %s', async (mode, label) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    source.nodeOverview = async () => ({ ...base, custody_mode: mode, read_at: Date.now() });
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-custody]')).not.toBeNull());
    const badge = mount.querySelector('[data-panel="node"] [data-custody]')!;
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute('data-custody')).toBe(mode);
  });

  it.each([true, false, undefined])('the Node panel offers Use this Mac instead only for remote connections (remote=%s)', async (remote) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    source.nodeOverview = async () => ({ ...base, custody_mode: 'hosted_custody', read_at: Date.now() });
    dispose = render(() => <ControlCenter source={source} active ready remote={remote} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] [data-custody]')).not.toBeNull());
    const control = mount.querySelector('[data-panel="node"] [data-use-local]');
    if (remote) {
      expect(control).not.toBeNull();
      expect(control!.textContent).toBe('Use this Mac instead');
    } else {
      expect(control).toBeNull();
    }
  });

  it('the Node panel has no Keys row when the node does not say', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    const base = await source.nodeOverview();
    source.nodeOverview = async () => ({ ...base, custody_mode: undefined, read_at: Date.now() });
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"] dl')).not.toBeNull());
    expect(mount.querySelector('[data-panel="node"]')!.textContent).not.toContain('Keys');
  });
});
