import { expect, test, type Page } from '@playwright/test';

// The real app with a stand-in host: no node, no call media.
const host = () => {
  const OWN = '1'.repeat(64), A = 'a'.repeat(64), B = 'b'.repeat(64);
  const w = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, (e: unknown) => void>();
  let handler: number | null = null;
  const R: Record<string, (a: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }), trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: true, bootstrap: null }),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 2, pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: ['owner_device_approval_v1'] }),
    owner_device_keys: () => ({ device_approvals: 'enabled', owner_device_count: 2, device_keys: [] }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }, { node_id: B, addr: null, label: 'Josh', connected: true, fingerprint: null }],
    rooms_list: () => [], messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 30, max_routing_fee_msat: 5000, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1000000, lightning_outbound_msat: 500000, channels: [] }), fund_state: () => null,
    file_price: () => ({ principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 }),
    spend_status: () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 }),
    budget_status: () => ({ paused: false, waiting_for_owner: false, ceiling_msat: 500000, max_daily_msat: 100000000, spent_msat: 0, unsettled_msat: 0, preset: 'careful', presets: [{ id: 'careful', contact_msat: 50000, room_msat: 100000, ceiling_msat: 500000 }], rows: [{ target: A, room: false, limit_msat: 50000, spent_msat: 0 }, { target: B, room: false, limit_msat: 50000, spent_msat: 0 }], autopay: { state: 'open', open_until_ms: Date.now() + 86400000, ceiling_msat: 500000, basis: 'node_grant' }, window_ms: 600000, node_grant: null }),
    call_quote: () => ({ offer_msat: 5000, offer_max_routing_fee_msat: 5000, signal_msat: 1000, signal_max_routing_fee_msat: 5000, call_total_msat: 16000 }),
    owner_approvals_pending: () => (w.__approval ?? []) as unknown,
    call_signal: (a) => { if (a.kind === 400) w.__offer = a.plaintext; return ({ message_id: 'sig', kind: a.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }); },
    op_end_call: (a) => ({ op_id: 'e', kind: 'call_hangup', peer: A, call_id: a.call_id, state: 'settled', cap_msat: 6000, paid_msat: 1000, message_id: 'h' }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }), live_link: () => null,
    'plugin:event|listen': (a) => { handler = (a.handler as number) ?? null; return 1; }, 'plugin:event|unlisten': () => null,
  };
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (c: string, a: Record<string, unknown>) => { const r = R[c]; if (!r) return Promise.reject(new Error(`unexpected ${c}`)); try { return Promise.resolve(r(a)); } catch (e) { return Promise.reject(e); } },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  w.__secondCaller = () => callbacks.get(handler!)!({ event: 'node-live', id: 1, payload: { type: 'message', room_id: null, message: { id: 'second', kind: 400, sender: B, recipient: OWN, timestamp: Date.now(), payment_amount_msat: 10000, plaintext: JSON.stringify({ v: 1, call_id: 'f'.repeat(32), media: 'audio', sdp: 'v=0' }) } } });
  w.__answer = () => {
    const id = JSON.parse(w.__offer as string).call_id;
    callbacks.get(handler!)!({ event: 'node-live', id: 1, payload: { type: 'message', room_id: null, message: { id: 'ans', kind: 401, sender: A, recipient: OWN, timestamp: Date.now(), payment_amount_msat: 10000, plaintext: JSON.stringify({ v: 1, call_id: id, sdp: 'v=0 answer' }) } } });
    setTimeout(() => { const pc = w.__pc as { connectionState: string; onconnectionstatechange?: () => void }; pc.connectionState = 'connected'; pc.onconnectionstatechange?.(); }, 100);
  };
  w.RTCPeerConnection = class extends EventTarget {
    constructor() { super(); w.__pc = this; }
    onconnectionstatechange?: () => void;
    connectionState = 'new'; iceGatheringState = 'complete'; localDescription = { sdp: 'v=0' };
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); } setLocalDescription() { return Promise.resolve(); } setRemoteDescription() { return Promise.resolve(); }
    addTrack() { return {}; } getSenders() { return []; } close() {} getStats() { return Promise.resolve(new Map()); } createDataChannel() { return {}; } addTransceiver() { return {}; } restartIce() {}
  };
  const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.resolve(stream), enumerateDevices: () => Promise.resolve([]) } });
};

async function ringing(page: Page) {
  await page.addInitScript(host);
  await page.goto('/');
  await page.locator('button', { hasText: 'I understand' }).first().click();
  await page.locator('[data-track^="peer:"]').first().click();
  await page.locator('[data-call="audio"]').click();
  await page.locator('[data-call-confirm="audio"]').click();
  await expect(page.locator('[data-call-immersive]')).toBeVisible();
}
const inView = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  return !!el?.closest('[data-call-immersive], [data-waiting-calls]');
});

