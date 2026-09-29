import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { DiscoverPanel, FrontDoorEditor } from '../src/control/Discover';
import {
  sampleSource,
  SAMPLE_FRONT_DOOR_LINK,
  SAMPLE_EXPIRED_FRONT_DOOR_LINK,
  SAMPLE_PUBLIC_FRONT_DOOR_LINK,
} from '../src/control/sample';

describe('front door Discover and editor', () => {
  let root: HTMLDivElement;
  afterEach(() => {
    root?.remove();
  });

  function mount(node: () => JSX.Element) {
    root = document.createElement('div');
    document.body.appendChild(root);
    return render(node, root);
  }

  it('reads a pasted sample card and shows Knock', async () => {
    const source = sampleSource();
    let knocked = '';
    mount(() => (
      <DiscoverPanel
        source={source}
        now={Date.now()}
        onKnocked={(c) => {
          knocked = c.node_id;
        }}
      />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-name]')?.textContent).toBe('Ada');
    expect(root.querySelector('[data-discover-knock]')?.textContent).toBe('Knock');
    expect(root.querySelector('[data-fd-knock-price]')?.textContent).toMatch(/sat/);
    // Local reach needs consent before Knock.
    root.querySelector<HTMLInputElement>('[data-discover-local]')!.click();
    root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.click();
    await viWait();
    expect(knocked.length).toBe(64);
  });

  it('expired card renders but blocks Knock', async () => {
    const source = sampleSource();
    mount(() => (
      <DiscoverPanel source={source} now={Date.now()} onKnocked={() => {}} />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_EXPIRED_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-name]')?.textContent).toBe('Ada');
    expect(root.querySelector('[data-discover-stale]')).toBeTruthy();
    expect(root.querySelector('[data-discover-knock]')).toBeNull();
  });

  it('public card Knocks without local consent', async () => {
    const source = sampleSource();
    let knocked = '';
    mount(() => (
      <DiscoverPanel
        source={source}
        now={Date.now()}
        onKnocked={(c) => {
          knocked = c.node_id;
        }}
      />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_PUBLIC_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    expect(root.querySelector('[data-discover-local]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.click();
    await viWait();
    expect(knocked.length).toBe(64);
  });

  it('local card refuses Knock until consent', async () => {
    const source = sampleSource();
    let knocked = '';
    mount(() => (
      <DiscoverPanel
        source={source}
        now={Date.now()}
        onKnocked={(c) => {
          knocked = c.node_id;
        }}
      />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    const knock = root.querySelector<HTMLButtonElement>('[data-discover-knock]')!;
    expect(knock.disabled).toBe(true);
    knock.click();
    await viWait();
    expect(knocked).toBe('');
  });

  it('publishes My front door from the editor', async () => {
    const source = sampleSource();
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const name = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    name.value = 'Rasmus';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-fd-publish]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-link]')?.textContent).toMatch(/^bitsov:\/\/front-door#/);
    expect(root.querySelector('[data-fd-seq]')?.textContent).toMatch(/seq 2/);
  });
});

function viWait() {
  return new Promise((r) => setTimeout(r, 0));
}
