import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createMessageNotifications, NotificationSettings } from '../src/control/messageNotifications';
import { setLanguagePref } from '../src/i18n';
const native = vi.hoisted(() => ({ isFocused: vi.fn(), isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => {
  const api = await original<typeof import('@tauri-apps/api/core')>();
  return { ...api, invoke: (command: string, args: { options: unknown }) => command === 'plugin:notification|notify' ? native.sendNotification(args.options) : api.invoke(command, args) };
});
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('@tauri-apps/plugin-notification', () => native);
let dispose: (() => void) | undefined;
let mount: HTMLElement;
beforeEach(() => { vi.resetAllMocks(); localStorage.setItem('bitsov.notifications.enabled', 'true'); localStorage.setItem('bitsov.notifications.asked', 'true'); native.isFocused.mockResolvedValue(false); native.isPermissionGranted.mockResolvedValue(true); native.requestPermission.mockResolvedValue('granted'); });
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const message = { id: 'm', kind: 0, sender: 'peer', recipient: 'me', timestamp: 1, plaintext: 'SECRET content', payment_amount_msat: 2000 };
it.each(['en', 'da'] as const)('notifies once in %s with name only and the system sound', async lang => {
  setLanguagePref(lang);
  const n = createMessageNotifications();
  n.message(message, 'me', 'Maya'); n.message(message, 'me', 'Maya');
  await flush();
  expect(native.sendNotification).toHaveBeenCalledExactlyOnceWith({ title: 'BitSov', body: lang === 'en' ? 'Maya sent you a message' : 'Maya har sendt dig en besked', sound: 'NSUserNotificationDefaultSoundName' });
  expect(JSON.stringify(native.sendNotification.mock.calls)).not.toContain('SECRET');
  n.dispose();
});
it('notifies an incoming call once, independently of messages', async () => {
  const n = createMessageNotifications(); n.call('call-1', 'Maya'); n.call('call-1', 'Maya'); await flush();
  expect(native.sendNotification).toHaveBeenCalledExactlyOnceWith({ title: 'BitSov', body: 'Maya is calling you', sound: 'NSUserNotificationDefaultSoundName' }); n.dispose();
});
it('suppresses outgoing, unpaid and call-signal messages, focused arrivals, muted arrivals and replays', async () => {
  const n = createMessageNotifications();
  n.message({ ...message, sender: 'me' }, 'me', 'Me');
  n.message({ ...message, payment_amount_msat: 0 }, 'me', 'Maya');
  n.message({ ...message, kind: 400 }, 'me', 'Maya');
  native.isFocused.mockResolvedValue(true); n.message(message, 'me', 'Maya'); await flush();
  native.isFocused.mockResolvedValue(false); n.message(message, 'me', 'Maya');
  n.setMuted(true); n.call('c', 'Maya'); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled();
  const next = createMessageNotifications(); expect(next.muted()).toBe(true); next.dispose(); n.dispose();
});
it('rechecks focus and mute after native awaits and suppresses work after disposal', async () => {
  const n = createMessageNotifications();
  native.isFocused.mockResolvedValueOnce(false).mockResolvedValue(true); n.call('a', 'Maya'); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled();
  native.isFocused.mockResolvedValue(false); n.call('b', 'Maya'); n.dispose(); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled();
});
it.each(['en', 'da'] as const)('explains permission in %s and requests it only on a tap, once across remounts', async lang => {
  setLanguagePref(lang); localStorage.removeItem('bitsov.notifications.asked'); localStorage.removeItem('bitsov.notifications.enabled'); native.isPermissionGranted.mockResolvedValue(false); native.requestPermission.mockResolvedValue('denied');
  const n = createMessageNotifications();
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <NotificationSettings notifications={n} />, mount);
  await n.checkPermission();
  expect(mount.textContent).toContain(lang === 'en' ? 'not the message' : 'ikke beskeden');
  expect(mount.textContent).not.toMatch(/hear|høre/i);
  n.message(message, 'me', 'Maya'); await flush(); expect(native.requestPermission).not.toHaveBeenCalled();
  mount.querySelector<HTMLButtonElement>('[data-notification-enable]')!.click(); await flush();
  expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(mount.textContent).toContain(lang === 'en' ? 'System Settings' : 'Systemindstillinger');
  const next = createMessageNotifications(); await next.request(); expect(native.requestPermission).toHaveBeenCalledOnce();
  expect(native.sendNotification).not.toHaveBeenCalled(); next.dispose(); n.dispose();
});
it('reports native failures visibly', async () => {
  const n = createMessageNotifications(); native.isPermissionGranted.mockRejectedValue(new Error('native failed'));
  await n.checkPermission(); expect(n.permission()).toBe('error'); n.dispose();
});

it('wires live paid messages and validated incoming calls through the real shell, never history', async () => {
  const { ControlCenter } = await import('../src/control/Shell');
  const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('isTauri', true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const source = sampleSource({ firstLiveMs: 1e9 });
  let live!: Parameters<typeof source.onLive>[0];
  source.onLive = async callback => { live = callback; return () => {}; };
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, mount);
  await vi.waitFor(() => expect(live).toBeTypeOf('function'));
  expect(native.sendNotification).not.toHaveBeenCalled();
  const incoming = { ...message, sender: 'a'.repeat(64), recipient: SAMPLE_OWN_ID, timestamp: Date.now() };
  live({ type: 'message', message: incoming, room_id: null }); await flush();
  expect(native.sendNotification).toHaveBeenCalledTimes(1);
  live({ type: 'message', message: { ...incoming, id: 'offer', kind: 400, plaintext: JSON.stringify({ v: 1, call_id: 'a'.repeat(32), media: 'audio', sdp: 'private-sdp' }) }, room_id: null });
  await flush();
  expect(native.sendNotification).toHaveBeenCalledTimes(2);
  expect(native.sendNotification.mock.calls[1][0].body).toMatch(/is calling you$/);
  expect(JSON.stringify(native.sendNotification.mock.calls)).not.toMatch(/SECRET|private-sdp/);
});

it.each(['mute', 'dispose', 'hangup'] as const)('suppresses a call when %s happens during the final focus check', async action => {
  let finish!: (focused: boolean) => void;
  let incoming = true;
  native.isFocused.mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const n = createMessageNotifications(); n.call('c', 'Maya', () => incoming); await flush();
  if (action === 'mute') n.setMuted(true);
  if (action === 'dispose') n.dispose();
  if (action === 'hangup') incoming = false;
  finish(false); await flush(); expect(native.sendNotification).not.toHaveBeenCalled(); n.dispose();
});
it('shows the explanation even when the desktop plugin reports permission granted before opt-in', async () => {
  localStorage.clear(); const n = createMessageNotifications(); await n.checkPermission();
  expect(n.permission()).toBe('prompt'); n.message(message, 'me', 'Maya'); await flush();
  expect(native.sendNotification).not.toHaveBeenCalled(); await n.request();
  expect(native.requestPermission).toHaveBeenCalledOnce(); expect(n.permission()).toBe('granted'); n.dispose();
});

it('reports a native notification delivery error instead of losing a rejected promise', async () => {
  native.sendNotification.mockRejectedValue(new Error('native failed'));
  const n = createMessageNotifications(); n.message(message, 'me', 'Maya'); await flush();
  expect(n.permission()).toBe('error');
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <NotificationSettings notifications={n} offer />, mount);
  expect(mount.querySelector('[role="status"]')?.textContent).toContain('could not be checked or sent');
  n.dispose();
});
it('attributes a meeting to its actual inviting peer even when an ignored signal arrives in the same turn', async () => {
  const { ControlCenter } = await import('../src/control/Shell');
  const { sampleSource, SAMPLE_OWN_ID } = await import('../src/control/sample');
  const { setPetname } = await import('../src/control/petnames');
  vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.stubGlobal('isTauri', true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const source = sampleSource({ firstLiveMs: 1e9 });
  const sender = 'b'.repeat(64); setPetname(sender, 'Actual caller');
  let live!: Parameters<typeof source.onLive>[0];
  source.onLive = async callback => { live = callback; return () => {}; };
  mount = document.createElement('div'); document.body.append(mount);
  dispose = render(() => <ControlCenter source={source} remote active ready error={null} ownId={SAMPLE_OWN_ID} firstRun={null} />, mount);
  await vi.waitFor(() => expect(live).toBeTypeOf('function'));
  live({ type: 'message', room_id: null, message: { ...message, id: 'ignored', sender: 'a'.repeat(64), recipient: SAMPLE_OWN_ID, kind: 400, plaintext: '{}' } });
  live({ type: 'message', room_id: null, message: { ...message, id: 'meeting-offer', sender, recipient: SAMPLE_OWN_ID, kind: 400,
    plaintext: JSON.stringify({ v: 1, call_id: 'a'.repeat(32), media: 'audio', sdp: 'private-sdp', meeting: { id: 'b'.repeat(32), roster: ['a'.repeat(64), sender, SAMPLE_OWN_ID] } }) } });
  await flush();
  expect(native.sendNotification).toHaveBeenCalledExactlyOnceWith({ title: 'BitSov', body: 'Actual caller is calling you', sound: 'NSUserNotificationDefaultSoundName' });
});

it.each(['denied', 'error'] as const)('recovers a %s permission request through Settings without asking the OS twice', async outcome => {
  localStorage.clear(); const n = createMessageNotifications();
  if (outcome === 'error') native.requestPermission.mockRejectedValueOnce(new Error('offline'));
  else native.requestPermission.mockResolvedValueOnce('denied');
  await n.request(); expect(n.permission()).toBe(outcome === 'error' ? 'error' : 'denied');
  native.isPermissionGranted.mockResolvedValue(true); await n.checkPermission();
  expect(n.permission()).toBe('granted');
  n.message(message, 'me', 'Maya'); await flush();
  expect(native.sendNotification).toHaveBeenCalledOnce(); expect(native.requestPermission).toHaveBeenCalledOnce(); n.dispose();
});
