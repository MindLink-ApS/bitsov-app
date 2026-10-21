import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { ControlCenter } from '../src/control/Shell';
import { sampleSource, SAMPLE_OWN_ID } from '../src/control/sample';
import type { Source } from '../src/control/source';

// UI/UX audit 21 Oct: a mis-tap on the chat header started a paid video call.
// The header buttons keep their names, a tap only asks, and the dialogs and
// menus around the composer close with Escape and give focus back.

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
const css = () => readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
const tick = () => new Promise((r) => setTimeout(r, 0));

async function shell(source: Source = sampleSource({ firstLiveMs: 1e9 })) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
  await vi.waitFor(() => expect($<HTMLButtonElement>('[data-call="audio"]')?.disabled).toBe(false));
  return source;
}

/** The accessible name the way a screen reader gets it here: aria-label, else text. */
const nameOf = (el: Element) => el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || '';

it('every chat-header button has an accessible name and a tooltip', async () => {
  await shell();
  const head = $('.track-head')!;
  const buttons = [...head.querySelectorAll('button')];
  expect(buttons.length).toBeGreaterThanOrEqual(5);
  for (const b of buttons) expect(nameOf(b), b.outerHTML.slice(0, 80)).not.toBe('');
  expect(nameOf($('[data-call="audio"]')!)).toMatch(/^Call Maya, up to \d/);
  expect(nameOf($('[data-call="video"]')!)).toMatch(/^Video call Maya, up to \d/);
  expect(nameOf($('[data-call="meeting"]')!)).toBe('Start a meeting with Maya');
  for (const sel of ['[data-call="audio"]', '[data-call="video"]', '[data-call="meeting"]', '.track-head .context-toggle']) {
    expect($<HTMLButtonElement>(sel)!.title, sel).not.toBe('');
  }
  // The icon buttons carry no visible words, so the svg must stay hidden from assistive tech.
  for (const svg of head.querySelectorAll('.call-buttons svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
});

it('a tap on Call or Video call only asks; nothing rings or pays until Ring', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const signal = vi.spyOn(source, 'callSignal');
  await shell(source);
  $<HTMLButtonElement>('[data-call="video"]')!.click();
  const box = $('[data-call-confirm-box="video"]')!;
  expect(box).not.toBeNull();
  expect(box.getAttribute('role')).toBe('dialog');
  expect(box.textContent).toMatch(/Video call Maya\?/);
  expect(box.textContent).toMatch(/Up to \d+ sats?\. Nothing is paid until you press Ring\./);
  expect($('[data-call="video"]')!.getAttribute('aria-expanded')).toBe('true');
  expect($('[data-call-panel]')).toBeNull();
  expect(signal).not.toHaveBeenCalled();
  await tick();
  expect(document.activeElement).toBe($('[data-call-confirm="video"]'));

  // Cancel closes it and nothing was placed.
  $<HTMLButtonElement>('[data-call-confirm-cancel]')!.click();
  expect($('[data-call-confirm-box]')).toBeNull();
  expect(document.activeElement).toBe($('[data-call="video"]'));

  // Escape closes it too.
  $<HTMLButtonElement>('[data-call="audio"]')!.click();
  expect($('[data-call-confirm-box="audio"]')).not.toBeNull();
  esc();
  expect($('[data-call-confirm-box]')).toBeNull();

  // A second tap on the same button closes it (no ring); a tap on the other switches.
  $<HTMLButtonElement>('[data-call="audio"]')!.click();
  $<HTMLButtonElement>('[data-call="audio"]')!.click();
  expect($('[data-call-confirm-box]')).toBeNull();
  $<HTMLButtonElement>('[data-call="audio"]')!.click();
  $<HTMLButtonElement>('[data-call="video"]')!.click();
  expect($('[data-call-confirm-box="video"]')).not.toBeNull();
  expect($('[data-call-confirm-box="audio"]')).toBeNull();
  expect(signal).not.toHaveBeenCalled();
});

it('a long contact name ellipsizes instead of running under the call buttons', () => {
  const s = css();
  expect(s).toMatch(/\.track-head h1 \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  expect(s).toMatch(/\.track-head > \.track-title-btn \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  expect(s).toMatch(/\.track-head > \.call-buttons, \.track-head > \.context-toggle \{ flex: none; \}/);
});

it('the composer + menu closes with Escape and gives focus back to +', async () => {
  await shell();
  const plus = $<HTMLButtonElement>('[data-composer-plus]')!;
  plus.click();
  expect($<HTMLElement>('[data-composer-menu]')!.hidden).toBe(false);
  await tick();
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
  esc();
  expect($<HTMLElement>('[data-composer-menu]')!.hidden).toBe(true);
  expect(document.activeElement).toBe(plus);
});

it('the emoji picker is a named group that closes with Escape', async () => {
  await shell();
  const btn = $<HTMLButtonElement>('[data-emoji]')!;
  btn.click();
  const picker = $('[data-emoji-picker]')!;
  expect(picker.getAttribute('role')).toBe('group');
  expect(picker.getAttribute('aria-label')).toBe('Emoji');
  esc();
  expect($('[data-emoji-picker]')).toBeNull();
  expect(document.activeElement).toBe(btn);
});

it('the You menu: focus moves in on open, Escape closes it and focus returns to You', async () => {
  await shell();
  const avatar = $<HTMLButtonElement>('[data-profile]')!;
  avatar.click();
  await tick();
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
  esc();
  expect($('[data-avatar-menu]')).toBeNull();
  expect(document.activeElement).toBe(avatar);
});

it('the contact sheet closes with Escape', async () => {
  await shell();
  $<HTMLButtonElement>('[data-contact-open]')!.click();
  await vi.waitFor(() => expect($('[data-contact-panel]')?.getAttribute('data-contact-panel')).toBe('open'));
  await tick();
  expect(document.activeElement).toBe($('[data-contact-close]'));
  esc();
  await vi.waitFor(() => expect($('[data-contact-panel]')?.getAttribute('data-contact-panel')).toBe('closed'));
});

it('open settings make the rail and the track inert behind the dialog', async () => {
  await shell();
  $<HTMLButtonElement>('.node-pill')!.click();
  await vi.waitFor(() => expect($('[data-settings-open]')?.getAttribute('data-settings-open')).toBe('true'));
  expect($('nav.rail')!.hasAttribute('inert')).toBe(true);
  expect($('section.track')!.hasAttribute('inert')).toBe(true);
  $<HTMLButtonElement>('[data-settings-close]')!.click();
  await vi.waitFor(() => expect($('section.track')!.hasAttribute('inert')).toBe(false));
  expect($('nav.rail')!.hasAttribute('inert')).toBe(false);
});

it('Hang up text meets 4.5:1 in dark mode, and the amount field shows keyboard focus', () => {
  const s = css();
  expect(s).toMatch(/button\.danger \{ background: var\(--err\); color: var\(--err-ink\);/);
  const dark = s.match(/--err: (#[0-9a-f]{6});\s*\/\*[^*]*\*\/\s*--err-ink: (#[0-9a-f]{6});/i)!;
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [a, b] = [lum(dark[1]), lum(dark[2])];
  expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
  expect(s).toMatch(/\.amount-field:has\(\.amount-input:focus-visible\) \{[^}]*outline: 2px solid var\(--accent\)/);
});
