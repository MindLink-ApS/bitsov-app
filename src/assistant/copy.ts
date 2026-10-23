import { t as tr } from '../i18n';
/**
 * Copy plain text. No network and no Tauri command. Rejects when neither the
 * clipboard API nor the fallback copied anything, so a caller never says
 * "Copied" over a clipboard that still holds something else (an old address).
 */
export async function copyPlainText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // The webview can expose clipboard and still refuse the write.
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.className = 'assistant-copy-sink';
  area.setAttribute('aria-hidden', 'true');
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  if (!ok) throw new Error(tr('caCopyDidNotWorkHereSelectTheTextAnd'));
}
