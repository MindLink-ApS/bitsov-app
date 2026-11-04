import { expect, test, type Page } from '@playwright/test';

// The real app with a stand-in host: no node, no call media.
const host = () => {
  const OWN = '1'.repeat(64), A = 'a'.repeat(64), B = 'b'.repeat(64);
  const callbacks = new Map<number, (e: unknown) => void>();
  let handler: number | null = null;
  const R: Record<string, (a: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }), trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null }),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 2, e2ee_sessions: 2, pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [] }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }, { node_id: B, addr: null, label: 'Josh', connected: true, fingerprint: null }],
    rooms_list: () => [], messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 30, max_routing_fee_msat: 5000, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1000000, lightning_outbound_msat: 500000, channels: [] }), fund_state: () => null,
    file_price: () => ({ principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 }),
    spend_status: () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 }),
    budget_status: () => ({ paused: false, waiting_for_owner: false, ceiling_msat: 500000, max_daily_msat: 100000000, spent_msat: 0, unsettled_msat: 0, preset: 'careful', presets: [{ id: 'careful', contact_msat: 50000, room_msat: 100000, ceiling_msat: 500000 }], rows: [{ target: A, room: false, limit_msat: 50000, spent_msat: 0 }, { target: B, room: false, limit_msat: 50000, spent_msat: 0 }], autopay: { state: 'open', open_until_ms: Date.now() + 86400000, ceiling_msat: 500000, basis: 'node_grant' }, window_ms: 600000, node_grant: null }),
    call_quote: () => ({ offer_msat: 5000, offer_max_routing_fee_msat: 5000, signal_msat: 1000, signal_max_routing_fee_msat: 5000, call_total_msat: 16000 }),
    call_signal: (a) => ({ message_id: 'sig', kind: a.kind, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() }),
    op_end_call: (a) => ({ op_id: 'e', kind: 'call_hangup', peer: A, call_id: a.call_id, state: 'settled', cap_msat: 6000, paid_msat: 1000, message_id: 'h' }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }), live_link: () => null,
    'plugin:event|listen': (a) => { handler = (a.handler as number) ?? null; return 1; }, 'plugin:event|unlisten': () => null,
  };
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (c: string, a: Record<string, unknown>) => { const r = R[c]; if (!r) return Promise.reject(new Error(`unexpected ${c}`)); try { return Promise.resolve(r(a)); } catch (e) { return Promise.reject(e); } },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  w.__secondCaller = () => callbacks.get(handler!)!({ event: 'node-live', id: 1, payload: { type: 'message', room_id: null, message: { id: 'second', kind: 400, sender: B, recipient: OWN, timestamp: Date.now(), payment_amount_msat: 10000, plaintext: JSON.stringify({ v: 1, call_id: 'f'.repeat(32), media: 'audio', sdp: 'v=0' }) } } });
  w.RTCPeerConnection = class extends EventTarget {
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
