import { render } from 'solid-js/web';
import { ControlCenter } from '../../src/control/Shell';
import { FirstSpendSheet } from '../../src/control/FirstSpendSheet';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../../src/control/sample';
import { PhoneOnboarding } from '../../src/onboarding/PhoneOnboarding';
import { INITIAL_PAIRING } from '../../src/onboarding/pairing';
import { setLanguagePref, t } from '../../src/i18n';
import { applyResolvedTheme } from '../../src/control/prefs';
import { installKeyboardViewport } from '../../src/ios/keyboard';
import { installEdgeBack } from '../../src/ios/edgeBack';
import '../../src/styles.css';
const query = new URLSearchParams(location.search);
const lang = query.get('lang') === 'da' ? 'da' : 'en';
const scene = query.get('scene') || 'composer';
setLanguagePref(lang);
document.documentElement.dataset.platform = 'ios';
(globalThis as any).__TAURI_INTERNALS__ = {};
applyResolvedTheme('dark');
installKeyboardViewport(); installEdgeBack();
const forbid = () => { throw new Error('Preview forbids all payment, approval, send and call actions'); };
// Allow only read operations from the sample source; never connect to a real host.
const base = sampleSource();
const source = { ...base, onLive: async (handler: any) => { handler({type:'link',state:'open',detail:null}); return () => {}; } };
for (const key of ['budgetApprove','budgetResume','messageSend','spendRequest','sendFile','payInvoice','keysend','callStart','callAccept','joinDevice']) {
  if (key in source) (source as any)[key] = forbid;
}
if (scene === 'pairing') {
  // Clipboard unavailable is a supported manual-entry path; no clipboard is read.
  Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => { throw new Error('manual entry'); } } });
  render(() => <PhoneOnboarding platform="ios" locale={lang} status={() => ({ready:false, node_id:null,error:null})}
    pairing={() => INITIAL_PAIRING} device={() => null} preview={forbid} connect={forbid} retry={forbid} forget={forbid}
    beginJoin={forbid} join={async () => ({state:'idle'})} openSettings={forbid} openTailscale={forbid} onDone={forbid} />, document.getElementById('root')!);
  setTimeout(() => {
    document.querySelector<HTMLElement>('.phone-options summary')?.click();
    document.querySelector<HTMLButtonElement>('.phone-options > button')?.click();
  }, 400);
} else if (scene === 'first-spend') {
  // Mount the actual sheet directly: no Send or Allow press is needed.
  render(() => <FirstSpendSheet presets={SAMPLE_PRESETS} initialPreset="careful" maxDailyMsat={100_000_000}
    startsNow={query.get("mode") === "starts-now"} mayStartNow={query.get("mode") === "may-start-now"}
    costLine={t('firstSpendCost', '1 sat', '2 sats', '5 sats', '8 sats')}
    blockedReason={null} onAllow={forbid} onCancel={() => {}} onPreset={() => {}} />, document.getElementById('root')!);
  setTimeout(() => { document.querySelector<HTMLElement>('.first-spend-options summary')?.click(); document.querySelector<HTMLButtonElement>('[data-first-spend-custom]')?.click(); }, 400);
} else {
  render(() => <ControlCenter source={source} active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.getElementById('root')!);
}

// Compare native layout before and after each keystroke; never activate Allow.
if (scene === 'first-spend') {
  const measure = () => {
    const selectors = ['[data-first-spend-keyboard-summary]', '[data-first-spend-keyboard-daily]', '[data-first-spend-keyboard-cost]', '[data-first-spend-amount]', '[data-first-spend-allow]', '[data-first-spend-cancel]'];
    return { viewportHeight: window.visualViewport!.height,
      allowDisabled: document.querySelector<HTMLButtonElement>('[data-first-spend-allow]')!.disabled,
      daily: document.querySelector('[data-first-spend-keyboard-daily]')!.textContent,
      cost: document.querySelector('[data-first-spend-keyboard-cost]')!.textContent,
      value: document.querySelector<HTMLInputElement>('[data-first-spend-amount]')!.value,
      scrollTop: document.querySelector('[data-first-spend-sheet]')!.scrollTop,
      elements: selectors.map(selector => ({ selector, ...document.querySelector(selector)!.getBoundingClientRect().toJSON() })) };
  };
  const evidence: ReturnType<typeof measure>[] = [];
  (window as any).keyboardTypingEvidence = evidence;
  document.addEventListener('beforeinput', () => { if (!evidence.length) evidence.push(measure()); });
  document.addEventListener('input', () => requestAnimationFrame(() => evidence.push(measure())));
}
