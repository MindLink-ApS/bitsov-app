import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, onAction, registerActionTypes, sendNotification } from '@tauri-apps/plugin-notification';
import { t } from '../i18n';
import { safeApprovalText } from './ownerApproval';

// Never put request data (even the op id) in the OS payload. IDs are process-local.
let nextNotificationId = 1;
export function createApprovalNotifications(review: (id: string) => void) {
  const window = getCurrentWindow();
  const seen = new Set<string>();
  const requests = new Map<number, string>();
  let pending = new Set<string>();
  let disposed = false;
  let queue = Promise.resolve();
  const live = (id: string) => !disposed && pending.has(id);
  const ready = window.label === 'main' ? onAction(event => {
    const id = event.notification && requests.get(event.notification.id);
    if (!['tap', 'review'].includes(event.actionId) || !id || !live(id)) return;
    void (async () => {
      await window.show();
      await window.unminimize();
      if (!live(id)) return;
      review(id);
      await window.setFocus();
    })().catch(() => { /* The in-app sheet remains available. */ });
  }).catch(() => null) : Promise.resolve(null);

  async function notify(id: string, focusedOnArrival: Promise<boolean>) {
    try {
      if (!live(id) || await focusedOnArrival) return;
      if (!await ready || !live(id)) return;
      // Permission is requested only by the visible notification settings explanation.
      const permitted = await isPermissionGranted();
      if (!permitted || !live(id)) return;
      // The locked macOS backend only waits for body clicks when an action exists.
      await registerActionTypes([{ id: 'bitsov-owner-approval', actions: [{ id: 'review', title: safeApprovalText(t('ownerApprovalReview')) }] }]);
      if (!live(id) || await window.isFocused()) return;
      const notificationId = nextNotificationId++;
      requests.set(notificationId, id);
      // Only static, localized text. No names, amounts, memo, trip codes or signed bytes.
      sendNotification({ id: notificationId, title: safeApprovalText('BitSov'), actionTypeId: 'bitsov-owner-approval', body: safeApprovalText(t('ownerApprovalNotification')) });
    } catch { /* Permission/native failures must never interrupt owner approval. */ }
  }
  return {
    update(ids: string[]) {
      pending = new Set(ids);
      // Keep mappings through transient read failures; live() rejects stale clicks.
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        // Snapshot immediately, before an earlier request can wait on permission.
        // If focus cannot be determined, fail closed to the in-app sheet.
        const focusedOnArrival = window.isFocused().catch(() => true);
        queue = queue.then(() => notify(id, focusedOnArrival));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requests.clear();
      void ready.then(listener => listener?.unregister()).catch(() => {});
    },
  };
}
