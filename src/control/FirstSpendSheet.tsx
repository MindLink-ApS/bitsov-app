import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../i18n';
import { satsWhole } from './format';
import { ambiguousThousands, parseAmount } from './amountInput';
import { onEscape } from './escapeStack';
import type { BudgetPreset, PresetId, SpendLapse } from './types';

export type FirstSpendChoice = Pick<BudgetPreset, 'id' | 'ceiling_msat'>;

/** Reviews the app budget before invoking the existing approval action. */
export function FirstSpendSheet(props: {
  presets: BudgetPreset[];
  initialPreset: PresetId | null;
  maxDailyMsat: number;
  /** Same clamp as arm_want: the grant total, not its remaining balance. */
  grantBudgetMsat?: number;
  startsNow?: boolean;
  /** Spend-scoped paired token, but the host exposes no G1 capability here. */
  mayStartNow?: boolean;
  lapse?: SpendLapse | null;
  dailyExpired?: boolean;
  onRetry?: () => void;
  costLine: string;
  blockedReason: string | null;
  onPreset: (id: PresetId) => void;
  onAllow: (choice: FirstSpendChoice) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = createSignal(props.initialPreset);
  const [custom, setCustom] = createSignal(false);
  const [amount, setAmount] = createSignal('');
  const preset = () => props.presets.find(p => p.id === picked()) ?? props.presets.find(p => p.id === 'careful') ?? props.presets[0];
  const chosen = () => custom() ? parseAmount(amount(), 'sats') : preset()?.ceiling_msat ?? null;
  const withinGrant = (n: number) => Math.min(n, props.grantBudgetMsat ?? Infinity);
  const ceiling = () => chosen() === null ? null : withinGrant(chosen()!);
  const maximum = () => Math.min(props.maxDailyMsat, props.grantBudgetMsat ?? Infinity);
  const reason = () => {
    if (props.blockedReason) return props.blockedReason;
    if (!preset()) return t('firstSpendNoPresets');
    if (custom() && ambiguousThousands(amount(), 'sats')) return t('amountUseSpaces');
    const n = ceiling();
    if (n === null || !Number.isSafeInteger(n) || n < 1000 || n > maximum())
      return t('firstSpendAmountReason', satsWhole(maximum() / 1000));
    return null;
  };
  // This sheet is explicitly in sats, independent of the wallet denomination.
  const daily = () => ceiling() === null ? null : satsWhole(ceiling()! / 1000);
  const titleId = createUniqueId();
  const reasonId = createUniqueId();
  const amountId = createUniqueId();
  const costId = createUniqueId();
  const separateReason = () => reason() && reason() !== props.costLine;
  const describedBy = () => reason() ? (separateReason() ? reasonId : costId) : undefined;
  let dialog!: HTMLDivElement;
  let scrim!: HTMLDialogElement;
  let dragY: number | null = null;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    scrim.showModal();
    dialog.focus();
    const keepFocus = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) dialog.focus(); };
    document.addEventListener('focusin', keepFocus);
    onCleanup(onEscape(props.onCancel));
    onCleanup(() => {
      document.removeEventListener('focusin', keepFocus);
      scrim.close();
      queueMicrotask(() => { if (opener?.isConnected) opener.focus(); });
    });
  });
  const allow = () => {
    if (reason()) return;
    props.onAllow({ id: preset()!.id, ceiling_msat: ceiling()! });
  };
  return (
    <dialog ref={scrim} class="first-spend-scrim" aria-labelledby={titleId} data-first-spend-scrim
      onCancel={e => { e.preventDefault(); props.onCancel(); }}
      onClick={e => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div ref={dialog} class="first-spend-sheet"
        tabindex="-1" data-first-spend-sheet
        onKeyDown={e => {
          // Enter in a custom amount must not submit the underlying composer.
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); allow(); }
          if (e.key !== 'Tab') return;
          const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary'))
            .filter(el => !el.closest('details:not([open])') || el.tagName === 'SUMMARY');
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { e.preventDefault(); first?.focus(); }
        }}>
        <div class="first-spend-grabber" aria-hidden="true"
          onPointerDown={e => { dragY = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); }}
          onPointerUp={e => { if (dragY !== null && e.clientY - dragY > 60) props.onCancel(); dragY = null; }}
          onPointerCancel={() => { dragY = null; }} />
        <h2 id={titleId}>{daily() === null ? t('firstSpendTitleUnavailable') : t('firstSpendTitle', daily()!)}</h2>
        <Show when={props.startsNow} fallback={
          <Show when={props.mayStartNow} fallback={<>
            <p>{t('firstSpendOwnerBox')}</p>
            <p class="hint">{t('firstSpendApprovalOnly')}</p>
          </>}>
            <p>{daily() === null ? t('firstSpendMayStartNowUnavailable') : t('firstSpendMayStartNow', daily()!)}</p>
          </Show>
        }>
          <p>{daily() === null ? t('firstSpendStartsNowUnavailable') : t('firstSpendStartsNow', daily()!)}</p>
        </Show>
        <Show when={props.dailyExpired}><p class="hint">{t('uiYourDailyApprovalEnded')}</p></Show>
        <Show when={props.lapse}><p class="hint" data-budget-lapse={props.lapse}>
          {t(props.lapse === 'lost' ? 'uiYourNodeCanNoLongerApproveYourLast' : 'uiYourLastRequestLapsedBeforeItWasApproved')}
        </p></Show>
        <p id={costId} class="first-spend-cost money" data-first-spend-cost>{props.costLine}</p>
        <details class="first-spend-options">
          <summary>{t('firstSpendOtherOptions')}</summary>
          <p class="hint">{t('firstSpendAppPresets', satsWhole(maximum() / 1000))}</p>
          <div class="presets" role="radiogroup" aria-label={t('uiAppAllInPaymentsLimitRolling24Hours')}>
            <For each={props.presets}>{p => (
              <button type="button" class="chip" role="radio" aria-checked={!custom() && preset()?.id === p.id}
                data-preset={p.id} onClick={() => { setPicked(p.id); setCustom(false); props.onPreset(p.id); }}>
                {t('firstSpendDaily', satsWhole(withinGrant(p.ceiling_msat) / 1000))}
              </button>
            )}</For>
            <button type="button" class="chip" role="radio" aria-checked={custom()} data-first-spend-custom
              onClick={() => setCustom(true)}>{t('firstSpendCustom')}</button>
          </div>
          <Show when={custom()}>
            <label for={amountId}>{t('firstSpendCustomLabel')}</label>
            <input id={amountId} type="text" inputmode="decimal" data-first-spend-amount
              value={amount()} onInput={e => setAmount(e.currentTarget.value)} aria-describedby={describedBy()} />
          </Show>
        </details>
        <Show when={props.onRetry}><button type="button" class="link" data-first-spend-retry onClick={() => props.onRetry?.()}>{t('uiRetry')}</button></Show>
        <Show when={separateReason()}><p id={reasonId} class="hint" role="status" data-first-spend-reason>{reason()}</p></Show>
        <button type="button" class="primary money" data-first-spend-allow disabled={reason() !== null}
          aria-describedby={describedBy()} onClick={allow}>
          {daily() === null ? t('firstSpendAllowUnavailable') : t('firstSpendAllow', daily()!)}
        </button>
        <button type="button" class="link" data-first-spend-cancel onClick={props.onCancel}>{t('firstSpendNotNow')}</button>
      </div>
    </dialog>
  );
}
