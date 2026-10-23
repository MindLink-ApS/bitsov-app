import { OwnerApprovalSheets } from '../../../../src/control/OwnerApprovalSheet';
import { approvalMemory } from '../../../../src/control/OwnerApprovals';
import type { ApprovalView } from '../../../../src/control/ownerApproval';
const NOW = 1_800_000_000_000;
const request: ApprovalView = { op_id: 'fixture', node: 'n', client_id: 'phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
  request: {kind:'spend_grant', terms:{budget_msat:2_000_000, per_call_max_msat:10_000, window_secs:600}}, nonce:'11'.repeat(16),
  expires_at:NOW/1000+300, approval_message:'exact fixture signed bytes\nnever submitted', status:'pending', owner_action:null };
import { render } from 'solid-js/web';
import { ControlCenter } from '../../../../src/control/Shell';
import { FirstSpendSheet } from '../../../../src/control/FirstSpendSheet';
import { sampleSource, SAMPLE_OWN_ID, SAMPLE_PRESETS } from '../../../../src/control/sample';
import { setLanguagePref, t } from '../../../../src/i18n';
import { applyResolvedTheme } from '../../../../src/control/prefs';
import { installKeyboardViewport } from '../../../../src/ios/keyboard';
import { installEdgeBack } from '../../../../src/ios/edgeBack';
import '../../../../src/styles.css';
const query = new URLSearchParams(location.search);
const lang = query.get('lang') === 'da' ? 'da' : 'en';
const scene = query.get('scene') || 'composer';
setLanguagePref(lang);
document.documentElement.dataset.platform = query.get('platform') || 'ios';
(globalThis as any).__TAURI_INTERNALS__ = {};
applyResolvedTheme('dark');
installKeyboardViewport(); installEdgeBack();
const forbid = () => { throw new Error('Preview forbids all payment, approval, send and call actions'); };
// Allow only read operations from the sample source; never connect to a real host.
const base = sampleSource();
const source = { ...base, onLive: async (handler: any) => { handler({type:'link',state:'open',detail:null}); return () => {}; } };
if (query.has('large-balance')) source.wallet = async () => {
  const value = await base.wallet();
  return { ...value, balance_msat: Number.MAX_SAFE_INTEGER };
};
for (const key of ['budgetApprove','budgetResume','messageSend','spendRequest','sendFile','payInvoice','keysend','callStart','callAccept','joinDevice']) {
  if (key in source) (source as any)[key] = forbid;
}
if (scene === 'approval') {
  render(() => <OwnerApprovalSheets approvals={[request]} now={NOW} memory={approvalMemory()} approve={forbid} />, document.getElementById('root')!);
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


setTimeout(() => {
  if (scene === 'wallet' || scene === 'settings') {
    document.querySelector<HTMLButtonElement>('[data-profile]')!.click();
    document.querySelector<HTMLButtonElement>(scene === 'wallet' ? '[data-open-wallet]' : '[data-open-settings]')!.click();
  }
}, 700);
import { geometry } from './geometry';
(window as any).dynamicTypeGeometry = () => geometry(scene, lang);
const probes = document.createElement('div');
probes.style.cssText = 'position:fixed;left:-10000px;top:0';
probes.innerHTML = '<span class="target-radio-indicator">✓</span><span class="touchid-check">✓</span><span class="approvals-badge">12</span>';
document.body.append(probes);
