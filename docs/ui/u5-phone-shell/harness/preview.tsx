// Read-only native preview. Production components, sample data, no node or signing.
import { render } from 'solid-js/web';
import { ControlCenter } from '../../../../src/control/Shell';
import { FirstSpendSheet } from '../../../../src/control/FirstSpendSheet';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../../../../src/control/sample';
import { setLanguagePref, t } from '../../../../src/i18n';
import { applyResolvedTheme } from '../../../../src/control/prefs';
import { installKeyboardViewport } from '../../../../src/ios/keyboard';
import { installEdgeBack } from '../../../../src/ios/edgeBack';
import '../../../../src/styles.css';
import { geometry } from './geometry';
const query = new URLSearchParams(location.search);
const lang = query.get('lang') === 'da' ? 'da' : 'en';
const scene = query.get('scene') || 'list';
setLanguagePref(lang);
document.documentElement.dataset.platform = query.get('platform') || 'ios';
(globalThis as any).__TAURI_INTERNALS__ = {};
applyResolvedTheme('dark'); installKeyboardViewport(); installEdgeBack();
const forbid = () => { throw new Error('U5 preview forbids transactions, approvals and calls'); };
const base = sampleSource({ rooms: true });
const reads = new Set(['nodeOverview', 'peers', 'rooms', 'wallet', 'spendStatus', 'deviceStatus', 'budget', 'budgetPresets', 'messages', 'price', 'filePrice', 'opList', 'roomMembers', 'roomQuote', 'doorPrice', 'energy', 'membrane', 'frontDoor', 'starterCurrent', 'fundingAddress', 'invoiceStatus']);
// The sample source has no host access. In addition, reject all writes by name.
const source = new Proxy(base, { get(target, key: keyof typeof base) {
  if (key === 'onLive') return async (handler: any) => { handler({ type: 'link', state: 'open', detail: null }); return () => {}; };
  if (key === 'starterCurrent') return async () => ({ state: 'not_requested', hub_configured: true });
  if (key === 'nodeOverview') return async () => { const value = await base.nodeOverview(); return { ...value, network: 'signet', capabilities: [...(value.capabilities ?? []), 'starter_channel_request_v1'] }; };
  if (typeof target[key] === 'function' && /send|approve|request|signal|pay|keysend|invoice$|accept|join|grant|resume|endCall/i.test(key) && !reads.has(key)) return forbid;
  return target[key];
} });
render(() => <ControlCenter source={source} active ready live error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, document.getElementById('root')!);
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();
setTimeout(() => {
  if (['chat', 'first-spend', 'pay', 'keyboard'].includes(scene)) click('[data-phone-list] [data-track^="peer:"]');
  if (scene === 'wallet' || scene === 'starter') click('[data-phone-tab="wallet"]');
  if (scene === 'you') click('[data-phone-tab="you"]');
  if (scene === 'first-spend') {
    // Mount the actual top-layer sheet over the actual shell without pressing Send.
    const mount = document.createElement('div'); document.body.append(mount);
    render(() => <FirstSpendSheet presets={SAMPLE_PRESETS} initialPreset="careful" maxDailyMsat={100_000_000}
      costLine={t('firstSpendCost', '1 sat', '2 sats', '5 sats', '8 sats')} blockedReason={null}
      onAllow={forbid} onCancel={() => {}} onPreset={() => {}} />, mount);
  }
  if (scene === 'starter') setTimeout(() => click('[data-starter-entry]'), 400);
}, 500);
(window as any).phoneGeometry = () => geometry(scene, lang);
