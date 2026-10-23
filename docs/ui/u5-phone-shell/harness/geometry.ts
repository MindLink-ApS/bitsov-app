// Run inside the native WKWebView, not a DOM emulator. Scrollable vertical
// content is reachable; horizontal overflow and clipped text are failures.
export function geometry(scene: string, lang: string) {
  const root = document.documentElement;
  const selectors = '.phone-tabs button, .phone-status .node-pill, .phone-chat-list .track-link, .phone-page button, .phone-chat-list h1, .phone-page h1, .sats, .money-text, .money, [data-send-price], .cost, .wallet-totals, .wallet-total, .wallet-row-amount, .split-amount, .owner-approval-terms, .owner-sheet-terms, .first-spend-sheet p, .first-spend-sheet h2, .first-spend-sheet button, .first-spend-sheet input, .owner-approval-sheet button, .wallet-page button, [data-first-spend-keyboard-summary], [data-first-spend-keyboard-summary] > *, .approval';
  const elements = [...document.querySelectorAll<HTMLElement>(selectors)].filter(el =>
    el.getClientRects().length && !el.closest('[inert], [hidden], [aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden');
  const measured = elements.map(el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const range = document.createRange(); range.selectNodeContents(el);
    const textRects = [...range.getClientRects()].filter(r => r.width && r.height);
    const failures: string[] = [];
    if (el.matches('input') && root.dataset.keyboardOpen === 'true') {
      const summary = document.querySelector('[data-first-spend-keyboard-summary]')?.getBoundingClientRect();
      if (summary && rect.top < summary.bottom - 1) failures.push('input-covered-by-quote');
      if (rect.bottom > visualViewport!.height + 1 || rect.top < 0) failures.push('input-outside-viewport');
    }
    if (rect.left < -1 || rect.right > visualViewport!.width + 1) failures.push('outside-viewport-width');
    if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) failures.push('horizontal-overflow');
    if (el.clientHeight && el.scrollHeight > el.clientHeight + 1 && ['hidden','clip'].includes(style.overflowY)) failures.push('vertical-clipping');
    if (textRects.some(r => r.left < rect.left - 1 || r.right > rect.right + 1)) failures.push('text-outside-element');
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const ps = getComputedStyle(parent), pr = parent.getBoundingClientRect();
      if (['hidden','clip'].includes(ps.overflowX) && (rect.left < pr.left - 1 || rect.right > pr.right + 1)) failures.push('ancestor-horizontal-clipping');
    }
    return { tag: el.tagName, class: el.className, text: el.textContent, rect: rect.toJSON(), font: style.fontSize,
      whiteSpace: style.whiteSpace, client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight], failures };
  });
  const readySelectors: Record<string, string> = { list: '[data-phone-list]', chat: '[data-composer]', wallet: '[data-balance-total]', 'first-spend': '[data-first-spend-scrim][open]', you: '[data-phone-you]', keyboard: '[data-composer]', starter: '[data-starter-balance]', pay: '[data-composer-panel="pay"]' };
  const readySelector = readySelectors[scene];
  return { scene, lang, generatedAt: Date.now(), ready: !!readySelector && !!document.querySelector(readySelector) && document.fonts.status === 'loaded', rootFont: getComputedStyle(root).fontSize, bodyFont: getComputedStyle(document.body).fontSize,
    space: getComputedStyle(document.querySelector('.phone-tabs')!).gap,
    viewport: {width: visualViewport!.width, height: visualViewport!.height, top: visualViewport!.offsetTop, scale: visualViewport!.scale},
    keyboard: root.dataset.keyboardOpen, ownerSheetMounted: !!document.querySelector('[data-owner-approval-sheet]'),
    tabBar: document.querySelector('[data-phone-tabs]')?.getBoundingClientRect().toJSON(),
    tabDisplay: getComputedStyle(document.querySelector('[data-phone-tabs]')!).display,
    status: document.querySelector('[data-phone-status]')?.getBoundingClientRect().toJSON(),
    safeAreas: ['top', 'bottom', 'left', 'right'].map(side => ({side, value: getComputedStyle(document.querySelector('.cc')!).getPropertyValue('--safe-area-' + side)})),
    elements: measured, failures: measured.filter(el => el.failures.length) };
}
