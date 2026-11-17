import { expect, test, type Page } from '@playwright/test';

// The real app with a stand-in host: no node. Money readiness flips while a chat is open.
const host = () => {
  const OWN = '1'.repeat(64), A = 'a'.repeat(64);
  const w = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, (e: unknown) => void>();
  const R: Record<string, (a: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }), trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null }),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [], money_ready: !w.__notReady, readiness: null }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }], rooms_list: () => [], messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 30, max_routing_fee_msat: 5000, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1000000, lightning_outbound_msat: 500000, channels: [] }), fund_state: () => null,
    file_price: () => ({ principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 }),
    spend_status: () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 }),
    budget_status: () => ({ paused: false, waiting_for_owner: false, ceiling_msat: 500000, max_daily_msat: 100000000, spent_msat: 0, unsettled_msat: 0, preset: 'careful', presets: [{ id: 'careful', contact_msat: 50000, room_msat: 100000, ceiling_msat: 500000 }], rows: [{ target: A, room: false, limit_msat: 50000, spent_msat: 0 }], autopay: { state: 'open', open_until_ms: Date.now() + 86400000, ceiling_msat: 500000, basis: 'node_grant' }, window_ms: 600000, node_grant: null }),
    op_list: () => ({ operations: [], skipped: 0, has_more: false }), live_link: () => null,
    'plugin:event|listen': () => 1, 'plugin:event|unlisten': () => null,
  };
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (e: unknown) => void) => { const id = callbacks.size + 1; callbacks.set(id, cb); return id; },
    invoke: (c: string, a: Record<string, unknown>) => { const r = R[c]; if (!r) return Promise.reject(new Error(`unexpected ${c}`)); try { return Promise.resolve(r(a)); } catch (e) { return Promise.reject(e); } },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
};

type Box = { top: number; bottom: number; left: number; right: number; height: number };
const box = (page: Page, sel: string): Promise<Box> => page.locator(sel).first().evaluate(el => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) };
});
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const layout = async (page: Page) => ({
  track: await box(page, 'section.track'),
  head: await box(page, 'section.track > .track-head'),
  bar: await box(page, '[data-composer-bar]'),
});

// What the browser paints on top at a point: true when it is the notice (or inside it).
const noticeOnTop = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-money-notice]'), p);
const centre = (b: Box) => ({ x: (b.left + b.right) / 2, y: b.top + b.height / 2 });
// Behind a panel the chat is inert, and inert content is never hit-tested, so a plain
// elementFromPoint cannot tell "covered" from "painted on top but inert". Lift inert just for
// the probe, so the answer depends only on stacking order.
const noticeOnTopIgnoringInert = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const inert = [...document.querySelectorAll<HTMLElement>('[inert]')];
    inert.forEach(el => { el.inert = false; });
    try { return !!document.elementFromPoint(x, y)?.closest('[data-money-notice]'); }
    finally { inert.forEach(el => { el.inert = true; }); }
  }, p);
// And what is actually painted: the region looks the same with the notice hidden.
const noticePainted = async (page: Page, b: Box) => {
  const clip = { x: b.left, y: b.top, width: b.right - b.left, height: b.height };
  const shown = await page.screenshot({ clip, animations: 'disabled' });
  await page.locator('section.track [data-money-notice]').evaluate(el => { (el as HTMLElement).style.visibility = 'hidden'; });
  const hidden = await page.screenshot({ clip, animations: 'disabled' });
  await page.locator('section.track [data-money-notice]').evaluate(el => { (el as HTMLElement).style.visibility = ''; });
  return !shown.equals(hidden);
};

const openChat = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(host);
  await page.goto('/');
  await page.locator('button', { hasText: 'I understand' }).first().click();
  await page.locator('[data-track^="peer:"]').first().click();
  await expect(page.locator('section.track > .track-head')).toBeVisible();
  await expect(page.locator('[data-money-notice]')).toHaveCount(0);
};
const showNotice = async (page: Page) => {
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__notReady = true; });
  const notice = page.locator('section.track [data-money-notice]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  return notice;
};

test('1280x800: the money notice floats over the chat and does not push it down', async ({ page }) => {
  await openChat(page);
  const before = await layout(page);
  const stream = await box(page, 'section.track [data-stream]');

  const notice = await showNotice(page);
  await expect(notice).toHaveAttribute('role', 'status');

  // The chat, its header and the message box stay exactly where they were.
  expect(await layout(page)).toEqual(before);
  // It sits over the message list, not over the header's buttons or the message box.
  const n = await box(page, 'section.track [data-money-notice]');
  expect(overlaps(n, before.head)).toBe(false);
  expect(overlaps(n, before.bar)).toBe(false);
  expect(n.left).toBeGreaterThanOrEqual(before.track.left);
  expect(n.right).toBeLessThanOrEqual(before.track.right);
  // It is inside the window and fully over the message list, and it is what paints there.
  expect(n.height).toBeGreaterThan(0);
  expect(n.top).toBeGreaterThanOrEqual(0);
  expect(n.bottom).toBeLessThanOrEqual(800);
  expect(n.top).toBeGreaterThanOrEqual(stream.top);
  expect(n.bottom).toBeLessThanOrEqual(stream.bottom);
  expect(n.left).toBeGreaterThanOrEqual(stream.left);
  expect(n.right).toBeLessThanOrEqual(stream.right);
  expect(await box(page, 'section.track [data-stream]')).toEqual(stream);
  expect(await noticeOnTop(page, centre(n))).toBe(true);

  // Header controls stay reachable by keyboard while it shows.
  const settings = page.locator('section.track > .track-head .context-toggle');
  await settings.focus();
  await expect(settings).toBeFocused();
  const center = await settings.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.context-toggle'), center)).toBe(true);

  // When money is ready again it goes, and nothing moves back.
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__notReady = false; });
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  expect(await layout(page)).toEqual(before);
});

test('1280x800: Settings and Wallet cover the money notice', async ({ page }) => {
  await openChat(page);
  const notice = await showNotice(page);
  const nb = await box(page, 'section.track [data-money-notice]');
  const at = centre(nb);
  expect(await noticeOnTop(page, at)).toBe(true);
  expect(await noticePainted(page, nb)).toBe(true);

  // Settings: the panel, not the notice, is on top where the notice sits.
  await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
  await page.locator('[data-open-settings]').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.settings-modal.open')!).opacity === '1');
  await expect(notice).toHaveCount(1);
  expect(await noticeOnTop(page, at)).toBe(false);
  expect(await noticeOnTopIgnoringInert(page, at)).toBe(false);
  expect(await noticePainted(page, nb)).toBe(false);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.settings-modal.open'), at)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-modal.open')).toHaveCount(0);
  await expect.poll(() => noticeOnTop(page, at)).toBe(true);

  // Wallet: same.
  await page.getByRole('button', { name: 'You: wallet, profile and settings' }).click();
  await page.locator('[data-open-wallet]').click();
  await expect(page.locator('.wallet-page')).toBeVisible();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.wallet-page')!).opacity === '1');
  await expect(notice).toHaveCount(1);
  expect(await noticeOnTop(page, at)).toBe(false);
  expect(await noticeOnTopIgnoringInert(page, at)).toBe(false);
  expect(await noticePainted(page, nb)).toBe(false);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.wallet-page'), at)).toBe(true);
});
