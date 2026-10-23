/** Priority follows the existing overlay order, never browser history. */
const routes = ['contact', 'settings-page', 'settings', 'wallet', 'thread'] as const;
export type BackRoute = typeof routes[number];
export type BackState = { routes: readonly BackRoute[]; money: boolean; approval: boolean; call: boolean; modal: boolean };
export function backRoute(state: BackState): BackRoute | null {
  if (state.money || state.approval || state.call || state.modal) return null;
  return routes.find(route => state.routes.includes(route)) ?? null;
}
type Point = { x: number; y: number };
export function edgeSwipe(start: Point, end: Point, elapsed: number) {
  const dx = end.x - start.x;
  return start.x >= 0 && start.x <= 24 && dx >= 64 && Math.abs(end.y - start.y) <= dx / 2 && elapsed <= 1000;
}
type Destination = { route: BackRoute; back: () => void; identity?: unknown };

/** Only an intentional, single-finger left-edge drag claims scrolling. */
export function installEdgeBack(destination: () => Destination | null = visibleBackDestination) {
  let start: (Point & { time: number; id: number; destination: Destination }) | null = null;
  const cancel = () => { start = null; };
  const begin = (event: TouchEvent) => {
    cancel();
    const next = destination();
    const touch = event.touches[0];
    if (!next || event.touches.length !== 1 || touch.clientX > 24 || window.visualViewport && window.visualViewport.scale !== 1) return;
    start = { x: touch.clientX, y: touch.clientY, time: performance.now(), id: touch.identifier, destination: next };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) return cancel();
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    if (touch.identifier !== start.id || Math.abs(touch.clientY - start.y) > Math.max(12, dx / 2) || dx < -8) return cancel();
    if (dx > 12 && event.cancelable) event.preventDefault();
  };
  const end = (event: TouchEvent) => {
    const first = start; cancel();
    if (!first || event.touches.length) return;
    const touch = Array.from(event.changedTouches).find(t => t.identifier === first.id);
    const next = destination(); // An approval or call could arrive during the gesture.
    if (!touch || !next || first.destination.route !== next.route || first.destination.identity !== next.identity) return;
    if (!edgeSwipe(first, { x: touch.clientX, y: touch.clientY }, performance.now() - first.time)) return;
    if (event.cancelable) event.preventDefault();
    next.back();
  };
  document.addEventListener('touchstart', begin, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', cancel);
  return () => {
    document.removeEventListener('touchstart', begin);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', cancel);
  };
}

const visible = (el: Element) => !el.closest('[hidden], [inert], [aria-hidden="true"]')
  && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
/** The same buttons handle taps and gestures. New/unrecognized dialogs fail closed. */
export function visibleBackDestination(): Destination | null {
  const any = (selector: string) => Array.from(document.querySelectorAll(selector)).some(visible);
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-ios-back]')).filter(el => visible(el) && !el.disabled);
  const route = backRoute({
    routes: buttons.map(el => el.dataset.iosBack as BackRoute),
    money: any('[data-swipe-money="true"], [data-composer-panel], [data-wallet-send], [data-wallet-receive], [data-starter-balance]'),
    approval: any('[data-swipe-approval="true"], [data-first-spend-scrim], [data-contact-approval], [data-approval="pending"], [data-ai-card="disclosure"][data-state="preview"], [data-ai-card="disclosure"][data-state="sending"], .owner-approval, [data-owner-approval-sheet], [data-phone-onboarding="words"], [data-phone-onboarding="fingerprint"]'),
    call: any('[data-swipe-call="true"]'),
    modal: Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).some(el => visible(el)
      && !el.matches('[data-settings], [data-wallet-page], [data-contact-panel]')),
  });
  const button = buttons.find(el => el.dataset.iosBack === route);
  return route && button ? { route, identity: button, back: () => button.click() } : null;
}
