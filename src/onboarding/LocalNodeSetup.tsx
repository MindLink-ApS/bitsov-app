import { t } from '../i18n';
import { createSignal, Show } from 'solid-js';
import { onboardingDiagnostic } from './pairing';

/**
 * A fresh Mac: nothing exists until the owner asks for it. Only this button
 * creates a local node, with its recovery phrase and wallet.
 */
export function LocalNodeSetup(props: { onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const confirm = async () => {
    if (busy()) return;
    setBusy(true); setError(null);
    try { await props.onConfirm(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div class="panel" data-local-setup aria-busy={busy()}>
    <h2>{t('obSetUpMacTitle')}</h2>
    <p>{t('obNothingCreated')}{' '}{t('obSetUpMacExplain')}</p>
    <p class="hint">{t('obSetUpMacOther')}</p>
    <Show when={error()}><p class="error" role="alert">{onboardingDiagnostic(error()!, t('obPairingLinkHelp'))}</p></Show>
    <button type="button" class="primary" data-local-setup-confirm disabled={busy()} onClick={() => void confirm()}>
      {busy() ? t('obSettingUpMac') : t('obSetUpMacConfirm')}
    </button>
  </div>;
}
