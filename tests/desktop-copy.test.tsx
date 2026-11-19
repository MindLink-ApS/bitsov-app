import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from '../src/control/ownerApproval';

const hosts = [
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', true],
  ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', false],
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', false],
] as const;
let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => {
  dispose?.(); dispose = undefined;
  mount?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each(hosts)('%s desktop copy', (_host, userAgent, macOS) => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => Promise.reject(new Error('unused native command')), transformCallback: () => 0 });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0);
    mount = document.createElement('div'); document.body.append(mount);
  });

  it.each(['en', 'da'] as const)('selects %s device and approval wording without changing interpolated values', async lang => {
    const { t, setLanguagePref } = await import('../src/i18n');
    setLanguagePref(lang);
    expect(t('uiTouchID')).toBe(macOS ? 'Touch ID' : lang === 'en' ? 'device approvals' : 'enhedsgodkendelser');
    expect(t('uiMac')).toBe(macOS ? 'Mac' : lang === 'en' ? 'computer' : 'computer');
    expect(t('uiTouchIDApprovalsOnThisMac')).toBe(macOS
      ? lang === 'en' ? 'Touch ID approvals on this Mac' : 'Touch ID-godkendelser på denne Mac'
      : lang === 'en' ? 'Device approvals on this computer' : 'Enhedsgodkendelser på denne computer');
    expect(t('ownerApprovalApprove')).toBe(lang === 'en'
      ? `Approve with ${macOS ? 'Touch ID' : 'device approvals'}`
      : `Godkend med ${macOS ? 'Touch ID' : 'enhedsgodkendelser'}`);
    expect(t('ownerApprovalApproving')).toBe(lang === 'en'
      ? `Waiting for ${macOS ? 'Touch ID' : 'device approvals'}…`
      : `Venter på ${macOS ? 'Touch ID' : 'enhedsgodkendelser'}…`);
    expect(t('ownerApprovalTermsLanguage')).toBe(lang === 'en'
      ? `The terms are shown in English, exactly as your ${macOS ? 'Mac' : 'computer'} signs them.`
      : `Vilkårene vises på engelsk, præcis som din ${macOS ? 'Mac' : 'computer'} signerer dem.`);
    expect(t('ownerApprovalSignedMessage')).toBe(lang === 'en'
      ? `Exact message your ${macOS ? 'Mac' : 'computer'} signs`
      : `Den præcise besked, din ${macOS ? 'Mac' : 'computer'} signerer`);
    expect(t('caQuestionsAndAnswersStaySealedOnThisMacKeeps')).toContain(macOS
      ? lang === 'en' ? 'this Mac' : 'denne Mac'
      : lang === 'en' ? 'this computer' : 'denne computer');
    expect(t('ownerApprovalRequester', 'Touch ID / this Mac')).toContain('Touch ID / this Mac');
  });

  it.each(['en', 'da'] as const)('renders and copies the %s local connection location', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { ConnectionCard } = await import('../src/control/ConnectionCard');
    setLanguagePref(lang);
    const copy = vi.fn(async (_text: string) => {});
    dispose = render(() => <ConnectionCard remote={false} link="open" live answer={null} stun="none" lastCall={null} copy={copy} />, mount);
    const location = macOS ? lang === 'en' ? 'on this Mac' : 'på denne Mac' : lang === 'en' ? 'on this computer' : 'på denne computer';
    expect(mount.querySelector('[data-connection-line="0"]')?.textContent).toContain(location);
    mount.querySelector<HTMLButtonElement>('[data-connection-copy]')!.click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(copy.mock.calls[0][0]).toContain(location);
  });

  it.each(['en', 'da'] as const)('offers %s setup only where available and keeps the spending choice unchanged', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { FirstSpendSheet } = await import('../src/control/FirstSpendSheet');
    setLanguagePref(lang);
    const allow = vi.fn(), setup = vi.fn();
    dispose = render(() => <FirstSpendSheet
      presets={[{ id: 'careful', ceiling_msat: 500_000, contact_msat: 50_000, room_msat: 100_000 }]}
      initialPreset="careful" maxDailyMsat={1_000_000} costLine="8 sats" blockedReason={null}
      onSetupApprovals={setup} onPreset={() => {}} onAllow={allow} onCancel={() => {}} />, mount);
    const button = mount.querySelector<HTMLButtonElement>('[data-approval-setup]');
    expect(button !== null).toBe(macOS);
    if (macOS) {
      expect(button!.textContent).toBe(lang === 'en' ? 'Set up Touch ID approvals' : 'Opsæt Touch ID-godkendelser');
      button!.click(); expect(setup).toHaveBeenCalledOnce();
    } else {
      expect(mount.textContent).not.toMatch(/Touch ID|this Mac|denne Mac/);
      expect(setup).not.toHaveBeenCalled();
    }
    expect(allow).not.toHaveBeenCalled();
    mount.querySelector<HTMLButtonElement>('[data-first-spend-allow]')!.click();
    expect(allow).toHaveBeenCalledExactlyOnceWith({ id: 'careful', ceiling_msat: 500_000 });
  });

  it.each(['en', 'da'] as const)('renders %s owner approval copy and submits the exact displayed message', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { OwnerApprovals } = await import('../src/control/OwnerApprovals');
    setLanguagePref(lang);
    const now = 1_800_000_000_000;
    const view: ApprovalView = {
      op_id: 'desktop-op', node: 'node', client_id: 'client', client_pubkey: 'ab'.repeat(32), epoch: 4, grant_op: 'grant',
      request: { kind: 'first_contact', terms: { recipient: 'cd'.repeat(32), max_total_msat: 14_000, budget_msat: 50_000 } },
      nonce: '11'.repeat(16), expires_at: now / 1000 + 200, approval_message: 'bitsov-approval-v1\nkind=first_contact\nmax_total_msat=14000',
      status: 'pending', owner_action: null,
    };
    const approve = vi.fn(async () => ({ ok: true as const, value: { ...view, status: 'consumed' as const } }));
    dispose = render(() => <OwnerApprovals approvals={[view]} now={now} approve={approve} />, mount);
    expect(mount.querySelector('[data-approval-message] summary')?.textContent).toBe(lang === 'en'
      ? `Exact message your ${macOS ? 'Mac' : 'computer'} signs`
      : `Den præcise besked, din ${macOS ? 'Mac' : 'computer'} signerer`);
    const button = mount.querySelector<HTMLButtonElement>('[data-approval-approve]')!;
    expect(button.textContent).toBe(lang === 'en'
      ? `Approve with ${macOS ? 'Touch ID' : 'device approvals'}`
      : `Godkend med ${macOS ? 'Touch ID' : 'enhedsgodkendelser'}`);
    if (!macOS) expect(mount.textContent).not.toMatch(/Touch ID|\bMac\b/);
    expect(mount.querySelector('pre')?.textContent).toBe(view.approval_message);
    expect(approve).not.toHaveBeenCalled();
    button.click();
    await vi.waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith('desktop-op', view.approval_message));
  });

  it.each(['en', 'da'] as const)('uses %s desktop sheet copy before and during approval without changing signed bytes', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { approvalMemory } = await import('../src/control/OwnerApprovals');
    const { OwnerApprovalSheets } = await import('../src/control/OwnerApprovalSheet');
    setLanguagePref(lang);
    const now = 1_800_000_000_000;
    const view: ApprovalView = {
      op_id: 'sheet-op', node: 'node', client_id: 'client', client_pubkey: 'ab'.repeat(32), epoch: 4, grant_op: 'grant',
      request: { kind: 'spend_grant', terms: { budget_msat: 2_000_000, per_call_max_msat: 10_000, window_secs: 600 } },
      nonce: '11'.repeat(16), expires_at: now / 1000 + 200, approval_message: 'exact approval bytes\n2000000',
      status: 'pending', owner_action: null,
    };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const approve = vi.fn(async () => { await pending; return { ok: true as const, value: { ...view, status: 'consumed' as const } }; });
    const memory = approvalMemory();
    dispose = render(() => <OwnerApprovalSheets approvals={[view]} now={now} memory={memory} approve={approve} />, mount);
    const button = mount.querySelector<HTMLButtonElement>('[data-owner-sheet-approve]')!;
    expect(button.textContent).toBe(lang === 'en'
      ? `Approve with ${macOS ? 'Touch ID' : 'device approvals'}`
      : `Godkend med ${macOS ? 'Touch ID' : 'enhedsgodkendelser'}`);
    expect(mount.querySelector('summary')?.textContent).toBe(lang === 'en'
      ? `Exact message your ${macOS ? 'Mac' : 'computer'} signs`
      : `Den præcise besked, din ${macOS ? 'Mac' : 'computer'} signerer`);
    if (lang === 'da') expect(mount.textContent).toContain(`Vilkårene vises på engelsk, præcis som din ${macOS ? 'Mac' : 'computer'} signerer dem.`);
    expect(mount.querySelector('pre')?.textContent).toBe(view.approval_message);
    expect(approve).not.toHaveBeenCalled();
    button.click();
    expect(button.textContent).toBe(lang === 'en'
      ? `Waiting for ${macOS ? 'Touch ID' : 'device approvals'}…`
      : `Venter på ${macOS ? 'Touch ID' : 'enhedsgodkendelser'}…`);
    expect(button.disabled).toBe(true);
    expect(approve).toHaveBeenCalledExactlyOnceWith('sheet-op', view.approval_message);
    finish();
    await vi.waitFor(() => expect(mount.querySelector('[data-owner-sheet-approve]')).toBeNull());
  });

});

describe.each([
  ['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'],
  ['Android', 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile'],
] as const)('%s biometric setup', (_host, userAgent) => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    mount = document.createElement('div'); document.body.append(mount);
  });
  it.each(['en', 'da'] as const)('keeps %s available setup instructions beside the biometric action', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { FirstSpendSheet } = await import('../src/control/FirstSpendSheet');
    setLanguagePref(lang);
    dispose = render(() => <FirstSpendSheet
      presets={[{ id: 'careful', ceiling_msat: 500_000, contact_msat: 50_000, room_msat: 100_000 }]}
      initialPreset="careful" maxDailyMsat={1_000_000} costLine="8 sats" blockedReason={null}
      onSetupApprovals={() => {}} onPreset={() => {}} onAllow={() => {}} onCancel={() => {}} />, mount);
    expect(mount.querySelector('[data-approval-setup]')?.textContent).toBe(lang === 'en'
      ? 'Set up biometric approvals' : 'Opsæt biometriske godkendelser');
    expect(mount.textContent).toContain(lang === 'en'
      ? 'Set them up here to approve in the app. Until then, your node’s owner must approve at the node.'
      : 'Indstil dem her for at godkende i appen. Indtil da skal din nodes ejer godkende på noden.');
  });
});
