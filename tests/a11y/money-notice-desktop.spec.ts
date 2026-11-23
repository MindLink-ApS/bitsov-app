import { expect, test, type Page } from '@playwright/test';

// The real app with a stand-in host: no node. Money readiness flips while a chat is open.
const host = () => {
  const OWN = '1'.repeat(64), A = 'a'.repeat(64);
  const w = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, (e: unknown) => void>();
  const R: Record<string, (a: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }), trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null }),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: ['room_binding_v1'], money_ready: !w.__notReady, readiness: null }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Robin', connected: true, fingerprint: null, rooms: true, session: true }], rooms_list: () => [], messages_list: () => [], room_thread: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 30, max_routing_fee_msat: 5000, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1000000, lightning_outbound_msat: 500000, channels: [] }), fund_state: () => null,
    file_price: () => ({ principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 }),
    spend_status: () => w.__spendPending
      ? { state: 'pending', lapse: null, basis: null, open_until_ms: null, window_ms: 600000, pending: { op_id: 'ab01', expires_at_ms: Date.now() + 600000, owner_action: 'approve ab01', owner_can_grant: true } }
      : { state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 },
    spend_cancel: () => { w.__spendPending = false; w.__spendCancelled = true; return { state: 'locked', lapse: null, basis: null, open_until_ms: null, pending: null, window_ms: 600000 }; },
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

// The notice may cover only the message list. Every other control in the track stays where the
// pointer can reach it: the browser hit-tests the control itself at its centre, and a click lands.
const reachable = async (page: Page, sel: string) => {
  const control = page.locator(sel).first();
  await expect(control).toBeVisible();
  const c = centre(await box(page, sel));
  expect(await page.evaluate(({ x, y, sel }) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && !hit.closest('[data-money-notice]') && !!hit.closest(sel);
  }, { ...c, sel }), `${sel} is hit-tested at its centre`).toBe(true);
  expect(overlaps(await box(page, 'section.track [data-money-notice]'), await box(page, sel)), `the notice does not overlap ${sel}`).toBe(false);
  return control;
};
const openApp = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(host);
  await page.goto('/');
  await page.locator('button', { hasText: 'I understand' }).first().click();
};
// Where there is a message list, the notice sits inside it.
const insideStream = async (page: Page) => {
  const n = await box(page, 'section.track [data-money-notice]');
  const s = await box(page, 'section.track [data-stream]');
  expect(n.top).toBeGreaterThanOrEqual(s.top);
  expect(n.bottom).toBeLessThanOrEqual(s.bottom);
  expect(await noticeOnTop(page, centre(n))).toBe(true);
};

test('1280x800: the money notice leaves the assistant provider bar usable', async ({ page }) => {
  await openApp(page);
  // Ask your node: the provider bar sits right under the chat header.
  await page.locator('[data-rail-advanced] > summary').click();
  await page.locator('[data-track="ai"]').click();
  await expect(page.locator('section.track [data-ai-providers] button').first()).toBeVisible();
  const notice = await showNotice(page);
  await expect(notice).toHaveAttribute('role', 'status');
  const bar = await reachable(page, 'section.track [data-ai-providers] button');
  await bar.click({ timeout: 5_000 });
  await expect(bar).toHaveAttribute('aria-checked', 'true');
  await insideStream(page);
  // A named assistant: its bars (thread, watches, providers) all stay reachable too.
  await page.locator('[data-track^="assistant:"]').first().click();
  await expect(page.locator('section.track [data-assistant-role]')).toBeVisible();
  await reachable(page, 'section.track [data-assistant-role]');
  await reachable(page, 'section.track [data-assistant-forget]');
  await reachable(page, 'section.track [data-assistant-watches] > summary');
  await reachable(page, 'section.track [data-ai-providers] button');
  await insideStream(page);
});

test('1280x800: on the start view (no message list) the money notice covers no control', async ({ page }) => {
  // A spending request waits at the node, so the start view's spend banner carries a control.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__spendPending = true; });
  await openApp(page);
  await page.locator('[data-track="new"]').click();
  await expect(page.locator('section.track .spend')).toBeVisible();
  await expect(page.locator('section.track [data-stream]')).toHaveCount(0);
  await showNotice(page);
  const head = await box(page, 'section.track > .track-head');
  expect(overlaps(await box(page, 'section.track [data-money-notice]'), head)).toBe(false);
  await reachable(page, 'section.track .spend');
  const cancel = await reachable(page, 'section.track .spend :is([data-spend-cancel], [data-spend-cancel-visible])');
  await cancel.click({ timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__spendCancelled === true)).toBe(true);
});

