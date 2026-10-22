import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { FirstSpendSheet } from '../src/control/FirstSpendSheet';
import { setLanguagePref } from '../src/i18n';
import { SAMPLE_PRESETS } from '../src/control/sample';
import type { BudgetPreset } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); });
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!;
function setup(options: { presets?: BudgetPreset[]; reason?: string; max?: number; cost?: string } = {}) {
  const allow = vi.fn();
  const cancel = vi.fn();
  const [reason, setReason] = createSignal(options.reason ?? null);
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <FirstSpendSheet presets={options.presets ?? SAMPLE_PRESETS}
    initialPreset="careful" maxDailyMsat={options.max ?? 100_000_000}
    costLine={options.cost ?? 'Entry fee: 1 sat · message: 2 sats · routing fee at most: 5 sats · total at most: 8 sats'}
    blockedReason={reason()} onAllow={allow} onCancel={cancel} onPreset={() => {}} />, mount);
  return { allow, cancel, setReason };
}

describe.each(['en', 'da'] as const)('first spend sheet (%s)', (lang) => {
  const words = () => lang === 'en' ? {
    title: 'Let messages spend up to 500 sats a day?', allow: 'Allow 500 sats a day', other: 'Other options', cancel: 'Not now',
    owner: 'Approve at your box', reason: 'Connect to your node before allowing payments.',
  } : {
    title: 'Må beskeder bruge op til 500 sats om dagen?', allow: 'Tillad 500 sats om dagen', other: 'Andre muligheder', cancel: 'Ikke nu',
    owner: 'Godkend på din boks', reason: 'Opret forbindelse til din node, før du tillader betalinger.',
  };
  it('defaults to one Allow action and keeps costs outside collapsed options', () => {
    setLanguagePref(lang); const { allow } = setup();
    expect(text(mount.querySelector('h2'))).toBe(words().title);
    expect(text(button('[data-first-spend-allow]'))).toBe(words().allow);
    expect(text(mount)).toContain(words().owner);
    expect(mount.querySelectorAll('button.primary')).toHaveLength(1);
    const options = mount.querySelector('details')!;
    expect(options.open).toBe(false); expect(text(options.querySelector('summary'))).toBe(words().other);
    expect(mount.querySelector('[data-first-spend-cost]')?.closest('details')).toBeNull();
    expect(allow).not.toHaveBeenCalled();
    button('[data-first-spend-allow]').click();
    expect(allow).toHaveBeenCalledWith({ ceiling_msat: 500_000, id: 'careful' });
  });
  it('shows node presets and custom under Other options without authorizing on selection', () => {
    setLanguagePref(lang); const { allow } = setup();
    mount.querySelector('summary')!.click();
    expect(mount.querySelector('details')!.open).toBe(true);
    expect(text(button('[data-preset="everyday"]'))).toContain('2 000 sats');
    expect(text(button('[data-preset="generous"]'))).toContain('10 000 sats');
    button('[data-preset="everyday"]').click();
    expect(text(button('[data-first-spend-allow]'))).toContain('2 000 sats');
    button('[data-first-spend-custom]').click();
    const input = mount.querySelector<HTMLInputElement>('[data-first-spend-amount]')!;
    input.value = '1 250'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text(button('[data-first-spend-allow]'))).toContain('1 250 sats');
    expect(allow).not.toHaveBeenCalled();
    button('[data-first-spend-allow]').click();
    expect(allow).toHaveBeenCalledWith({ ceiling_msat: 1_250_000, id: 'everyday' });
  });
  it('Not now dismisses without requesting approval', () => {
    setLanguagePref(lang); const { allow, cancel } = setup();
    expect(text(button('[data-first-spend-cancel]'))).toBe(words().cancel);
    button('[data-first-spend-cancel]').click();
    expect(cancel).toHaveBeenCalledOnce(); expect(allow).not.toHaveBeenCalled();
  });
  it('explains a disabled primary and rechecks live readiness', () => {
    setLanguagePref(lang); const { allow, setReason } = setup();
    setReason(words().reason);
    const primary = button('[data-first-spend-allow]');
    expect(primary.disabled).toBe(true);
    expect(text(mount.querySelector(`#${primary.getAttribute('aria-describedby')}`))).toBe(words().reason);
    primary.click(); expect(allow).not.toHaveBeenCalled();
    setReason(null); expect(primary.disabled).toBe(false);
  });
  it('refuses missing node presets and invalid or over-limit custom amounts with a visible reason', () => {
    setLanguagePref(lang); const { allow } = setup({ max: 2_000_000 });
    mount.querySelector('summary')!.click(); button('[data-first-spend-custom]').click();
    const input = mount.querySelector<HTMLInputElement>('[data-first-spend-amount]')!;
    for (const value of ['', '0', '-1', '0.5', '2 001', '9007199254740992']) {
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(button('[data-first-spend-allow]').disabled).toBe(true);
      expect(text(mount.querySelector('[data-first-spend-reason]')).length).toBeGreaterThan(0);
    }
    expect(allow).not.toHaveBeenCalled();
  });
});

it('uses changed node preset values, including the default, without hardcoded amounts', () => {
  setup({ presets: SAMPLE_PRESETS.map(p => ({ ...p, ceiling_msat: p.ceiling_msat + 750_000 })) });
  expect(text(mount.querySelector('h2'))).toBe('Let messages spend up to 1 250 sats a day?');
  expect(text(button('[data-preset="everyday"]'))).toContain('2 750 sats');
});
it('does not invent a preset if the node supplies none', () => {
  setup({ presets: [] });
  expect(button('[data-first-spend-allow]').disabled).toBe(true);
  expect(text(mount.querySelector('[data-first-spend-reason]'))).toContain('presets');
});
it('Escape and the scrim dismiss without allowing', () => {
  const { cancel, allow } = setup();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(cancel).toHaveBeenCalledOnce();
  button('[data-first-spend-scrim]').click();
  expect(cancel).toHaveBeenCalledTimes(2); expect(allow).not.toHaveBeenCalled();
});
