import { test, expect } from '@playwright/test';
import { checkContactPanelModal } from './contact-panel-check';
import { PHONE_SHELL_PREVIEW } from './phoneShellPreview';

const preview = PHONE_SHELL_PREVIEW;
for (const lang of ['en', 'da']) {
  test(`${lang}: phone navigation, reachable entries and safe-area geometry`, async ({ page }) => {
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    const tabs = page.locator('[data-phone-tabs]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('.rail')).toHaveCount(0);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await expect(page.locator('[data-composer]')).toBeVisible();
    await page.locator('[data-ios-back="thread"]').click();
    await expect(page.locator('[data-phone-list]')).toBeVisible();
    await page.locator('[data-phone-tab="wallet"]').click();
    await expect(page.locator('[data-wallet-page]')).toBeVisible();
    await expect(page.locator('[data-phone-status]')).toBeVisible();
    await page.locator('[data-phone-add-sats]').click();
    await expect(page.locator('[data-wallet-receive]')).toBeVisible();
    await page.locator('[data-phone-tab="you"]').click();
    await page.locator('[data-phone-share]').click();
    await expect(page.locator('[data-tab="frontdoor"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-settings-close]').click();
    await page.locator('[data-phone-devices]').click();
    await expect(page.locator('[data-tab="devices"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-settings-close]').click();
    const bounds = await tabs.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(852);
  });
  test(`${lang}: a long reason on an unsent message stays on screen`, async ({ page }) => {
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await page.waitForSelector('[data-stream]');
    const box = await page.evaluate(() => {
      const card = document.createElement('article');
      card.className = 'msg out unsent';
      card.innerHTML = '<div class="bubble">hi</div><div class="stamp"><span class="sats" data-unsent-reason>Ikke sendt · intet betalt · Beløbet ændrede sig under ventetiden på godkendelse, og endnu mere tekst.</span></div>';
      document.querySelector('[data-stream]')!.append(card);
      const r = card.querySelector('[data-unsent-reason]')!.getBoundingClientRect();
      return { left: r.left, right: r.right, width: window.innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
  });
  test(`${lang}: a tall composer stays inside the screen and its end can be reached`, async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto(`${preview}?scene=list&lang=${lang}`);
    await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
    await page.waitForSelector('[data-composer-bar]');
    // As tall as the first-contact limits get, without needing a real first contact.
    await page.evaluate(() => { const tall = document.createElement('div'); tall.style.cssText = 'height:900px;flex:none'; document.querySelector('.composer')!.prepend(tall); });
    const end = await page.locator('.composer').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { bottom: el.getBoundingClientRect().bottom, bar: el.querySelector('[data-composer-bar]')!.getBoundingClientRect().bottom };
    });
    expect(end.bottom).toBeLessThanOrEqual(874);
    expect(end.bar).toBeLessThanOrEqual(874);
  });
  for (const platform of ['ios', 'android']) {
    test(`${lang}: the + menu is not clipped by the composer on ${platform}`, async ({ page }) => {
      await page.goto(`${preview}?scene=list&lang=${lang}`);
      await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
      await page.waitForSelector('[data-composer-bar]');
      await page.evaluate((p) => { document.documentElement.dataset.platform = p; }, platform);
      await page.locator('[data-composer-plus]').click();
      const onTop = await page.locator('[data-composer-mode="pay"]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      });
      expect(onTop).toBe(true);
    });
  }
  // F08/F09. A long chat, a composer taller than the screen and the largest text, with the
  // + menu or the emoji picker open. The composer must stay a real scroll box while either is
  // open, and the bar, the menu and the last emoji must be reachable where a finger lands.
  // Nothing here uses a Playwright click (it scrolls on its own) or scrollIntoView: each tap
  // goes to a point that elementFromPoint has just confirmed. The emoji picker opens over the
  // chat outside the composer's scroll box, so it is its own picker box that is scrolled to
  // reach the last emoji (the composer is no longer the region that holds it).
  for (const platform of ['ios', 'android']) {
    test(`${lang}: a tall composer keeps scrolling with + or emoji open, and both stay reachable on ${platform}`, async ({ page }) => {
      await page.setViewportSize({ width: 402, height: 874 });
      await page.goto(`${preview}?scene=budget-open&lang=${lang}&platform=${platform}`);
      await page.locator('[data-phone-list] [data-track^="peer:"]').first().click();
      await page.waitForSelector('[data-composer-bar]');
      const sent = await page.evaluate(() => {
        document.documentElement.style.fontSize = '53px';
        const stream = document.querySelector('[data-stream]')!;
        for (let i = 0; i < 60; i++) {
          const m = document.createElement('article');
          m.className = `msg ${i % 2 ? 'out' : 'in'}`;
          m.dataset.f08Fill = '';
          m.innerHTML = `<div class="bubble">line ${i}</div>`;
          stream.append(m);
        }
        const tall = document.createElement('div');
        tall.dataset.f08Tall = '';
        tall.style.cssText = 'height:900px;flex:none;width:10px';
        document.querySelector('.composer')!.prepend(tall);
        return document.querySelectorAll('[data-stream] .msg').length;
      });
      await page.waitForTimeout(100);
      // Geometry of a control as a finger meets it: the part inside the visual viewport and
      // inside the composer's scroll box, and what elementFromPoint finds at its centre.
      const probe = (sel: string) => page.evaluate((s) => {
        const el = document.querySelector<HTMLElement>(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const vv = window.visualViewport!;
        let top = Math.max(r.top, vv.offsetTop, 0), bottom = Math.min(r.bottom, vv.offsetTop + vv.height, window.innerHeight);
        const left = Math.max(r.left, vv.offsetLeft, 0), right = Math.min(r.right, vv.offsetLeft + vv.width, window.innerWidth);
        const c = el.closest('.composer') as HTMLElement | null;
        // A control drawn inside the composer's scroll box is cut to that box, unless it is
        // a fixed overlay, which the box does not clip.
        if (c && getComputedStyle(c).overflowY !== 'visible' && !el.closest('.composer-menu, .emoji-picker')) {
          const b = c.getBoundingClientRect();
          top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom);
        }
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { h: r.height, w: r.width, seenH: Math.max(0, bottom - top), seenW: Math.max(0, right - left), x, y, hit: !!hit && (hit === el || el.contains(hit)) };
      }, sel);
      // Below the bar sit the price, the limits and the cost details, so at this text size the
      // composer's end is not where the bar is, and the wrapped bar can be taller than the box.
      // Scroll the composer by hand to centre one control of the bar at a time.
      const scrollTo = (sel: string) => page.locator('.composer').evaluate((c: HTMLElement, s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        const box = c.getBoundingClientRect();
        c.scrollTop += r.top - (box.top + (c.clientHeight - r.height) / 2);
      }, sel);
      const composer = () => page.locator('.composer').evaluate((c: HTMLElement) => {
        const tall = c.querySelector<HTMLElement>('[data-f08-tall]')!;
        const before = tall.getBoundingClientRect().top;
        const from = c.scrollTop;
        // 200px by hand, up if there is room above, else down.
        c.scrollTop = from >= 200 ? from - 200 : from + 200;
        const moved = before - tall.getBoundingClientRect().top;
        const went = c.scrollTop - from;
        c.scrollTop = from;
        const bar = Math.max(...[...c.querySelectorAll('[data-composer-bar] > *')].map((e) => e.getBoundingClientRect().height));
        const stream = document.querySelector<HTMLElement>('[data-stream]')!;
        return {
          overflowY: getComputedStyle(c).overflowY,
          overflows: c.scrollHeight > c.clientHeight + 1,
          scrolled: Math.abs(went) >= 199 && Math.abs(moved - went) <= 1,
          // Room for the tallest control of the bar, so each can be shown whole.
          fitsControl: c.clientHeight >= bar,
          streamH: stream.clientHeight,
        };
      });
      // Every control is whole: the visible part is the control's own size, not a sliver.
      const whole = (g: { h: number; w: number; seenH: number; seenW: number; hit: boolean } | null) =>
        !!g && g.h > 0 && g.seenH >= g.h - 1 && g.seenW >= g.w - 1 && g.hit;
      const tap = async (sel: string) => {
        await scrollTo(sel);
        const g = await probe(sel);
        expect(whole(g), `${sel} is whole on screen and on top before it is tapped`).toBe(true);
        await page.mouse.click(g!.x, g!.y);
      };

      // R1 + R4 with nothing open: a real scroll box, and neither the chat nor the composer collapses.
      const closed = await composer();
      expect(closed).toMatchObject({ overflows: true, scrolled: true, fitsControl: true });
      expect(closed.streamH).toBeGreaterThan(0);
      // R2/R3: the bar's controls, at their real size, inside the visual viewport and on top.
      for (const sel of ['[data-composer-plus]', '[data-emoji]', '[data-composer-bar] textarea']) {
        await scrollTo(sel);
        expect(whole(await probe(sel)), sel).toBe(true);
      }

      // + menu: open, scroll, close, open again.
      for (const round of [1, 2]) {
        await tap('[data-composer-plus]');
        await expect(page.locator('[data-composer-menu]')).toBeVisible();
        const open = await composer();
        expect({ round, overflowY: open.overflowY === 'visible' ? 'visible' : 'scrolls', overflows: open.overflows, scrolled: open.scrolled })
          .toEqual({ round, overflowY: 'scrolls', overflows: true, scrolled: true });
        expect(open.fitsControl).toBe(true);
        expect(open.streamH).toBeGreaterThan(0);
        await scrollTo('[data-composer-plus]');
        expect(whole(await probe('[data-composer-plus]')), 'the + is still reachable with the menu open').toBe(true);
        for (const m of ['pay', 'request', 'file']) expect(whole(await probe(`[data-composer-mode="${m}"]`)), `menu item ${m}`).toBe(true);
        if (round === 1) {
          await page.keyboard.press('Escape');
          await expect(page.locator('[data-composer-menu]')).toBeHidden();
          await expect(page.locator('[data-composer-plus]')).toBeFocused();
        } else {
          await tap('[data-composer-plus]');
          await expect(page.locator('[data-composer-menu]')).toBeHidden();
        }
      }

      // R5: emoji picker over the bar, the last emoji in reach, Escape returns focus.
      await tap('[data-emoji]');
      await expect(page.locator('[data-emoji-picker]')).toBeVisible();
      const withPicker = await composer();
      expect({ overflowY: withPicker.overflowY === 'visible' ? 'visible' : 'scrolls', overflows: withPicker.overflows, scrolled: withPicker.scrolled })
        .toEqual({ overflowY: 'scrolls', overflows: true, scrolled: true });
      const over = await page.evaluate(() => {
        const p = document.querySelector('[data-emoji-picker]')!.getBoundingClientRect();
        const b = document.querySelector('[data-emoji]')!.getBoundingClientRect();
        return p.bottom <= b.top + 1 && p.height > 0;
      });
      expect(over, 'the picker opens over the bar').toBe(true);
      await page.locator('[data-emoji-picker]').evaluate((p: HTMLElement) => {
        const last = p.querySelector<HTMLElement>('[data-emoji-pick]:last-child')!;
        p.scrollTop += last.getBoundingClientRect().top - (p.getBoundingClientRect().top + p.clientHeight / 2);
      });
      expect(whole(await probe('[data-emoji-pick]:last-child')), 'the last emoji is reachable').toBe(true);
      await scrollTo('[data-emoji]');
      expect(whole(await probe('[data-emoji]')), 'the emoji button is still reachable').toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-emoji-picker]')).toHaveCount(0);
      await expect(page.locator('[data-emoji]')).toBeFocused();

      // R4: the iPhone keyboard takes the bottom of the visual viewport (the src/ios/keyboard.ts
      // contract); the bar and the menu stay inside what is left.
      if (platform === 'ios') {
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 482 });
          window.visualViewport!.dispatchEvent(new Event('resize'));
        });
        await page.waitForTimeout(100);
        await scrollTo('[data-composer-plus]');
        expect(whole(await probe('[data-composer-plus]')), 'the + with the keyboard up').toBe(true);
        await tap('[data-composer-plus]');
        expect(whole(await probe('[data-composer-mode="pay"]')), 'the menu with the keyboard up').toBe(true);
        const kb = await composer();
        expect({ overflows: kb.overflows, scrolled: kb.scrolled }).toEqual({ overflows: true, scrolled: true });
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-composer-menu]')).toBeHidden();
      }

      // Nothing was sent, paid or put up for approval, and no overlay is left behind.
      expect(await page.locator('[data-stream] .msg').count()).toBe(sent);
      await expect(page.locator('[data-first-spend-scrim]')).toHaveCount(0);
      await expect(page.locator('[data-composer-menu]')).toBeHidden();
      await expect(page.locator('[data-emoji-picker]')).toHaveCount(0);
    });
  }
  test(`${lang}: first-spend is in the top layer above the tabs, with edge Back blocked`, async ({ page }) => {
    await page.goto(`${preview}?scene=first-spend&lang=${lang}`);
    await expect(page.locator('[data-first-spend-scrim]')).toBeVisible();
    expect(await page.locator('[data-first-spend-scrim]').evaluate(el => el.matches(':modal'))).toBe(true);
    const top = await page.locator('[data-phone-tabs]').evaluate(el => {
      const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-first-spend-scrim]') !== null;
    });
    expect(top).toBe(true);
  });
  test(`${lang}: AX5 Allow stays visible while the keyboard hides phone tabs`, async ({ page }) => {
    await page.goto(`${preview}?scene=first-spend&lang=${lang}`);
    const tabs = page.locator('[data-phone-tabs]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('[data-first-spend-sheet]')).toBeVisible();
    await page.addStyleTag({ content: 'html[data-platform="ios"] { font-size: 53px; }' });
    await page.locator('.first-spend-options summary').click();
    await page.locator('[data-first-spend-custom]').click();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 482 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await page.locator('[data-first-spend-amount]').fill('1250.5');
    await expect(tabs).toBeHidden();
    await expect(page.locator('[data-first-spend-allow]')).toBeEnabled();
    await expect.poll(async () => page.locator('[data-first-spend-allow]').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= visualViewport!.height;
    })).toBe(true);
    await expect(page.locator('[data-first-spend-keyboard-daily]')).toContainText('1\u202f250\u202f500 msat');
    await page.evaluate(() => {
      delete (window.visualViewport as any).height;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(tabs).toBeVisible();
  });
}
test('AX5-equivalent text keeps phone labels inside the viewport', async ({ page }) => {
  for (const scene of ['list', 'chat', 'wallet', 'you', 'first-spend']) {
    await page.goto(`${preview}?scene=${scene}&lang=da`);
    await page.locator('[data-phone-tabs]').waitFor();
    await page.evaluate(() => document.documentElement.style.fontSize = '53px');
    await page.waitForTimeout(700);
    const result = await page.evaluate(() => (window as any).phoneGeometry());
    expect(result.failures).toEqual([]);
  }
});
test('keyboard state hides tabs and restores the same route after dismissal', async ({ page }) => {
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await page.evaluate(() => document.documentElement.dataset.keyboardOpen = 'true');
  await expect(page.locator('[data-phone-tabs]')).toBeHidden();
  await expect(page.locator('[data-phone-status]')).toBeVisible();
  await page.evaluate(() => document.documentElement.dataset.keyboardOpen = 'false');
  await expect(page.locator('[data-phone-tabs]')).toBeVisible();
  await expect(page.locator('[data-composer]')).toBeVisible();
});
test('starter remains reachable when flagged and blocks swipe Back', async ({ page }) => {
  await page.goto(`${preview}?scene=starter`);
  await expect(page.locator('[data-starter-balance]')).toBeVisible();
  await expect(page.locator('[data-wallet-close]')).toBeVisible();
  expect(await page.locator('[data-phone-tabs]').evaluate(el => {
    const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-wallet-page]') !== null;
  })).toBe(true);
  await page.locator('[data-wallet-close]').click();
  await expect(page.locator('[data-starter-entry]')).toBeVisible();
});

