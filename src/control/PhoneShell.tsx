import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { isMobilePlatform } from '../platform';
import { t, type CopyKey } from '../i18n';

export type PhoneTab = 'chats' | 'calls' | 'wallet' | 'you';

/** Match the existing compact breakpoint, but never replace a Mac's shell. */
export function createPhoneLayout() {
  if (!isMobilePlatform()) return () => false;
  const media = window.matchMedia('(max-width: 680px)');
  const [narrow, setNarrow] = createSignal(media.matches);
  const change = () => setNarrow(media.matches);
  media.addEventListener('change', change);
  onCleanup(() => media.removeEventListener('change', change));
  return () => isMobilePlatform() && narrow();
}

const labels: Record<PhoneTab, CopyKey> = { chats: 'phoneChats', calls: 'phoneCalls', wallet: 'uiWallet', you: 'uiYou' };
export function PhoneTabs(props: { selected: PhoneTab; calls: boolean; onSelect: (tab: PhoneTab) => void; behind: boolean }) {
  const tabs = (): PhoneTab[] => props.calls ? ['chats', 'calls', 'wallet', 'you'] : ['chats', 'wallet', 'you'];
  return <nav class="phone-tabs" data-phone-tabs aria-label={t('phoneNavigation')} inert={props.behind}>
    <For each={tabs()}>{tab => <button type="button" data-phone-tab={tab} aria-current={props.selected === tab ? 'page' : undefined}
      onClick={() => props.onSelect(tab)}>{t(labels[tab])}</button>}</For>
  </nav>;
}

/** Android adjustResize can shrink both viewports. Compare with the height
 * before focus; only a focused editor may turn a resize into keyboard state. */
export function installAndroidKeyboardVisibility() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const height = () => Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
  let restingHeight = height();
  const update = () => {
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]') ?? false;
    const current = height();
    const wasOpen = root.dataset.keyboardOpen === 'true';
    if (!editing && !wasOpen) restingHeight = current;
    root.dataset.keyboardOpen = String((editing || wasOpen) && restingHeight - current > 80);
    if (current > restingHeight) restingHeight = current;
  };
  const rotate = () => { restingHeight = height(); update(); };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', rotate);
  viewport?.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  // Blur can precede the keyboard's closing frame; resize restores the baseline.
  document.addEventListener('focusout', update);
  update();
  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', rotate);
    viewport?.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
    delete root.dataset.keyboardOpen;
  };
}

/** Keep the new navigation behind the same money/approval surfaces that block
 * edge Back. Check synchronously as well: a sheet can arrive before an observer. */
export function createPhoneNavigationGuard(enabled: () => boolean) {
  const [blocked, setBlocked] = createSignal(false);
  const check = () => enabled() && Array.from(document.querySelectorAll(
    '[data-composer-panel], [data-starter-balance], [data-wallet-send], [data-first-spend-scrim], [data-owner-approval-sheet], [data-contact-approval], [data-swipe-approval="true"], [data-swipe-money="true"], dialog[open]',
  )).some(el => !el.closest('[hidden], [inert], [aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
  onMount(() => {
    if (!isMobilePlatform()) return;
    const update = () => setBlocked(check());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-hidden', 'open', 'data-swipe-approval', 'data-swipe-money'] });
    update(); onCleanup(() => observer.disconnect());
  });
  return { blocked, check };
}
