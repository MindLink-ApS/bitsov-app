/** Coordinates are CSS pixels in the layout viewport, including WebKit's focus pan. */
export function keyboardLayout(v: { layoutHeight: number; height: number; offsetTop: number; scale: number }) {
  if (![v.layoutHeight, v.height, v.offsetTop, v.scale].every(Number.isFinite)
    || v.height <= 0 || v.layoutHeight <= 0 || Math.abs(v.scale - 1) > .01) return null;
  const top = Math.max(0, Math.min(v.offsetTop, v.layoutHeight - 1));
  const height = Math.min(v.height, v.layoutHeight - top);
  const bottom = Math.max(0, v.layoutHeight - top - height);
  return { height, top, bottom, keyboard: v.layoutHeight - height > 80 };
}

/** Scroll only the input's inner scroll regions. scrollIntoView can pan the whole WKWebView. */
function revealInput(input: HTMLElement) {
  for (let parent = input.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
    const field = input.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    const top = box.top + 12;
    const bottom = box.bottom - 12;
    // Keep the following primary (and sheet Cancel) alongside the field when
    // they fit. Longer forms remain scrollable; never hide the field to do this.
    const scope = input.closest('form, .first-spend-sheet, .composer-panel');
    const actions = Array.from(scope?.querySelectorAll<HTMLElement>('button[type="submit"], button.primary, [data-first-spend-cancel]') ?? [])
      .filter(el => parent!.contains(el) && (input.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
        && el.getBoundingClientRect().height > 0);
    const actionBottom = actions[actions.length - 1]?.getBoundingClientRect().bottom ?? field.bottom;
    const revealBottom = actionBottom - field.top <= bottom - top ? Math.max(field.bottom, actionBottom) : field.bottom;
    if (revealBottom > bottom) parent.scrollTop += revealBottom - bottom;
    else if (field.top < top) parent.scrollTop -= top - field.top;
  }
}

/** Install once for the iOS shell, covering onboarding and top-layer dialogs too. */
export function installKeyboardViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  let frame = 0;
  const update = () => {
    // WKWebView can report visual height as innerHeight during focus pan.
    // The document client height remains the CSS layout viewport.
    const layout = keyboardLayout({ layoutHeight: root.clientHeight || window.innerHeight, height: viewport.height,
      offsetTop: viewport.offsetTop, scale: viewport.scale });
    if (!layout) return; // A pinch is not a keyboard; do not counteract accessibility zoom.
    root.style.setProperty('--visible-height', `${layout.height}px`);
    root.style.setProperty('--visible-top', `${layout.top}px`);
    root.style.setProperty('--keyboard-inset', `${layout.bottom}px`);
    root.dataset.keyboardOpen = String(layout.keyboard);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !focused.matches('input, textarea, [contenteditable="true"]')) return;
      // Focusing a composer deliberately brings the conversation's last message into view.
      const stream = focused.closest('.composer')?.closest('.track')?.querySelector<HTMLElement>('.stream');
      if (stream) stream.scrollTop = stream.scrollHeight;
      revealInput(focused);
    });
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    for (const name of ['--visible-height', '--visible-top', '--keyboard-inset']) root.style.removeProperty(name);
    delete root.dataset.keyboardOpen;
  };
}