for (const scene of ['offline', 'repair', 'contacts-error']) {
  test(`${scene}: recovery remains reachable on the landing list`, async ({ page }) => {
    await page.goto(`${preview}?scene=${scene}`);
    await expect(page.locator('[data-phone-list]')).toBeVisible();
    const selector = scene === 'offline' ? '[data-node-offline] button' : scene === 'repair' ? '[data-call-repairs] button' : '[data-phone-list] [data-soft-reconnect]';
    const control = page.locator(selector).first();
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    if (scene === 'contacts-error') {
      await expect(page.locator('[data-phone-list]')).toContainText('We could not load your contacts.');
      await expect(page.locator('[data-phone-list]')).not.toContainText('No contacts yet');
    }
  });
}
test('landscape iPhone retains tabs and tapping Chats returns to its list', async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 393 });
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await expect(page.locator('[data-phone-tabs]')).toBeVisible();
  await expect(page.locator('.rail')).toHaveCount(0);
  await page.locator('[data-phone-tab="chats"]').click();
  await expect(page.locator('[data-phone-list]')).toBeVisible();
  await page.screenshot({ path: 'docs/ui/u5-phone-shell/webkit-landscape-list.png' });
});
test('pending node approval blocks both navigation paths, including attribute transitions', async ({ page }) => {
  await page.goto(`${preview}?scene=chat`);
  await expect(page.locator('[data-composer]')).toBeVisible();
  await page.evaluate(() => {
    const card = document.createElement('div'); card.dataset.approval = 'idle';
    card.textContent = 'Confirm at your node'; document.querySelector('.track')!.append(card);
  });
  await expect(page.locator('[data-phone-tabs]')).not.toHaveAttribute('inert');
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-approval]')!.dataset.approval = 'pending');
  await expect(page.locator('[data-phone-tabs]')).toHaveAttribute('inert');
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite serves the module at this browser URL.
    const { visibleBackDestination } = await import('/src/ios/edgeBack.ts');
    return visibleBackDestination();
  })).toBeNull();
  await page.locator('[data-phone-tab="you"]').evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.locator('[data-composer]')).toBeVisible();
  await expect(page.locator('[data-phone-you]')).toHaveCount(0);
});

