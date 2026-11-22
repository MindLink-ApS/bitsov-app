import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { DiscoverPanel, FrontDoorEditor, frontDoorOwnerAsk } from '../src/control/Discover';
import { safeImageMime } from '../src/control/frontDoorMedia';
import {
  sampleSource,
  SAMPLE_FRONT_DOOR_LINK,
  SAMPLE_EXPIRED_FRONT_DOOR_LINK,
  SAMPLE_PUBLIC_FRONT_DOOR_LINK,
  SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK,
  SAMPLE_DISALLOWED_FRONT_DOOR_LINK,
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
    expect(root.querySelector('[data-fd-qr]')).toBeTruthy();
    expect(root.querySelector('[data-panel="discover"] .hint')?.textContent).not.toMatch(/scan a QR/i);
    expect(root.querySelector('[data-panel="discover"] .hint')?.textContent).toMatch(/does not scan/i);
    root.querySelector<HTMLInputElement>('[data-discover-local]')!.click();
    root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.click();
    await viWait();
    expect(knocked.length).toBe(64);
  });

  it('reading a card and knocking each say they are under way, and stop saying so when done', async () => {
    const source = sampleSource();
    const read = source.frontDoorRead.bind(source);
    let releaseRead!: () => void;
    source.frontDoorRead = (link) => new Promise((resolve, reject) => { releaseRead = () => void read(link).then(resolve, reject); });
    const open = source.frontDoorOpen.bind(source);
    let releaseOpen!: () => void;
    source.frontDoorOpen = (link, local) => new Promise((resolve, reject) => { releaseOpen = () => void open(link, local).then(resolve, reject); });
    let knocked = '';
    mount(() => <DiscoverPanel source={source} now={Date.now()} onKnocked={(c) => { knocked = c.node_id; }} />);
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_PUBLIC_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-discover-reading]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    expect(root.querySelector('[data-discover-reading]')?.textContent).toBe('Reading the card…');
    expect(root.querySelector('[data-discover-knock]')).toBeNull();
    releaseRead();
    await viWait();
    await viWait();
    expect(root.querySelector('[data-discover-reading]')).toBeNull();
    expect(root.querySelector('[data-discover-knocking]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.click();
    await viWait();
    expect(root.querySelector('[data-discover-knocking]')?.textContent).toBe('Knocking…');
    expect(root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.disabled).toBe(true);
    expect(knocked).toBe('');
    releaseOpen();
    await viWait();
    await viWait();
    expect(root.querySelector('[data-discover-knocking]')).toBeNull();
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

  it('hostile mime never becomes an image src', async () => {
    expect(safeImageMime('image/png" onerror="alert(1)')).toBeNull();
    expect(safeImageMime('image/png')).toBe('image/png');
    const source = sampleSource();
    mount(() => (
      <DiscoverPanel source={source} now={Date.now()} onKnocked={() => {}} />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_HOSTILE_MIME_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    const imgs = root.querySelectorAll('[data-fd-media] img');
    expect(imgs.length).toBe(0);
    expect(root.querySelector('[data-fd-media] .thumb-ph')).toBeTruthy();
    expect(root.querySelector('[data-fd-link-url]')?.textContent).toBe('https://example.invalid/path');
    expect(root.querySelector('[data-fd-link-open]')).toBeNull();
    expect(root.querySelector('[data-fd-link-copy]')).toBeTruthy();
  });

  it('disallowed dial address surfaces as a Knock error', async () => {
    const source = sampleSource();
    mount(() => (
      <DiscoverPanel source={source} now={Date.now()} onKnocked={() => {}} />
    ));
    const paste = root.querySelector<HTMLTextAreaElement>('[data-discover-paste]')!;
    paste.value = SAMPLE_DISALLOWED_FRONT_DOOR_LINK;
    paste.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-discover-read]')!.click();
    await viWait();
    root.querySelector<HTMLButtonElement>('[data-discover-knock]')!.click();
    await viWait();
    expect(root.querySelector('[data-discover-error]')?.textContent).toMatch(/does not allow/i);
  });

  it('publishes My front door from the editor with preview', async () => {
    const source = sampleSource();
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const name = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    name.value = 'Alex';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const about = root.querySelector<HTMLTextAreaElement>('[data-fd-edit-about]')!;
    about.value = 'Builder';
    about.dispatchEvent(new Event('input', { bubbles: true }));
    const web = root.querySelector<HTMLInputElement>('[data-fd-edit-website]')!;
    web.value = 'https://example.com';
    web.dispatchEvent(new Event('input', { bubbles: true }));
    await viWait();
    expect(root.querySelector('[data-fd-preview] [data-fd-name]')?.textContent).toBe('Alex');
    expect(root.querySelector('[data-fd-card-bytes]')?.getAttribute('data-over')).toBe('false');
    root.querySelector<HTMLButtonElement>('[data-fd-publish]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-link]')?.textContent).toMatch(/^bitsov:\/\/front-door#/);
    expect(root.querySelector('[data-fd-seq]')?.textContent).toMatch(/seq 2/);
    expect(root.querySelector('[data-fd-qr]')).toBeTruthy();
    expect(root.querySelector('[data-fd-preview] [data-fd-qr]')).toBeNull();
  });

  it('My front door waits for its read before you can type, and a failed read offers a retry that reads it again', async () => {
    const source = sampleSource();
    const mine = source.frontDoorMine.bind(source);
    let calls = 0;
    let release!: () => void;
    source.frontDoorMine = () => {
      calls += 1;
      if (calls === 1) return new Promise((_resolve, reject) => { release = () => reject({ code: 'node', message: 'Your node did not answer.' }); });
      return mine();
    };
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const panel = root.querySelector<HTMLElement>('[data-panel="front-door"]')!;
    expect(root.querySelector('[data-fd-loading]')).not.toBeNull();
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-busy')).toBe('true');
    release();
    await viWait();
    await viWait();
    expect(root.querySelector('[data-fd-loading]')).toBeNull();
    expect(panel.hasAttribute('inert')).toBe(false);
    const retry = root.querySelector<HTMLButtonElement>('[data-soft-error="fd-edit-error"] [data-soft-reconnect]');
    expect(retry).not.toBeNull();
    retry!.click();
    await viWait();
    await viWait();
    expect(calls).toBe(2);
    expect(root.querySelector('[data-soft-error="fd-edit-error"]')).toBeNull();
    expect(root.querySelector('[data-fd-loading]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[data-fd-edit-name]')).not.toBeNull();
  });

  it('shows the owner request with the node command when publishing needs front_door', async () => {
    const source = sampleSource();
    const publish = source.frontDoorPublish.bind(source);
    let asks = 0;
    source.frontDoorPublish = async (fields) => {
      if (asks++ === 0) {
        throw 'front_door_owner: Publishing your front door needs your permission at the node (it allows the card only: no spending, nothing else). On the node\'s computer run: konsensus grant --op 0a1b2c Then press Publish again.';
      }
      return publish(fields);
    };
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const name = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    name.value = 'Alex';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await viWait();
    root.querySelector<HTMLButtonElement>('[data-fd-publish]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-owner-command]')?.textContent).toBe('konsensus grant --op 0a1b2c');
    expect(root.querySelector('[data-fd-owner-action]')?.textContent).toContain('no spending');
    expect(root.querySelector('[data-fd-edit-error]')).toBeNull();
    // After the owner grants, the same button publishes and the request goes away.
    root.querySelector<HTMLButtonElement>('[data-fd-publish]')!.click();
    await viWait();
    expect(root.querySelector('[data-fd-owner-action]')).toBeNull();
    expect(root.querySelector('[data-fd-link]')?.textContent).toMatch(/^bitsov:\/\/front-door#/);
  });

  it('reads the owner request only from the host prefix', () => {
    expect(frontDoorOwnerAsk(null)).toBeNull();
    expect(frontDoorOwnerAsk('/front-door failed (403): token lacks required scope: admin')).toBeNull();
    expect(frontDoorOwnerAsk('front_door_owner: This node cannot let the app publish its front door. unavailable in this deployment'))
      .toEqual({ text: 'This node cannot let the app publish its front door. unavailable in this deployment', command: null });
    expect(frontDoorOwnerAsk('front_door_owner: run: konsensus grant --op ab12; rm -rf x')?.command).toBe('konsensus grant --op ab12');
    // The node's config rides along, quoted or plain; nothing past it does.
    expect(frontDoorOwnerAsk("front_door_owner: run: konsensus grant --op ab12 --config '/Users/owner/My Node/konsensus.toml' It asks")?.command)
      .toBe("konsensus grant --op ab12 --config '/Users/owner/My Node/konsensus.toml'");
    // Nothing that could hide or rewrite what the owner reads.
    for (const hostile of ["'/a/‮lmot.toml'", "'/a/o'\\''neil.toml'", "'/a\\'"]) {
      expect(frontDoorOwnerAsk(`front_door_owner: run: konsensus grant --op ab12 --config ${hostile} x`)?.command)
        .toBe('konsensus grant --op ab12');
    }
    expect(frontDoorOwnerAsk('front_door_owner: run: konsensus grant --op ab12 --config /srv/n/konsensus.toml It asks')?.command)
      .toBe('konsensus grant --op ab12 --config /srv/n/konsensus.toml');
    expect(frontDoorOwnerAsk('front_door_owner: run: konsensus grant --op ab12 --config $(rm -rf ~) x')?.command)
      .toBe('konsensus grant --op ab12');
  });

  it('blocks Publish when the serialized preview exceeds 16 KiB', async () => {
    const source = sampleSource();
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const name = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    name.value = 'Alex';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    // Oversized about + website push the estimate over without needing canvas.
    await viWait();
    // Re-mount with a card that already exceeds 16 KiB (max avatar + two max thumbs).
    root.remove();
    const fat = sampleSource();
    const origMine = fat.frontDoorMine.bind(fat);
    fat.frontDoorMine = async () => {
      const c = await origMine();
      return {
        ...c,
        profile: {
          ...c.profile,
          avatar: {
            inline_b64: 'A'.repeat(10_900),
            hash: 'ab'.repeat(32),
            size: 8000,
            mime: 'image/jpeg',
          },
        },
        media: [
          {
            hash: 'cd'.repeat(32),
            size: 4000,
            mime: 'image/jpeg',
            thumb_b64: 'B'.repeat(5500),
            title: 'one',
          },
          {
            hash: 'ef'.repeat(32),
            size: 4000,
            mime: 'image/jpeg',
            thumb_b64: 'C'.repeat(5500),
            title: 'two',
          },
        ],
      };
    };
    mount(() => <FrontDoorEditor source={fat} now={Date.now()} />);
    await viWait();
    const n = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    expect(n.value.length).toBeGreaterThan(0);
    await viWait();
    expect(root.querySelector('[data-fd-card-bytes]')?.getAttribute('data-over')).toBe('true');
    const pub = root.querySelector<HTMLButtonElement>('[data-fd-publish]')!;
    expect(pub.disabled).toBe(true);
    expect(root.querySelector('[data-fd-card-bytes]')?.textContent).toMatch(/too large/i);
    // Force the click path: publish() still refuses when over budget.
    pub.disabled = false;
    pub.click();
    await viWait();
    expect(root.querySelector('[data-fd-edit-error]')?.textContent).toMatch(/over|16384|bytes/i);
  });

  it('hashes CV text through the host before publish', async () => {
    const source = sampleSource();
    const hashes: string[] = [];
    const orig = source.frontDoorHashBytes.bind(source);
    source.frontDoorHashBytes = async (b64) => {
      const h = await orig(b64);
      hashes.push(h);
      return h;
    };
    let publishedCv: { hash: string; size: number; path: string } | undefined;
    const origPub = source.frontDoorPublish.bind(source);
    source.frontDoorPublish = async (fields) => {
      publishedCv = fields.cv;
      return origPub(fields);
    };
    mount(() => <FrontDoorEditor source={source} now={Date.now()} />);
    await viWait();
    const name = root.querySelector<HTMLInputElement>('[data-fd-edit-name]')!;
    name.value = 'Alex';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const cv = root.querySelector<HTMLTextAreaElement>('[data-fd-edit-cv]')!;
    cv.value = 'CV line one\nCV line two';
    cv.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-fd-publish]')!.click();
    await viWait();
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    expect(publishedCv?.path).toBe('cv.md');
    expect(publishedCv?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(publishedCv?.size).toBe('CV line one\nCV line two'.length);
  });
});

function viWait() {
  return new Promise((r) => setTimeout(r, 0));
}