test('1280x800: the money notice leaves the room leave-confirm usable', async ({ page }) => {
  await openApp(page);
  await page.locator('[data-room-new]').click();
  await page.locator('[data-room-pick]').first().check();
  await page.locator('[data-room-create]').click();
  await expect(page.locator('section.track [data-room-head]')).toBeVisible();
  await page.locator('[data-room-leave]').click();
  await expect(page.locator('[data-room-leave-confirm]')).toBeVisible();
  await showNotice(page);
  await reachable(page, '[data-room-leave-confirm] [data-room-leave-yes]');
  const stay = await reachable(page, '[data-room-leave-confirm] [data-room-leave-no]');
  await insideStream(page);
  await stay.click({ timeout: 5_000 });
  await expect(page.locator('[data-room-leave-confirm]')).toHaveCount(0);
  await expect(page.locator('section.track [data-room-head]')).toBeVisible();
});

// The smallest desktop window (560 px tall, the window's minimum) with a named assistant's bars
// open: the message list gets short. The notice must stay inside the list, and the composer must
// stay in the window and take a click and typing.
const assistantHost = () => {
  const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } };
  const original = w.__TAURI_INTERNALS__.invoke;
  w.__TAURI_INTERNALS__.invoke = (c, a) => {
    if (c === 'ai_read' && a?.thread) return Promise.resolve({ revision: '1', turns: [], notices: [], disabled_watches: [] });
    if (c === 'ai_read' && a?.watch) return Promise.resolve({ revision: '1', notices: [] });
    if (c === 'ai_providers') return Promise.resolve([{ kind: 'local', label: 'Own', enabled: true, host: null, model: null, note: null, pays: { to: null, rail: 'none' }, data_leaves: null }]);
    if (c === 'ai_local_status') return Promise.resolve({ running: false, kind: null, port: null, models: [], selected: null, selected_port: null, howto: 'No local model server is running.' });
    return original(c, a);
  };
};
const openAssistantBars = async (page: Page, height: number) => {
  await page.setViewportSize({ width: 1280, height });
  await page.addInitScript(host);
  await page.addInitScript(assistantHost);
  await page.goto('/');
  await page.locator('button', { hasText: 'I understand' }).first().click();
  await page.locator('[data-rail-advanced] > summary').click();
  await page.locator('[data-track^="assistant:"]').first().click();
  await expect(page.locator('section.track [data-assistant-ready]')).toBeVisible();
  // Watches and the local-server options open: the bars above the list are as tall as they get.
  await page.locator('section.track [data-assistant-watches]').evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await page.locator('section.track .ai-own-details').evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator('section.track .ai-own-details[open]')).toHaveCount(1);
};
// Every point on a grid over a box: true when the notice is what the pointer would hit there.
const noticeHitsIn = (page: Page, sel: string) => page.locator(sel).first().evaluate(el => {
  const r = el.getBoundingClientRect(), hits: string[] = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) {
    const x = r.left + 1 + (r.width - 2) * i / 8, y = r.top + 1 + (r.height - 2) * j / 4;
    if (document.elementFromPoint(x, y)?.closest('[data-money-notice]')) hits.push(`${Math.round(x)},${Math.round(y)}`);
  }
  return hits;
});
const composerWorks = async (page: Page, height: number) => {
  const composer = await box(page, 'section.track [data-ai-composer]');
  expect(composer.top, 'the composer starts inside the window').toBeGreaterThanOrEqual(0);
  expect(composer.bottom, 'the composer ends inside the window').toBeLessThanOrEqual(height);
  expect(await noticeHitsIn(page, 'section.track [data-ai-composer]'), 'the notice covers no part of the composer').toEqual([]);
  const input = page.locator('section.track [data-ai-composer] textarea');
  await reachable(page, 'section.track [data-ai-composer] textarea');
  const ib = await box(page, 'section.track [data-ai-composer] textarea');
  // The question field's top edge, where the notice used to reach, is the field too.
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('textarea'), { x: (ib.left + ib.right) / 2, y: ib.top + 2 })).toBe(true);
  await input.evaluate(el => (el as HTMLElement).blur());
  const c = centre(ib);
  await page.mouse.click(c.x, c.y);
  await expect(input).toBeFocused();
  await page.keyboard.type('hello');
  await expect(input).toHaveValue('hello');
};
const noticeInsideStream = async (page: Page) => {
  const n = await box(page, 'section.track [data-money-notice]');
  const s = await box(page, 'section.track [data-stream]');
  expect(n.height).toBeGreaterThan(0);
  expect(n.top, 'notice top inside the list').toBeGreaterThanOrEqual(s.top);
  expect(n.bottom, 'notice bottom inside the list').toBeLessThanOrEqual(s.bottom);
  expect(n.left).toBeGreaterThanOrEqual(s.left);
  expect(n.right).toBeLessThanOrEqual(s.right);
  return { n, s };
};

