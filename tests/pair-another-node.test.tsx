import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { PairAnotherNode } from '../src/onboarding/PairAnotherNode';
import type { RemoteImportView, RemotePreviewView } from '../src/control/source';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); });

function mountIn() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}

const CURRENT = 'aa'.repeat(32);
const LINK = 'bitsov://pair/another-node-ticket';
const view: RemotePreviewView = { endpoint: 'other.example:4242', node_id_fingerprint: 'cd…ef' };
const saved: RemoteImportView = { ...view, restart_required: true };

function setup(onReplace: (link: string) => Promise<RemoteImportView>) {
  const onPreview = vi.fn(async () => view);
  const replace = vi.fn(onReplace);
  dispose = render(() => <PairAnotherNode currentNodeId={() => CURRENT} currentHostedBy={() => 'Home Pi'}
    onPreview={onPreview} onReplace={replace} />, mountIn());
  mount.querySelector<HTMLButtonElement>('[data-pair-another-open]')!.click();
  return { onPreview, replace };
}

async function reviewAndChoose() {
  const input = mount.querySelector<HTMLInputElement>('#pair-another-link')!;
  input.value = LINK;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  const form = mount.querySelector<HTMLFormElement>('form[data-remote-access]')!;
  form.requestSubmit();
  await vi.waitFor(() => expect(mount.querySelector('[data-pairing-preview]')).not.toBeNull());
  expect(mount.querySelector('form')!.textContent).toContain('Use remote node');
  form.requestSubmit();
  await vi.waitFor(() => expect(mount.querySelector('[data-pair-another-confirm]')).not.toBeNull());
}

describe('Settings → Node: Pair another node', () => {
  it.each([true, false, undefined])('shows the button only for a remote node (remote=%s)', async (remote) => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    dispose = render(() => <ControlCenter source={source} active ready remote={remote} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelector('[data-panel="node"]')).not.toBeNull());
    const button = mount.querySelector('[data-panel="node"] [data-pair-another-open]');
    if (remote) expect(button?.textContent).toBe('Pair another node');
    else expect(button).toBeNull();
  });

  it('asks for confirmation naming the current node before anything is saved', async () => {
    const { onPreview, replace } = setup(async () => saved);
    await reviewAndChoose();
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(replace).not.toHaveBeenCalled();
    const confirm = mount.querySelector('[data-pair-another-confirm]')!;
    expect(confirm.textContent).toContain(`Node ${CURRENT.slice(0, 8)}…${CURRENT.slice(-8)} (hosted by Home Pi) will no longer be this app’s node.`);
    expect(confirm.textContent).toContain('Funds and contacts stay on the old node.');
    expect(confirm.textContent).toContain('pair back later with a new ticket from that node');
    expect(confirm.textContent).toContain('other.example:4242');
    // The form is locked while the question is open.
    expect(mount.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(true);
  });

  it('cancel changes nothing and keeps the reviewed ticket', async () => {
    const { replace } = setup(async () => saved);
    await reviewAndChoose();
    mount.querySelector<HTMLButtonElement>('[data-pair-another-confirm-no]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-pair-another-confirm]')).toBeNull());
    expect(replace).not.toHaveBeenCalled();
    expect(mount.querySelector('[data-pairing-preview]')).not.toBeNull();
    expect(mount.querySelector('[data-import-result]')).toBeNull();
    // Closing with a question open also saves nothing.
    mount.querySelector<HTMLFormElement>('form[data-remote-access]')!.requestSubmit();
    await vi.waitFor(() => expect(mount.querySelector('[data-pair-another-confirm]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>('[data-pair-another-close]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('form[data-remote-access]')).toBeNull());
    expect(replace).not.toHaveBeenCalled();
    expect(mount.querySelector<HTMLButtonElement>('[data-pair-another-open]')!.disabled).toBe(false);
  });

  it('replaces only after Replace node, then asks for a restart', async () => {
    const { replace } = setup(async () => saved);
    await reviewAndChoose();
    mount.querySelector<HTMLButtonElement>('[data-pair-another-confirm-yes]')!.click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(LINK));
    await vi.waitFor(() => expect(mount.querySelector('[data-import-result]')?.textContent).toContain('Restart BitSov to connect.'));
    mount.querySelector<HTMLButtonElement>('[data-pair-another-close]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-pair-another-saved]')).not.toBeNull());
    expect(mount.querySelector<HTMLButtonElement>('[data-pair-another-open]')!.disabled).toBe(true);
  });

  it('a failed replacement reports the error and claims no switch', async () => {
    const { replace } = setup(async () => { throw 'cannot persist remote descriptor: disk full'; });
    await reviewAndChoose();
    mount.querySelector<HTMLButtonElement>('[data-pair-another-confirm-yes]')!.click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mount.querySelector('form[data-remote-access]')!.textContent).toContain('disk full'));
    expect(mount.querySelector('[data-import-result]')).toBeNull();
    mount.querySelector<HTMLButtonElement>('[data-pair-another-close]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-pair-another-open]')).not.toBeNull());
    expect(mount.querySelector('[data-pair-another-saved]')).toBeNull();
    expect(mount.querySelector<HTMLButtonElement>('[data-pair-another-open]')!.disabled).toBe(false);
  });
});

describe('host source', () => {
  it('replaces through remote_access_replace, never remote_access_import', async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async (cmd: string) => { calls.push(cmd); if (cmd === 'remote_access_replace') throw 'kept the old link'; return saved; }),
    }));
    const { hostSource } = await import('../src/control/source');
    await expect(hostSource.remoteAccessReplace(LINK)).rejects.toBe('kept the old link');
    expect(calls).toEqual(['remote_access_replace']);
    vi.doUnmock('@tauri-apps/api/core');
  });
});
