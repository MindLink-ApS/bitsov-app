import { createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { t } from '../i18n';
import type { Message } from './types';

const ASKED = 'bitsov.notifications.asked';
const ENABLED = 'bitsov.notifications.enabled';
const DEFERRED = 'bitsov.notifications.deferred';
const MUTED = 'bitsov.notifications.muted';
const read = (key: string) => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } };
const save = (key: string, value: boolean) => { try { localStorage.setItem(key, String(value)); } catch { /* Session state remains available. */ } };
const notificationsMuted = () => read(MUTED);

/** Only live arrivals enter here; history reads never produce alerts. */
export function createMessageNotifications() {
  const [permission, setPermission] = createSignal<'checking' | 'prompt' | 'granted' | 'denied' | 'error'>('checking');
  const [muted, updateMuted] = createSignal(notificationsMuted());
  const [deferred, setDeferred] = createSignal(read(DEFERRED));
  let asked = read(ASKED);
  let enabled = read(ENABLED);
  let disposed = false;
  let requesting = false;
  const seen = new Set<string>();
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
  const notify = async (id: string, body: string, current = () => true) => {
    if (disposed || seen.has(id)) return;
    seen.add(id);
    if (muted() || !enabled) return;
    try {
      const window = getCurrentWindow();
      if (await window.isFocused() || disposed || muted()) return;
      // Arrival never prompts: the visible explanation owns the permission tap.
      if (!await isPermissionGranted()) return;
      const focused = await window.isFocused();
      if (disposed || muted() || focused || !current()) return;
      // The locked macOS backend maps this sentinel to the OS default sound.
      // The JS sendNotification wrapper discards its promise. Await the same plugin
      // command so native failures become visible in Settings instead of unhandled errors.
      await invoke('plugin:notification|notify', { options: { title: t('notificationApp'), body, sound: 'NSUserNotificationDefaultSoundName' } });
    } catch { if (!disposed) setPermission('error'); }
  };
  const name = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || t('notificationSomeone');
  return {
    permission, muted, deferred, checkPermission, request,
    setMuted(value: boolean) { updateMuted(value); save(MUTED, value); },
    defer() { setDeferred(true); save(DEFERRED, true); },
    message(message: Message, ownId: string, senderName: string) {
      if (message.sender.toLowerCase() === ownId.toLowerCase() || !((message.payment_amount_msat ?? 0) > 0) || ![0, 200].includes(message.kind)) return;
      void notify(`message:${message.id}`, t('notificationMessage', name(senderName)));
    },
    call(id: string, callerName: string, current?: () => boolean) { void notify(`call:${id}`, t('notificationCall', name(callerName)), current); },
    dispose() { disposed = true; seen.clear(); },
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
