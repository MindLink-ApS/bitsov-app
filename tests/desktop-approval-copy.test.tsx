import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe.each([
  ['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'],
  ['Android', 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile'],
] as const)('%s composed approval copy', (_host, userAgent) => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: () => Promise.reject(new Error('unused native command')), transformCallback: () => 0,
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
    mount = document.createElement('div'); document.body.append(mount);
  });

  it.each(['en', 'da'] as const)('keeps the complete %s biometric approval phrase', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { ControlCenter } = await import('../src/control/Shell');
    const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
    setLanguagePref(lang);
    const source = sampleSource({ firstLiveMs: 1e9 });
    source.deviceKeyStatus = async () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
    source.budgetStatus = async () => { throw new Error('budget API unavailable'); };
    source.spendStatus = async () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600000,
      pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } });
    dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
    await vi.waitFor(() => expect(mount.querySelector('[data-track^="peer:"]')).not.toBeNull());
    mount.querySelector<HTMLButtonElement>('[data-track^="peer:"]')!.click();
    await vi.waitFor(() => expect(mount.querySelector('[data-touch-id-first]')).not.toBeNull());
    const offer = mount.querySelector('[data-touch-id-first]')!;
    expect(offer.querySelector('[data-touch-id-setup]')?.textContent).toBe(lang === 'en'
      ? 'Set up biometric approvals' : 'Opsæt biometriske godkendelser');
    expect(offer.querySelector('p')?.textContent).toContain(lang === 'en'
      ? 'Your node does not yet accept biometric approvals in place of its command'
      : 'Din node accepterer endnu ikke biometriske godkendelser i stedet for sin kommando');
    expect(offer.textContent).not.toMatch(/Touch ID|\bMac\b|device approvals|enhedsgodkendelser/);
  });
});

describe.each(hosts)('%s composed approval copy', (_host, userAgent, macOS) => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: () => Promise.reject(new Error('unused native command')), transformCallback: () => 0,
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0);
    mount = document.createElement('div'); document.body.append(mount);
  });

  describe.each([false, true])('owner device approval support: %s', supported => {
    it.each(['en', 'da'] as const)('renders %s setup without repeating approval nouns', async lang => {
      const { render } = await import('solid-js/web');
      const { setLanguagePref } = await import('../src/i18n');
      const { ControlCenter } = await import('../src/control/Shell');
      const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
      setLanguagePref(lang);
      const source = sampleSource({ firstLiveMs: 1e9 });
      const overview = source.nodeOverview.bind(source);
      source.nodeOverview = async () => ({ ...await overview(), capabilities: supported ? ['owner_device_approval_v1'] : [] });
      source.deviceKeyStatus = async () => ({ available: true, state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null });
      source.budgetStatus = async () => { throw new Error('budget API unavailable'); };
      source.spendStatus = async () => ({ state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600000,
        pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600000, owner_action: 'konsensus grant --op ab01', owner_can_grant: true } });
      dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={<span />} />, mount);
      await vi.waitFor(() => expect(mount.querySelector('[data-track^="peer:"]')).not.toBeNull());
      mount.querySelector<HTMLButtonElement>('[data-track^="peer:"]')!.click();
      await vi.waitFor(() => expect(mount.querySelector('[data-touch-id-first]')).not.toBeNull());
      const offer = mount.querySelector('[data-touch-id-first]')!;
      expect(offer.querySelector('strong')?.textContent).toBe(macOS
        ? lang === 'en' ? 'Approve on this Mac with Touch ID.' : 'Godkend på denne Mac med Touch ID.'
        : lang === 'en' ? 'Approve on this computer with device approvals.' : 'Godkend på denne computer med enhedsgodkendelser.');
      expect(offer.querySelector('[data-touch-id-setup]')?.textContent).toBe(macOS
        ? lang === 'en' ? 'Set up Touch ID approvals' : 'Opsæt Touch ID-godkendelser'
        : lang === 'en' ? 'Set up device approvals' : 'Opsæt enhedsgodkendelser');
      const text = offer.querySelector('p')!.textContent!;
      if (supported) {
        expect(text).toContain(macOS
          ? lang === 'en' ? 'After that, one Touch ID tap approves a contact here, without a command at the node.' : 'Derefter godkender ét Touch ID-tryk en kontakt her uden en kommando ved noden.'
          : lang === 'en' ? 'After that, one device confirmation tap approves a contact here, without a command at the node.' : 'Derefter godkender ét enhedsbekræftelse-tryk en kontakt her uden en kommando ved noden.');
      } else {
        expect(text).toContain(macOS
          ? lang === 'en' ? 'Your node does not yet accept Touch ID approvals in place of its command, so for now approve as shown under Other ways; once it does, one Touch ID tap will approve a contact here.' : 'Din node accepterer endnu ikke Touch ID-godkendelser i stedet for sin kommando. Godkend indtil videre som vist under Andre måder; derefter vil ét Touch ID-tryk godkende en kontakt her.'
          : lang === 'en' ? 'Your node does not yet accept device approvals in place of its command, so for now approve as shown under Other ways; once it does, one device confirmation tap will approve a contact here.' : 'Din node accepterer endnu ikke enhedsgodkendelser i stedet for sin kommando. Godkend indtil videre som vist under Andre måder; derefter vil ét enhedsbekræftelse-tryk godkende en kontakt her.');
      }
      expect(offer.textContent).not.toMatch(/approvals approvals|enhedsgodkendelser[- ]godkendelser|device approvals tap|enhedsgodkendelser-tryk/);
    });
  });

  it.each(['en', 'da'] as const)('renders a singular %s approval prompt subject', async lang => {
    const { render } = await import('solid-js/web');
    const { setLanguagePref } = await import('../src/i18n');
    const { TouchApproval } = await import('../src/control/Shell');
    setLanguagePref(lang);
    dispose = render(() => <TouchApproval peer="node-abcd" name="Contact" priceMsat={2000} actions={{} as never} />, mount);
    mount.querySelector<HTMLButtonElement>('.touch-detail-toggle')!.click();
    const detail = mount.querySelector('[data-touch-detail] p')!;
    expect(detail.hasAttribute('hidden')).toBe(false);
    expect(detail.textContent).toBe(macOS
      ? lang === 'en' ? 'Touch ID shows the same amounts for node node-abcd. Your node checks every payment against them; nothing else can be paid under this approval.' : 'Touch ID viser de samme beløb for node node-abcd. Din node kontrollerer hver betaling mod dem; intet andet kan betales under denne godkendelse.'
      : lang === 'en' ? 'The device approval prompt shows the same amounts for node node-abcd. Your node checks every payment against them; nothing else can be paid under this approval.' : 'Enhedens godkendelsesdialog viser de samme beløb for node node-abcd. Din node kontrollerer hver betaling mod dem; intet andet kan betales under denne godkendelse.');
    expect(mount.querySelector('.line-text strong')?.textContent).toBe(macOS
      ? lang === 'en' ? 'Approve Contact (node node-abcd) with Touch ID.' : 'Godkend Contact (node node-abcd) med Touch ID.'
      : lang === 'en' ? 'Approve Contact (node node-abcd) with device approvals.' : 'Godkend Contact (node node-abcd) med enhedsgodkendelser.');
  });
});
