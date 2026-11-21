import { expect, test, type Page } from '@playwright/test';

// The real app with a stand-in host: no node.
const host = () => {
  const OWN = '1'.repeat(64), A = 'a'.repeat(64);
  const w = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, (e: unknown) => void>();
  const R: Record<string, (a: Record<string, unknown>) => unknown> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }), trust_acknowledge: () => true,
    pairing_status: () => ({ state: 'paired', scopes: ['read', 'receive', 'spend'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, remote: false, bootstrap: null }),
    node_overview: () => ({ node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0, lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(), capabilities: [] }),
    peers_list: () => [{ node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null }], rooms_list: () => [], messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 1000, peer_age_secs: 30, max_routing_fee_msat: 5000, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1000000, lightning_outbound_msat: 500000, channels: [] }), fund_state: () => null,
    file_price: () => ({ principal_msat: 1000, max_routing_fee_msat: 5000, total_msat: 6000 }),
    spend_status: () => ({ state: 'open', basis: 'node_grant', open_until_ms: Date.now() + 600000, pending: null, window_ms: 600000 }),
    budget_status: () => ({ paused: false, waiting_for_owner: false, ceiling_msat: 500000, max_daily_msat: 100000000, spent_msat: 0, unsettled_msat: 0, preset: 'careful', presets: [{ id: 'careful', contact_msat: 50000, room_msat: 100000, ceiling_msat: 500000 }], rows: [{ target: A, room: false, limit_msat: 50000, spent_msat: 0 }], autopay: { state: 'open', open_until_ms: Date.now() + 86400000, ceiling_msat: 500000, basis: 'node_grant' }, window_ms: 600000, node_grant: null }),
    file_send: (a) => {
      if (w.__refuse) throw { code: 'not_dispatched', message: 'Not sent - nothing was paid.' };
      return { message_id: 'sent1', recipient: a.recipient, filename: a.filename, size_bytes: 5, delivered: true, amount_msat: 1000, total_msat: 6000, max_routing_fee_msat: 5000, sent_at_ms: Date.now(), accepted: true, state: 'acked' };
    },
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

async function fileChosen(page: Page) {
  await page.addInitScript(host);
  await page.goto('/');
  await page.locator('button', { hasText: 'I understand' }).first().click();
  await page.locator('[data-track^="peer:"]').first().click();
  await page.locator('[data-composer-plus]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-composer-mode="file"]').click();
  await chooser;
  await page.locator('[data-file-input]').setInputFiles({ name: 'Faktura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello') });
  await expect(page.locator('[data-file-chip] .file-name')).toHaveText('Faktura.pdf');
  await expect(page.locator('[data-send]')).toBeEnabled();
}

for (const size of [{ width: 1280, height: 800 }, { width: 393, height: 852 }]) {
  test(`${size.width}x${size.height}: after a file goes, the message box is back and a person can type`, async ({ page }) => {
    await page.setViewportSize(size);
    await fileChosen(page);
    await page.locator('[data-send]').click();
    await expect(page.locator('[data-composer-panel="file"]')).toHaveCount(0);
    const box = page.locator('[data-composer-bar] textarea');
    await expect(box).toBeVisible();
    await expect(box).toBeEnabled();
    await box.pressSequentially('Her er den');
    await expect(box).toHaveValue('Her er den');
    await expect(page.locator('[data-send]')).toBeEnabled();
  });

  test(`${size.width}x${size.height}: a failed send keeps the file, to try again`, async ({ page }) => {
    await page.setViewportSize(size);
    await fileChosen(page);
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__refuse = true; });
    await page.locator('[data-send]').click();
    await expect(page.locator('[data-artifact="failed"]')).toBeVisible();
    await expect(page.locator('[data-file-chip] .file-name')).toHaveText('Faktura.pdf');
    await expect(page.locator('[data-send]')).toBeEnabled();
  });
}
