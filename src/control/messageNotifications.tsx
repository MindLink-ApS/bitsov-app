import { createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, onAction, registerActionTypes } from '@tauri-apps/plugin-notification';
import { t } from '../i18n';
import { isMacOS } from '../platform';
import type { Message } from './types';

const ASKED = 'bitsov.notifications.asked';
const ENABLED = 'bitsov.notifications.enabled';
const DEFERRED = 'bitsov.notifications.deferred';
const MUTED = 'bitsov.notifications.muted';
const read = (key: string) => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } };
const save = (key: string, value: boolean) => { try { localStorage.setItem(key, String(value)); } catch { /* Session state remains available. */ } };
const notificationsMuted = () => read(MUTED);
let nextCallNotification = 1_000_000;

/** One phone notification per contact at most this often; later ones in the window are dropped. */
export const PHONE_NOTIFY_COOLDOWN_MS = 30_000;
/** At most this many phone notifications in any minute, all contacts and missed calls together. */
export const PHONE_NOTIFY_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

/**
 * Only live arrivals enter here; history reads never produce alerts.
 * `mobile`: a phone's lock screen is public, so every line is generic (no names, text,
 * amounts or ids), alerts fire only while the app is in the background, a contact gets at
 * most one per `PHONE_NOTIFY_COOLDOWN_MS`, no more than `PHONE_NOTIFY_PER_MINUTE` are shown in
 * any minute, and a call that went unanswered says so once.
 */
export function createMessageNotifications(options: { mobile?: boolean; now?: () => number } = {}) {
  const mobile = options.mobile ?? false;
  const now = options.now ?? (() => Date.now());
  // Calls (with their Show call action) and owner approvals stay on the Mac. Windows and
  // Linux get plain message delivery: no action types, listeners or window restoration.
  const calls = !mobile && isMacOS();
  const sound = calls ? 'NSUserNotificationDefaultSoundName'
    : /\bWindows\b/.test(typeof navigator === 'undefined' ? '' : navigator.userAgent) ? 'Default' : 'message-new-instant';
  const [permission, setPermission] = createSignal<'checking' | 'prompt' | 'granted' | 'denied' | 'error'>('checking');
  const [muted, updateMuted] = createSignal(notificationsMuted());
  const [deferred, setDeferred] = createSignal(read(DEFERRED));
  let asked = read(ASKED);
  let enabled = read(ENABLED);
  let disposed = false;
  let requesting = false;
  const seen = new Set<string>();
  const lastByContact = new Map<string, number>();
  /** Phones: when each alert of the last minute was shown (or is pending). */
  const shownThisMinute: number[] = [];
  /** Phones: the app is in the foreground when its page is visible. */
  const foreground = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
  const callActions = new Map<number, { current: () => boolean; open: () => void }>();
  let listener: ReturnType<typeof onAction> | undefined;
  const listenForCalls = () => listener ??= onAction(event => {
    const call = callActions.get(event.notification?.id ?? -1);
    if (!call || disposed || !call.current() || !['tap', 'open-call'].includes(event.actionId)) return;
    void (async () => {
      const window = getCurrentWindow();
      await window.show();
      await window.unminimize();
      if (disposed || !call.current()) return;
      await window.setFocus();
      if (!disposed && call.current()) call.open();
    })().catch(() => { if (!disposed) setPermission('error'); });
  });
  const checkPermission = async () => {
    try {
      const granted = await isPermissionGranted();
      setPermission(!asked ? 'prompt' : granted && enabled ? 'granted' : 'denied');
    }
    catch { setPermission('error'); }
  };
  const request = async () => {
    if (requesting || disposed) return;
    if (asked || read(ASKED)) { asked = true; await checkPermission(); return; }
    // The tap records the user's choice separately from OS permission. A later
    // Settings permission change can recover denial/error without a second prompt.
    requesting = true; asked = true; enabled = true;
    save(ASKED, true); save(ENABLED, true);
    try {
      const granted = await requestPermission() === 'granted';
      setPermission(granted ? 'granted' : 'denied');
    }
    catch { setPermission('error'); }
    finally { requesting = false; }
  };
  /** True only when the OS was asked to show the alert and accepted it. */
  const notify = async (id: string, body: string, current = () => true, open?: () => void): Promise<boolean> => {
    if (disposed || seen.has(id)) return false;
    seen.add(id);
    if (muted() || !enabled) return false;
    try {
      if (mobile) {
        if (foreground() || !await isPermissionGranted() || disposed || muted() || foreground()) return false;
        await invoke('plugin:notification|notify', { options: { title: t('notificationApp'), body } });
        return true;
      }
      const window = getCurrentWindow();
      if (await window.isFocused() || disposed || muted()) return false;
      // Arrival never prompts: the visible explanation owns the permission tap.
      if (!await isPermissionGranted()) return false;
      if (open) {
        await listenForCalls();
        await registerActionTypes([{ id: 'bitsov-incoming-call', actions: [{ id: 'open-call', title: t('incomingOpenCall') }] }]);
      }
      const focused = await window.isFocused();
      if (disposed || muted() || focused || !current()) return false;
      // The locked macOS backend maps this sentinel to the OS default sound; Windows and
      // Linux use their own default message sound names.
      // The JS sendNotification wrapper discards its promise. Await the same plugin
      // command so native failures become visible in Settings instead of unhandled errors.
      const notificationId = open ? nextCallNotification++ : undefined;
      if (open) callActions.set(notificationId!, { current, open });
      await invoke('plugin:notification|notify', { options: { title: t('notificationApp'), body,
        ...(open ? { id: notificationId, actionTypeId: 'bitsov-incoming-call' } : { sound }) } });
      return true;
    } catch { if (!disposed) setPermission('error'); return false; }
  };
  /**
   * Phones: `notify` within the overall cap. A slot is held while the alert is pending (so a
   * burst cannot pass the cap) and given back when nothing was shown.
   */
  const notifyPhone = async (id: string, body: string): Promise<boolean> => {
    const at = now();
    while (shownThisMinute.length > 0 && at - shownThisMinute[0] >= MINUTE_MS) shownThisMinute.shift();
    if (shownThisMinute.length >= PHONE_NOTIFY_PER_MINUTE) return false;
    shownThisMinute.push(at);
    const shown = await notify(id, body);
    if (!shown) {
      const slot = shownThisMinute.indexOf(at);
      if (slot >= 0) shownThisMinute.splice(slot, 1);
    }
    return shown;
  };
  const name = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || t('notificationSomeone');
  return {
    permission, muted, deferred, checkPermission, request, calls,
    setMuted(value: boolean) { updateMuted(value); save(MUTED, value); },
    defer() { setDeferred(true); save(DEFERRED, true); },
    message(message: Message, ownId: string, senderName: string) {
      if (message.sender.toLowerCase() === ownId.toLowerCase() || !((message.payment_amount_msat ?? 0) > 0) || ![0, 200].includes(message.kind)) return;
      if (mobile) {
        const contact = message.sender.toLowerCase();
        const last = lastByContact.get(contact);
        if (last !== undefined && now() - last < PHONE_NOTIFY_COOLDOWN_MS) return;
        // Held while the alert is pending, so a burst gets one alert. An alert that was not shown
        // (app in view, muted, no permission, an error) gives the time back: the next one may show.
        const held = now();
        lastByContact.set(contact, held);
        void notifyPhone(`message:${message.id}`, t('notificationNewMessage')).then((shown) => {
          if (shown || lastByContact.get(contact) !== held) return;
          if (last === undefined) lastByContact.delete(contact); else lastByContact.set(contact, last);
        });
        return;
      }
      // Windows and Linux show a generic line: no sender identifier and no message content.
      void notify(`message:${message.id}`, calls ? t('notificationMessage', name(senderName)) : t('notificationNewMessage'));
    },
    call(id: string, callerName: string, current?: () => boolean, open?: () => void) { if (calls) void notify(`call:${id}`, t('notificationCall', name(callerName)), current, open); },
    /** Phones: an incoming call that ended unanswered, said once and without a name. */
    missedCall(id: string) { if (mobile) void notifyPhone(`missed:${id}`, t('notificationMissedCall')); },
    dispose() { disposed = true; seen.clear(); callActions.clear(); void listener?.then(l => l.unregister()).catch(() => {}); },
  };
}
export type MessageNotifications = ReturnType<typeof createMessageNotifications>;