test.describe('desktop pointer, short window', () => {
  test.use({ isMobile: false, hasTouch: false });

  test('1280x560: assistant bars open — the notice stays inside the list and the composer works', async ({ page }) => {
    await openAssistantBars(page, 560);
    const before = await box(page, 'section.track [data-stream]');
    const composerBefore = await box(page, 'section.track [data-ai-composer]');
    await showNotice(page);
    // Showing it moves nothing.
    expect(await box(page, 'section.track [data-stream]')).toEqual(before);
    expect(await box(page, 'section.track [data-ai-composer]')).toEqual(composerBefore);
    // The question field takes a pointer and typing, and the composer is whole in the window.
    await composerWorks(page, 560);
    // The notice lies wholly inside the message list, and paints on top there.
    const { n } = await noticeInsideStream(page);
    expect(await noticeOnTop(page, centre(n))).toBe(true);
    // The bars above stay usable.
    await reachable(page, 'section.track [data-assistant-watches] > summary');
    await reachable(page, 'section.track [data-ai-providers] button');
  });

  test('a very short message list: the notice shrinks to fit inside it and every control stays reachable', async ({ page }) => {
    await openAssistantBars(page, 800);
    const notice = await showNotice(page);
    const full = await box(page, 'section.track [data-money-notice]');
    const card = () => notice.evaluate(el => {
      const cs = getComputedStyle(el), f = document.querySelector('section.track [data-stream]')!.getBoundingClientRect(), r = el.getBoundingClientRect();
      return { font: parseFloat(cs.fontSize), clamp: cs.getPropertyValue('-webkit-line-clamp'), scrollH: el.scrollHeight, clipped: r.top < f.top || r.bottom > f.bottom };
    });
    const fontFull = (await card()).font;
    // 560 is the window's minimum; below it the list is at its floor (its own padding), as short as it gets.
    for (const height of [560, 540, 500]) {
      await page.setViewportSize({ width: 1280, height });
      // Showing the notice moves nothing, at any height.
      const shown = { s: await box(page, 'section.track [data-stream]'), c: await box(page, 'section.track [data-ai-composer]') };
      await notice.evaluate(el => { (el.parentElement as HTMLElement).style.display = 'none'; });
      expect({ s: await box(page, 'section.track [data-stream]'), c: await box(page, 'section.track [data-ai-composer]') }).toEqual(shown);
      await notice.evaluate(el => { (el.parentElement as HTMLElement).style.display = ''; });
      const { n, s } = await noticeInsideStream(page);
      // Too short for the full card and its margins (fonts differ by platform, so no fixed px).
      expect(s.height, `${height}: the list is shorter than the full card`).toBeLessThan(full.height + 16);
      // It degrades to a compact card: smaller, one or two clamped lines, still legible, not clipped.
      expect(n.height).toBeLessThan(full.height);
      const c = await card();
      expect(c.clipped).toBe(false);
      expect(c.font).toBeGreaterThanOrEqual(11);
      expect(c.font).toBeLessThan(fontFull);
      expect(['1', '2']).toContain(c.clamp);
      expect(n.height).toBeGreaterThanOrEqual(c.font);
      await expect(notice).toHaveAttribute('role', 'status');
      expect(await noticeOnTop(page, centre(n))).toBe(true);
      // The pointer meets it nowhere outside the list.
      for (const sel of ['section.track [data-ai-composer]', 'section.track [data-assistant-watches]', 'section.track .ai-own-details', 'section.track [data-ai-providers]', 'section.track > .track-head']) {
        expect(await noticeHitsIn(page, sel), `${height}: the notice covers no part of ${sel}`).toEqual([]);
      }
      await reachable(page, 'section.track [data-assistant-watches] > summary');
      await reachable(page, 'section.track [data-ai-providers] button');
      await reachable(page, 'section.track [data-ai-composer] textarea');
      // At the window's minimum the whole composer is in the window and takes typing.
      if (height === 560) {
        await composerWorks(page, 560);
        await page.locator('section.track [data-ai-composer] textarea').fill('');
      }
    }
  });
});
