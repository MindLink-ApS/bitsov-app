import { createEffect, createSignal, on, type Accessor } from 'solid-js';
import { language } from '../i18n';
import { amountText, parseAmount } from './amountInput';
import { denom, type Denom } from './prefs';

/** A visible draft belongs to the unit and language in which it was entered. */
export function createAmountDraft(options: {
  unit?: Accessor<Denom>;
  allowZero?: boolean;
  clearOnUnitChange?: boolean;
} = {}) {
  const unit = options.unit ?? denom;
  const [value, write] = createSignal('');
  const [cleared, setCleared] = createSignal(false);
  const setValue = (text: string) => { write(text); setCleared(false); };
  createEffect(on([unit, language], ([nextUnit, nextLanguage], previous) => {
    if (!previous) return;
    const [oldUnit, oldLanguage] = previous;
    if (nextUnit === oldUnit && nextLanguage === oldLanguage) return;
    const text = value();
    if (!text.trim()) return;
    const msat = options.allowZero && text.trim() === '0' ? 0 : parseAmount(text, oldUnit, oldLanguage);
    if (msat === null || (options.clearOnUnitChange && nextUnit !== oldUnit)) {
      write('');
      setCleared(true);
    } else {
      write(amountText(msat, nextUnit, nextLanguage));
    }
  }));
  return [value, setValue, cleared] as const;
}
