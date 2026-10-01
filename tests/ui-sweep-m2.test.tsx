import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';

// M2 UI sweep: a Signal-like single composer bar, icon call buttons, Profile /
// Browse names, plain-language ⓘ cards on the Body terms, a calm payment line.

describe('M2 UI sweep', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;
  const $ = <T extends Element = HTMLElement>(s: string) => mount.querySelector<T>(s);

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
  });

  const start = async () => {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(
      () => <ControlCenter source={sampleSource()} active={true} ready={true} error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />,
      mount,
    );
    await vi.waitFor(() => expect($('[data-composer]')).not.toBeNull());
  };

  it('Enter sends and Shift+Enter does not', async () => {
    await start();
    const ta = $<HTMLTextAreaElement>('[data-composer] textarea')!;
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(shift);
    expect(shift.defaultPrevented).toBe(false);
    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    ta.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
  });

  it('keeps cost and rules out of the bar; panels close back to the message bar', async () => {
    await start();
    expect($('[data-composer-bar] [data-cost]')).toBeNull();
    expect($('[data-composer-bar]')!.textContent).not.toMatch(/limit|approve|rules/i);
    $<HTMLButtonElement>('[data-composer-mode="pay"]')!.click();
    await vi.waitFor(() => expect($('[data-composer-panel="pay"]')).not.toBeNull());
    expect($<HTMLTextAreaElement>('[data-composer-bar] textarea')!.disabled).toBe(true);
    $<HTMLButtonElement>('[data-composer-close]')!.click();
    await vi.waitFor(() => expect($('[data-composer-panel]')).toBeNull());
    expect($<HTMLTextAreaElement>('[data-composer-bar] textarea')!.disabled).toBe(false);
  });

  it('call buttons are icons with the price in the label only', async () => {
    await start();
    for (const c of ['audio', 'video', 'meeting']) {
      const b = $(`[data-call="${c}"]`)!;
      expect(b.textContent).toBe('');
      expect(b.querySelector('svg')).not.toBeNull();
    }
  });

  it('Profile and Browse replace Front door and Discover; Rooms displays coming soon', async () => {
    await start();
    expect($('[data-tab="frontdoor"]')!.textContent).toBe('Profile');
    const heads = [...mount.querySelectorAll('.track-group h2')].map((h) => h.textContent);
    expect(heads).toContain('Browse');
    expect(heads).not.toContain('Discover');
    expect($('[data-rooms-coming-soon]')!.textContent).toMatch(/Coming soon/);
    expect($('[data-browse-pages-soon]')).not.toBeNull();

    const roomBtn = mount.querySelector<HTMLButtonElement>('[data-track^="room:"]');
    if (roomBtn) {
      roomBtn.click();
      await vi.waitFor(() => expect($('[data-room-day-notice]')).not.toBeNull());
      expect($('[data-room-day-notice]')!.textContent).toMatch(/Coming soon — group chat is not on the protocol yet/);
    }
  });

  it('hides the legacy introduction path on Start', async () => {
    await start();
    mount.querySelector<HTMLButtonElement>('[data-track="new"]')!.click();
    await vi.waitFor(() => expect($('[data-new-track]')).not.toBeNull());
    expect($('[data-intro-mine]')).toBeNull();
    expect($('[data-intro-open]')).toBeNull();
  });

  it('opens a plain-language card from each Body term ⓘ', async () => {
    await start();
    for (const id of ['metabolism', 'membrane', 'setpoints', 'immune']) {
      $<HTMLButtonElement>(`[data-info="${id}"]`)!.click();
      await vi.waitFor(() => expect($(`[data-info-modal="${id}"]`)).not.toBeNull());
      expect(mount.querySelectorAll(`[data-info-modal="${id}"] .info-card`).length).toBeGreaterThanOrEqual(2);
      $<HTMLButtonElement>('[data-info-close]')!.click();
      await vi.waitFor(() => expect($('[data-info-modal]')).toBeNull());
    }
  });
});
