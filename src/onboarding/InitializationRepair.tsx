import { t } from '../i18n';
import { createSignal, Show } from 'solid-js';
import { onboardingDiagnostic } from './pairing';

/** Shown only after the supervised node refuses its existing data directory. */
export function InitializationRepair(props: { priceFloor?: boolean; repairing: boolean; onConfirm: () => Promise<void> }) {
  const [declined, setDeclined] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const working = () => busy() || props.repairing;
  const confirm = async () => {
    if (working()) return;
    setBusy(true); setError(null);
    try { await props.onConfirm(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section class="panel disclosure" data-initialization-repair aria-busy={working()}>
    <h1>{t('obUpdateNeeded')}</h1>
    <Show when={props.priceFloor} fallback={<>
    <p>{t('obRepairExplanation')}</p>
    <p>{t('obRepairConsent')}</p>
    <p>{t('obRepairBackup')}</p>
    <p>{t('obRepairOnlyWithConsent')}</p>
    </>}>
      <p>{t('obRepairPagePrice')}</p>
      <p>{t('obRepairPagePriceConsent')}</p>
    </Show>
    <p class="hint">{t('obRepairHelp')}</p>
    <Show when={error()}><p class="error" role="alert">{onboardingDiagnostic(error()!, t('obRepairHelp'))}</p></Show>
    <Show when={!declined()} fallback={<>
      <p>{t('obNodeRemainsStopped')}</p>
      <button class="quiet" data-repair-review onClick={() => setDeclined(false)}>{t('obReviewUpdate')}</button>
    </>}>
      <button class="primary" data-repair-consent disabled={working()} onClick={() => void confirm()}>{working() ? t('obUpdatingNode') : t('obRepairAgree')}</button>
      <button class="quiet" data-repair-decline disabled={working()} onClick={() => setDeclined(true)}>{t('obNotNow')}</button>
    </Show>
  </section>;
}
