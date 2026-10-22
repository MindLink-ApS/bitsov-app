import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { FirstSpendSheet } from '../src/control/FirstSpendSheet';
import { setLanguagePref } from '../src/i18n';
import { SAMPLE_PRESETS } from '../src/control/sample';
import type { BudgetPreset, NodeGrantSummary, PresetId } from '../src/control/types';

let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); });
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (selector: string) => mount.querySelector<HTMLButtonElement>(selector)!;
function setup(options: { presets?: BudgetPreset[]; reason?: string; max?: number; cost?: string; grant?: NodeGrantSummary; initialPreset?: PresetId } = {}) {
  const allow = vi.fn();
  const cancel = vi.fn();
  const [reason, setReason] = createSignal(options.reason ?? null);
  mount = document.createElement('div'); document.body.appendChild(mount);
  dispose = render(() => <FirstSpendSheet presets={options.presets ?? SAMPLE_PRESETS}
    initialPreset={options.initialPreset ?? "careful"} grant={options.grant} startsNow={!!options.grant} maxDailyMsat={options.max ?? 100_000_000}
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
  it('uses the box unit for fractional custom limits and passes the exact msat amount', () => {
    setLanguagePref(lang); const { allow } = setup();
    mount.querySelector('summary')!.click(); button('[data-first-spend-custom]').click();
    const input = mount.querySelector<HTMLInputElement>('[data-first-spend-amount]')!;
    input.value = '1 250.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text(mount.querySelector('h2'))).toContain('1 250 500 msat');
    expect(text(button('[data-first-spend-allow]'))).toContain('1 250 500 msat');
    button('[data-first-spend-allow]').click();
    expect(allow).toHaveBeenCalledWith({ ceiling_msat: 1_250_500, id: 'careful' });
  });
  it.each([300_500, 2_000_000])('collapses equal capped presets and preserves the selected policy (%s msat)', budget => {
    setLanguagePref(lang);
    const { allow } = setup({ initialPreset: 'generous', grant: {
      budget_msat: budget, remaining_msat: 200_000, per_call_max_msat: 50_000,
      expires_at_ms: new Date(2030, 0, 2, 14, 30).getTime(), envelopes: null,
    } });
    const chips = Array.from(mount.querySelectorAll('[data-preset]'));
    expect(chips).toHaveLength(budget === 300_500 ? 1 : 2);
    expect(new Set(chips.map(text)).size).toBe(chips.length);
    const selected = mount.querySelectorAll('[data-preset][aria-checked="true"]');
    expect(selected).toHaveLength(1);
    expect(text(selected[0])).toContain(budget === 300_500 ? '300 500 msat' : '2 000 sats');
    const grant = mount.querySelector('[data-first-spend-grant]');
    expect(text(grant)).toContain('200 sats');
    expect(text(grant)).toContain('14:30');
    expect(text(grant)).not.toContain('300 500');
    expect(grant?.closest('details')).toBeNull();
    // Clicking the already selected collapsed amount must not silently change
    // the saved contact/room policy to the representative chip's preset.
    (selected[0] as HTMLButtonElement).click();
    button('[data-first-spend-custom]').click();
    (selected[0] as HTMLButtonElement).click();
    button('[data-first-spend-allow]').click();
    expect(allow).toHaveBeenCalledWith({ ceiling_msat: budget, id: 'generous' });
  });
  it.each([[300_500, 0], [300_500, 500], [300_500, 999], [300_500, 1000], [500, 500]])('explains a grant of %s msat with %s msat left without an impossible amount range', (budget, remaining) => {
    setLanguagePref(lang);
    const { allow } = setup({ grant: {
      budget_msat: budget, remaining_msat: remaining, per_call_max_msat: 50_000,
      expires_at_ms: Date.now() + 60_000, envelopes: null,
    } });
    const primary = button('[data-first-spend-allow]');
    expect(primary.disabled).toBe(remaining < 1000);
    if (remaining < 1000) {
      const reason = text(mount.querySelector(`#${primary.getAttribute('aria-describedby')}`));
      expect(reason).toContain(lang === 'en' ? 'less than 1 sat' : 'mindre end 1 sat');
      expect(reason).toContain(lang === 'en' ? 'owner' : 'ejer');
      primary.click(); expect(allow).not.toHaveBeenCalled();
    }
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

it('traps focus, dismisses by swipe, and restores focus to the opener without allowing', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const { cancel, allow } = setup();
  const sheet = button('[data-first-spend-sheet]');
  expect(document.activeElement).toBe(sheet);
  sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  expect(document.activeElement).toBe(button('[data-first-spend-cancel]'));
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(mount.querySelector('summary'));
  opener.focus(); expect(document.activeElement).toBe(sheet);
  const grabber = mount.querySelector('.first-spend-grabber')!;
  grabber.dispatchEvent(new PointerEvent('pointerdown', { clientY: 100, pointerId: 1, bubbles: true }));
  grabber.dispatchEvent(new PointerEvent('pointerup', { clientY: 180, pointerId: 1, bubbles: true }));
  expect(cancel).toHaveBeenCalledOnce(); expect(allow).not.toHaveBeenCalled();
  dispose?.(); dispose = undefined;
  await Promise.resolve(); expect(document.activeElement).toBe(opener); opener.remove();
});
