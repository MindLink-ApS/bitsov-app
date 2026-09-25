/** Copy plain text. No network and no Tauri command. */
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
  document.execCommand('copy');
  area.remove();
}
