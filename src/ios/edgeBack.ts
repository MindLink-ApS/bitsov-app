/** Priority follows the existing overlay order, never browser history. */
const routes = ['contact', 'settings-page', 'settings', 'wallet', 'call', 'thread'] as const;
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

export const visibleNavigationSurface = (el: Element, includeCallUnderlay = false) => !el.closest('[hidden], [aria-hidden="true"]')
  && !el.closest(includeCallUnderlay ? '[inert]:not([data-call-underlay="true"])' : '[inert]')
  && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
/** Shared by edge Back and phone tabs. Receive is a Wallet destination, so only
 * edge Back blocks it; ordinary page dialogs are routes, not blocking sheets. */
export function navigationBlocked(includeReceive = false, root: ParentNode = document): boolean {
  const selector = '[data-swipe-money="true"], [data-composer-panel], [data-wallet-send], [data-starter-balance], '
    + '[data-swipe-approval="true"], [data-first-spend-scrim], [data-contact-approval], [data-approval="pending"], '
    + '[data-ai-card="disclosure"][data-state="preview"], [data-ai-card="disclosure"][data-state="sending"], '
    + '.owner-approval, [data-owner-approval-sheet], [data-phone-onboarding="words"], [data-phone-onboarding="fingerprint"], '
    + '[data-call-approval], [data-phone-shell="true"] [data-call-panel="incoming"]';
  return Array.from(root.querySelectorAll(selector + (includeReceive ? ', [data-wallet-receive]' : ''))).some(el => visibleNavigationSurface(el, true))
    || Array.from(root.querySelectorAll('dialog[open], [role="dialog"]')).some(el => visibleNavigationSurface(el, true)
      && !el.matches('[data-settings], [data-wallet-page], [data-contact-panel], [data-call-panel]'));
}
/** The same buttons handle taps and gestures. New/unrecognized dialogs fail closed. */
export function visibleBackDestination(): Destination | null {
  if (navigationBlocked(true)) return null;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-ios-back]')).filter(el => visibleNavigationSurface(el) && !el.disabled);
  const route = backRoute({ routes: buttons.map(el => el.dataset.iosBack as BackRoute), money: false, approval: false, call: false, modal: false });
  const button = buttons.find(el => el.dataset.iosBack === route);
  return route && button ? { route, identity: button, back: () => button.click() } : null;
}