// The file button's longer label reflows inside the composer at phone widths,
// in both languages and denominations, instead of being clipped by its panel.
for (const [scene, lang, denom, width] of ['budget-open', 'spend-open'].flatMap((scene) => ['en', 'da'].flatMap((lang) => ['sats', 'btc'].flatMap((denom) =>
  [320, 360, 375, 390, 480].map((width) => [scene, lang, denom, width] as const))))) {
      test(`${scene} ${lang} ${denom} ${width}: the file button stays inside its row`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => localStorage.setItem('bitsov.denom', value), denom);
        await page.goto(`${preview}?scene=${scene}&lang=${lang}`);
        await page.locator('[data-track^="peer:"]').first().click();
        await page.locator('[data-composer-mode="file"]').evaluate((el: HTMLElement) => el.click());
        await page.locator('[data-file-input]').setInputFiles({ name: 'hi.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
        const send = page.locator('[data-composer] [data-send]');
        await expect(send).toBeVisible();
        const row = page.locator('[data-composer] .composer-main.file-row');
        const panel = page.locator('[data-composer]');
        await expect(send).toContainText(lang === 'da' ? 'højst' : 'up to');
        await page.waitForTimeout(400); // The phone shell's slide has settled.
        const [button, box, outer] = [(await send.boundingBox())!, (await row.boundingBox())!, (await panel.boundingBox())!];
        // Half a pixel for sub-pixel rounding between browsers.
        expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(button.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
        expect(outer.x + outer.width).toBeLessThanOrEqual(width + 0.5);
        expect(await send.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      });
}

for (const lang of ['en', 'da']) {
  test(`${lang}: the contact panel keeps focus and hides the chat and tabs behind it`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${preview}?scene=chat&lang=${lang}`);
    await expect(page.locator('[data-composer]')).toBeVisible();
    await checkContactPanelModal(page, ['[data-send]', '[data-composer-plus]', '[data-call="audio"]', '[data-phone-tab="chats"]', '[data-ios-back="thread"]']);
  });
  for (const width of [360, 393]) {
    test(`${lang} ${width}: the assistant's Forget button keeps its word on one line`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto(`${preview}?scene=list&lang=${lang}`);
      await page.locator('[data-phone-list] [data-rail-advanced] > summary').click();
      await page.locator('[data-phone-list] [data-track="assistant:node"]').click();
      const forget = page.locator('[data-assistant-forget]');
      await expect(forget).toBeVisible();
      const lines = await forget.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
      expect(lines).toBe(1);
      expect(await forget.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    });
  }
}

// UX-10. A room nobody in it can receive yet: the reason under the cost wraps and stays
// readable, and the composer stays on screen.
const noRecipients = { en: 'No members can receive this message right now', da: 'Ingen medlemmer kan modtage denne besked lige nu' };
for (const lang of ['en', 'da'] as const) {
  for (const [width, height] of [[360, 740], [393, 852]] as const) {
    test(`${lang} ${width}: a room's can't-send reason wraps and the composer stays on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${preview}?scene=list&lang=${lang}`);
      await page.waitForSelector('[data-phone-list]');
      // A local room with two sample contacts, as + New room would leave it.
      const id = await page.evaluate(async () => {
        const room = await import('/src/control/room.ts');
        const own = '3f9a' + '1'.repeat(56) + 'c0de';
        const made = await room.newRoom(own, ['a'.repeat(64), 'b'.repeat(64)]);
        return room.rememberRoom(made)!.id;
      });
      await page.locator(`[data-phone-list] [data-track="bound:${id}"]`).click();
      const basis = page.locator('[data-room-composer] [data-cost] .basis');
      await expect(basis).toHaveText(noRecipients[lang]);
      await page.waitForTimeout(400); // The phone shell's slide has settled.
      const m = await basis.evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const form = el.closest('[data-room-composer]')!.getBoundingClientRect();
        const send = el.closest('[data-room-composer]')!.querySelector('[data-send]')!.getBoundingClientRect();
        return { sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, overflow: s.overflowX, ellipsis: s.textOverflow, left: r.left, right: r.right,
          top: form.top, bottom: form.bottom, sendRight: send.right, sendBottom: send.bottom, vw: window.innerWidth, vh: window.innerHeight };
      });
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.sh).toBeLessThanOrEqual(m.ch);
      expect(m.overflow).not.toBe('hidden');
      expect(m.ellipsis).not.toBe('ellipsis');
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.vw + 0.5);
      expect(m.top).toBeGreaterThanOrEqual(0);
      expect(m.bottom).toBeLessThanOrEqual(m.vh + 0.5);
      expect(m.sendRight).toBeLessThanOrEqual(m.vw + 0.5);
      expect(m.sendBottom).toBeLessThanOrEqual(m.vh + 0.5);
    });
  }
}