export function NotificationSettings(props: { notifications: MessageNotifications; offer?: boolean }) {
  const n = props.notifications;
  return <Show when={!props.offer || n.permission() === 'error' || (n.permission() === 'prompt' && !n.deferred())}>
    <section class="panel" data-notification-settings>
      <h3>{t('notificationTitle')}</h3>
      <p class="hint">{t('notificationReason')}</p>
      <Show when={n.permission() === 'prompt'}>
        <button type="button" class="soft" data-notification-enable onClick={() => void n.request()}>{t('notificationEnable')}</button>
        <Show when={props.offer}><button type="button" class="link" onClick={n.defer}>{t('obNotNow')}</button></Show>
      </Show>
      <Show when={!props.offer && n.permission() === 'granted'}><p role="status">{t('notificationGranted')}</p></Show>
      <Show when={n.permission() === 'denied'}><p role="status">{t('notificationDenied')}</p></Show>
      <Show when={n.permission() === 'error'}><p role="status">{t('notificationError')}</p></Show>
      <Show when={!props.offer}>
        <label><input type="checkbox" data-notification-mute checked={n.muted()} onChange={e => n.setMuted(e.currentTarget.checked)} />{t('notificationMute')}</label>
      </Show>
      <Show when={!props.offer || n.permission() === 'error'}>
        <button type="button" class="link" onClick={() => void n.checkPermission()}>{t('notificationCheck')}</button>
      </Show>
    </section>
  </Show>;
}