for (const size of [{ width: 1280, height: 800 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
  test(`${size.width}x${size.height}: a waiting caller stays reachable over the full call screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await ringing(page);
    await page.evaluate(() => (window as unknown as { __secondCaller: () => void }).__secondCaller());
    const decline = page.locator('[data-waiting-calls] [data-call-decline]');
    await expect(decline).toBeVisible();
    await decline.scrollIntoViewIfNeeded();
    const onTop = await decline.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    });
    expect(onTop).toBe(true);
  });
}

test('focus moves in, Tab and Shift+Tab stay on what can be seen, and it comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ringing(page);
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-call-immersive]'))).toBe(true);
  await page.evaluate(() => (window as unknown as { __secondCaller: () => void }).__secondCaller());
  await expect(page.locator('[data-waiting-calls] [data-call-decline]')).toBeVisible();
  const seen = new Set<string>();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press(key);
      expect(await inView(page)).toBe(true);
      seen.add(await page.evaluate(() => {
        const el = document.activeElement!;
        return el.hasAttribute('data-call-hangup') ? 'hangup' : el.hasAttribute('data-call-decline') ? 'decline' : 'other';
      }));
    }
  }
  expect(seen.has('hangup')).toBe(true);
  expect(seen.has('decline')).toBe(true);
  await page.locator('[data-call-compact]').click();
  await expect(page.locator('[data-call-immersive]')).toHaveCount(0);
  // Back where the person was: the call button, or the message box if that has gone. Never lost on the page.
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-call], [data-composer] textarea'))).toBe(true);
});

const call = (page: Page, name: '__secondCaller' | '__answer') => page.evaluate((n) => (window as unknown as Record<string, () => void>)[n](), name);
/** The control is on top where a finger would land, so a press reaches it. */
async function reach(page: Page, selector: string) {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  const onTop = await el.evaluate((node) => {
    // Directly: Accept pulses, and Playwright's own scroll waits for it to hold still.
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && (hit === node || node.contains(hit));
  });
  expect(onTop, selector).toBe(true);
  return el;
}
const FULL = '[data-call-immersive]';

for (const size of [{ width: 1280, height: 800 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) test(`${size.width}x${size.height}: every control on the call screen can be pressed, in every state`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(size);
  await ringing(page);
  // Full, ringing.
  await reach(page, '[data-call-compact]');
  await reach(page, '[data-call-hangup]');
  await (await reach(page, `${FULL} [data-call-details] summary`)).click();
  await (await reach(page, `${FULL} [data-call-details] summary`)).click();
  // Settings steps aside, so it can be seen and closed, and the call is still there.
  await (await reach(page, '[data-call-settings-link]')).click();
  await expect(page.locator(FULL)).toHaveCount(0);
  await reach(page, '[data-tab="general"]');
  await (await reach(page, '[data-settings-close]')).click();
  // Compact: the plain card, and back again.
  await reach(page, '[data-call-hangup]');
  await (await reach(page, '[data-call-compact]')).click();
  await expect(page.locator(FULL)).toBeVisible();
  // Live.
  await call(page, '__answer');
  await expect(page.locator('[data-call-panel="live"]')).toBeVisible();
  await expect(page.locator(FULL)).toBeVisible();
  // Mute changes nothing else: same mode, and focus stays where it was.
  await (await reach(page, '[data-call-mute]')).focus();
  await page.locator('[data-call-mute]').press('Enter');
  await expect(page.locator('[data-call-mute]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(FULL)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-call-mute'))).toBe(true);
  await page.locator('[data-call-mute]').press('Enter');
  // Mute in compact stays compact, and doesn't pull focus from the message box.
  await (await reach(page, '[data-call-compact]')).click();
  await expect(page.locator(FULL)).toHaveCount(0);
  await page.locator('[data-composer] textarea').focus();
  await (await reach(page, '[data-call-mute]')).click();
  await expect(page.locator(FULL)).toHaveCount(0);
  await (await reach(page, '[data-call-mute]')).click();
  await (await reach(page, '[data-call-compact]')).click();
  await expect(page.locator(FULL)).toBeVisible();
  // A waiting caller: Decline works over the full screen, which stays.
  await call(page, '__secondCaller');
  await reach(page, '[data-waiting-calls] [data-call-accept]');
  await (await reach(page, '[data-waiting-calls] [data-call-decline]')).click();
  await expect(page.locator('[data-waiting-calls] [data-call-panel="ended"]')).toBeVisible();
  await expect(page.locator(FULL)).toBeVisible();
  await (await reach(page, '[data-waiting-calls] [data-call-dismiss]')).click();
  await expect(page.locator('[data-waiting-calls] [data-call-panel]')).toHaveCount(0);
  // An owner approval opens above the full screen and its buttons work.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__approval = [{
      op_id: 'op-a', node: 'n', client_id: 'client-phone', client_pubkey: 'cd'.repeat(32), epoch: 4, grant_op: null,
      request: { kind: 'spend_grant', terms: { budget_msat: 500_000, per_call_max_msat: 10_000, window_secs: 600 } },
      nonce: '11'.repeat(16), expires_at: Math.floor(Date.now() / 1000) + 250, approval_message: 'bitsov-approval-v1\nop=op-a', status: 'pending', owner_action: null,
    }];
  });
  await expect(page.locator('[data-owner-sheet-scrim]')).toBeVisible({ timeout: 15_000 });
  await reach(page, '[data-owner-sheet-approve]');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-owner-sheet-scrim]'))).toBe(true);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__approval = []; });
  await (await reach(page, '[data-owner-sheet-dismiss]')).click();
  await expect(page.locator('[data-owner-sheet-scrim]')).toHaveCount(0);
  // Back on the full screen: hang up. The ended card is the plain card, with its own controls.
  await (await reach(page, '[data-call-hangup]')).click();
  await expect(page.locator('[data-call-panel="ended"]')).toBeVisible();
  await expect(page.locator(FULL)).toHaveCount(0);
  await reach(page, '[data-call-again]');
  await (await reach(page, '[data-call-dismiss]')).click();
  await expect(page.locator('[data-call-panel]')).toHaveCount(0);
});
