import { afterEach, describe, expect, it } from 'vitest';
import { inertOutside } from '../src/control/modalInert';

const settle = () => new Promise((r) => setTimeout(r, 0));

function page() {
  document.body.innerHTML = `
    <main data-app>
      <nav data-tabs><button>Chats</button></nav>
      <section data-track><button>Send</button></section>
      <p role="status" data-notice>Connected <button data-notice-open>Open</button></p>
      <span role="status" aria-live="polite" data-live>Sent</span>
      <div class="call-panel"><button data-hang-up>End</button></div>
      <aside data-modal><button>Close</button></aside>
    </main>`;
  const q = (sel: string) => document.querySelector(sel) as HTMLElement;
  return { q, modal: q('[data-modal]') };
}

describe('inertOutside', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('keeps inert that another owner set before the modal opened', () => {
    const { q, modal } = page();
    q('[data-tabs]').setAttribute('inert', '');
    const release = inertOutside(modal, '.call-panel');
    expect(q('[data-tabs]').hasAttribute('inert')).toBe(true);
    release();
    expect(q('[data-tabs]').hasAttribute('inert')).toBe(true);
    expect(q('[data-track]').hasAttribute('inert')).toBe(false);
  });

  it('follows what other owners write while the modal is open', async () => {
    const { q, modal } = page();
    q('[data-track]').setAttribute('inert', '');
    const release = inertOutside(modal, '.call-panel');
    q('[data-tabs]').setAttribute('inert', ''); // another owner now wants it
    q('[data-track]').removeAttribute('inert'); // another owner let go
    await settle();
    // Still modal while open.
    expect(q('[data-track]').hasAttribute('inert')).toBe(true);
    release();
    expect(q('[data-tabs]').hasAttribute('inert')).toBe(true);
    expect(q('[data-track]').hasAttribute('inert')).toBe(false);
  });

  it('leaves live regions announcing but makes their controls inert, also ones added later', async () => {
    const { q, modal } = page();
    const release = inertOutside(modal, '.call-panel');
    expect(q('[data-notice]').hasAttribute('inert')).toBe(false);
    expect(q('[data-live]').hasAttribute('inert')).toBe(false);
    expect(q('[data-notice-open]').hasAttribute('inert')).toBe(true);
    const late = document.createElement('button');
    q('[data-live]').appendChild(late);
    await settle();
    expect(late.hasAttribute('inert')).toBe(true);
    // Call panels stay usable.
    expect(q('[data-hang-up]').closest('[inert]')).toBeNull();
    release();
    expect(q('[data-notice-open]').hasAttribute('inert')).toBe(false);
    expect(late.hasAttribute('inert')).toBe(false);
  });
});
