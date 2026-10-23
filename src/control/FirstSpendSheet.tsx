import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../i18n';
import { clock, day, satsWhole } from './format';
import { ambiguousThousands, parseAmount } from './amountInput';
import { onEscape } from './escapeStack';
import type { BudgetPreset, NodeGrantSummary, PresetId, SpendLapse } from './types';

// Display only: match the box's whole-sat / integer-msat convention, regardless
// of the wallet denomination. Never round the amount passed to budget_approve.
const budgetAmount = (msat: number) => msat % 1000 === 0
  ? `${satsWhole(msat / 1000)} ${msat === 1000 ? 'sat' : 'sats'}`
  : `${satsWhole(msat)} msat`;

export type FirstSpendChoice = Pick<BudgetPreset, 'id' | 'ceiling_msat'>;

/** Reviews the app budget before invoking the existing approval action. */
export function FirstSpendSheet(props: {
  presets: BudgetPreset[];
  initialPreset: PresetId | null;
  maxDailyMsat: number;
  /** Same clamp as arm_want: the grant total, not its remaining balance. */
  grant?: Pick<NodeGrantSummary, 'budget_msat' | 'remaining_msat' | 'expires_at_ms'>;
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
  const withinGrant = (n: number) => Math.min(n, props.grant?.budget_msat ?? Infinity);
  const ceiling = () => chosen() === null ? null : withinGrant(chosen()!);
  const maximum = () => Math.min(props.maxDailyMsat, props.grant?.budget_msat ?? Infinity);
  const distinctPresets = createMemo(() => {
    const seen = new Set<number>();
    return props.presets.filter(p => {
      const n = withinGrant(p.ceiling_msat);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  });
  const reason = () => {
    if (props.blockedReason) return props.blockedReason;
    if (!preset()) return t('firstSpendNoPresets');
    if (props.grant && (props.grant.remaining_msat < 1000 || props.grant.budget_msat < 1000))
      return t('firstSpendGrantTooLow');
    if (custom() && ambiguousThousands(amount(), 'sats')) return t('amountUseSpaces');
    const n = ceiling();
    if (n === null || !Number.isSafeInteger(n) || n < 1000 || n > maximum())
      return t('firstSpendAmountReason', budgetAmount(maximum()));
    return null;
  };
  // Input is in sats; fractional ceilings use exact integer msat, as at the box.
  const daily = () => ceiling() === null ? null : budgetAmount(ceiling()!);
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
        <div class="first-spend-keyboard-summary money" data-first-spend-keyboard-summary>
          <strong data-first-spend-keyboard-daily>{daily() === null ? t('firstSpendAllowUnavailable') : t('firstSpendAllow', daily()!)}</strong>
          <span data-first-spend-keyboard-cost>{props.costLine}</span>
        </div>
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
            <p class="first-spend-may-start-now">{daily() === null ? t('firstSpendMayStartNowUnavailable') : t('firstSpendMayStartNow', daily()!)}</p>
          </Show>
        }>
          <p class="first-spend-starts-now">{daily() === null ? t('firstSpendStartsNowUnavailable') : t('firstSpendStartsNow', daily()!)}</p>
        </Show>
        <Show when={props.grant}>{grant => (
          <p class="hint" data-first-spend-grant>
            {t('firstSpendGrantRemaining', budgetAmount(grant().remaining_msat), `${day(grant().expires_at_ms)} ${clock(grant().expires_at_ms)}`)}
          </p>
        )}</Show>
        <Show when={props.dailyExpired}><p class="hint">{t('uiYourDailyApprovalEnded')}</p></Show>
        <Show when={props.lapse}><p class="hint" data-budget-lapse={props.lapse}>
          {t(props.lapse === 'lost' ? 'uiYourNodeCanNoLongerApproveYourLast' : 'uiYourLastRequestLapsedBeforeItWasApproved')}
        </p></Show>
        <p id={costId} class="first-spend-cost money" data-first-spend-cost>{props.costLine}</p>
        <details class="first-spend-options">
          <summary>{t('firstSpendOtherOptions')}</summary>
          <p class="hint">{t('firstSpendAppPresets', budgetAmount(maximum()))}</p>
          <div class="presets" role="radiogroup" aria-label={t('uiAppAllInPaymentsLimitRolling24Hours')}>
            <For each={distinctPresets()}>{p => (
              <button type="button" class="chip" role="radio" aria-checked={!custom() && ceiling() === withinGrant(p.ceiling_msat)}
                data-preset={p.id} onClick={() => {
                  // Equal capped amounts represent the saved policy too. Selecting
                  // that amount again must not silently replace its contact limits.
                  if (withinGrant(preset()?.ceiling_msat ?? NaN) !== withinGrant(p.ceiling_msat)) {
                    setPicked(p.id); props.onPreset(p.id);
                  }
                  setCustom(false);
                }}>
                {t('firstSpendDaily', budgetAmount(withinGrant(p.ceiling_msat)))}
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
        <div class="first-spend-reason-slot">
          <Show when={separateReason()}><p id={reasonId} class="hint" role="status" data-first-spend-reason>{reason()}</p></Show>
        </div>
        <button type="button" class="primary money" data-first-spend-allow disabled={reason() !== null}
          aria-describedby={describedBy()} onClick={allow}>
          {daily() === null ? t('firstSpendAllowUnavailable') : t('firstSpendAllow', daily()!)}
        </button>
        <button type="button" class="link" data-first-spend-cancel onClick={props.onCancel}>{t('firstSpendNotNow')}</button>
      </div>
    </dialog>
  );
}
