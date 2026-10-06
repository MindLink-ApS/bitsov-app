import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { HubChannelConfirm, HUB_TRUST_CARDS, HUB_TRUST_TITLE } from '../src/control/HubTrust';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import { LockedNode } from '../src/onboarding/LockedNode';

const COPY = [
  "The hub is your Lightning service provider: it gives you a channel and routes your payments. It is one provider, not the centre, and you can add or switch to another.",
  "It can't read your messages. They are end-to-end encrypted between your node and the person you write to.",
  "It never holds your keys or your seed, and it can't spend your money.",
  "It does see the payments it routes for you: amount, time and the next hop. It doesn't see what they were for.",
  "It can refuse to route your payments. If it does, your money is still yours, and you can close the channel and move to another provider.",
  "While your home box is locked (for example after a power cut), it isn't watching your channels. If the hub broadcast an old channel state then, you could lose funds unless you unlock within about a day. That's why a locked box only opens channels to the hub until a watchtower exists, and why you should unlock soon after a restart.",
  "Fees: routing costs a small fee per payment, shown before you pay.",
];

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); vi.unstubAllGlobals(); });

function mountIn() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}

function expectDisclosure(root: Element, level: 2 | 3) {
  const card = root.querySelector('[data-hub-trust]')!;
  expect(card).not.toBeNull();
  const title = card.querySelector(`h${level}`)!;
  expect(title.textContent).toBe("What MindLink's hub can and can't do");
  expect(card.getAttribute('aria-labelledby')).toBe(title.id);
  const paragraphs = [...card.querySelectorAll('.hub-trust-card p')].map((p) => p.textContent);
  expect(paragraphs).toEqual(COPY);
  const headings = [...card.querySelectorAll(`.hub-trust-card h${level + 1}`)].map((h) => h.textContent);
  expect(headings).toEqual(HUB_TRUST_CARDS.map((c) => c.heading));
}

const toggle = (root: Element) => root.querySelector<HTMLButtonElement>('[data-hub-trust-toggle]')!;

describe('hub trust disclosure', () => {
  it('keeps the approved copy verbatim', () => {
    expect(HUB_TRUST_TITLE).toBe("What MindLink's hub can and can't do");
    expect(HUB_TRUST_CARDS.flatMap((c) => c.lines)).toEqual(COPY);
  });

  it('is always reachable from the settings Node panel as an ⓘ card, and can be hidden again', async () => {
    const source = sampleSource({ firstLiveMs: 1e9 });
    dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-tab="node"]')).not.toBeNull());
    (mount.querySelector('[data-tab="node"]') as HTMLButtonElement).click();
    const panel = () => mount.querySelector('[data-panel="node"]')!;
    await vi.waitFor(() => expect(panel().querySelector('[data-hub-trust-toggle]')).not.toBeNull());

    expect(toggle(panel()).textContent).toBe("ⓘWhat MindLink's hub can and can't do");
    expect(toggle(panel()).getAttribute('aria-expanded')).toBe('false');
    expect(panel().querySelector('[data-hub-trust]')).toBeNull();

    toggle(panel()).click();
    expect(toggle(panel()).getAttribute('aria-expanded')).toBe('true');
    expectDisclosure(panel(), 3);

    panel().querySelector<HTMLButtonElement>('[data-hub-trust-dismiss]')!.click();
    expect(panel().querySelector('[data-hub-trust]')).toBeNull();
    expect(document.activeElement).toBe(toggle(panel()));

    toggle(panel()).click();
    expectDisclosure(panel(), 3);
  });

  it('shows on the locked-node screen, stays hidden once dismissed, and can be reopened', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string) => {
      if (cmd === 'node_status') return Promise.resolve({ ready: false, node_id: 'ab'.repeat(32), error: null, locked: true });
      if (cmd === 'pairing_status') return Promise.resolve({ state: 'paired', remote: true, scopes: ['read'], bootstrap: null });
      return Promise.reject('unavailable');
    }});
    dispose = render(() => <App />, mountIn());
    await vi.waitFor(() => expect(mount.querySelector('[data-node-locked]')).not.toBeNull());
    expectDisclosure(mount, 2);
    expect(mount.querySelector('[data-node-locked]')!.contains(mount.querySelector('[data-hub-trust]'))).toBe(false);

    mount.querySelector<HTMLButtonElement>('[data-hub-trust-dismiss]')!.click();
    expect(mount.querySelector('[data-hub-trust]')).toBeNull();
    dispose(); mount.remove(); vi.unstubAllGlobals();

    dispose = render(() => <LockedNode onUnlock={async () => {}} />, mountIn());
    expect(mount.querySelector('[data-hub-trust]')).toBeNull();
    toggle(mount).click();
    expectDisclosure(mount, 2);
  });
});

describe('first hub channel confirm step', () => {
  it('blocks the channel open until the owner acknowledges, then only once per node', async () => {
    const open = vi.fn(async () => {});
    const cancel = vi.fn();
    const node = 'cd'.repeat(32);
    dispose = render(() => <HubChannelConfirm nodeId={node} onConfirm={open} onCancel={cancel} />, mountIn());

    const dialog = mount.querySelector('[data-hub-channel-confirm]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')!.id);
    expectDisclosure(dialog, 2);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();

    mount.querySelector<HTMLButtonElement>('[data-hub-channel-cancel]')!.click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();

    mount.querySelector<HTMLButtonElement>('[data-hub-channel-ack]')!.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    dispose(); mount.remove();

    const again = vi.fn(async () => {});
    dispose = render(() => <HubChannelConfirm nodeId={node.toUpperCase()} onConfirm={again} onCancel={cancel} />, mountIn());
    expect(mount.querySelector('[data-hub-channel-confirm]')).toBeNull();
    await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1));
    dispose(); mount.remove();

    const other = vi.fn(async () => {});
    dispose = render(() => <HubChannelConfirm nodeId={'ef'.repeat(32)} onConfirm={other} onCancel={cancel} />, mountIn());
    expect(mount.querySelector('[data-hub-channel-confirm]')).not.toBeNull();
    await Promise.resolve();
    expect(other).not.toHaveBeenCalled();
  });

  it('remembers the acknowledgement across restarts of the app', async () => {
    const node = '12'.repeat(32);
    dispose = render(() => <HubChannelConfirm nodeId={node} onConfirm={async () => {}} onCancel={() => {}} />, mountIn());
    mount.querySelector<HTMLButtonElement>('[data-hub-channel-ack]')!.click();
    expect(localStorage.getItem(`bitsov.hub-channel-ack.v1.${node}`)).toBe('accepted');
  });

  it('shows a failed open without losing the acknowledgement', async () => {
    const node = '34'.repeat(32);
    dispose = render(() => <HubChannelConfirm nodeId={node} onConfirm={() => Promise.reject('The hub is offline.')} onCancel={() => {}} />, mountIn());
    mount.querySelector<HTMLButtonElement>('[data-hub-channel-ack]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-soft-error] [role="alert"]')).not.toBeNull());
    expect(localStorage.getItem(`bitsov.hub-channel-ack.v1.${node}`)).toBe('accepted');
    expect(mount.querySelector<HTMLButtonElement>('[data-hub-channel-ack]')!.disabled).toBe(false);
  });
});
