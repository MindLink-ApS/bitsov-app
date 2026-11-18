/**
 * Make everything outside a modal inert without taking `inert` away from
 * anyone else. Settings, Wallet, the first-spend sheet and the phone sheets
 * bind `inert` on some of the same elements. While the modal is open this
 * remembers what those other owners last asked for (watching their writes),
 * keeps the element inert either way, and on close puts back exactly what they
 * want now. It never restores a snapshot from open time.
 */

/** Live regions keep announcing behind a modal, so the region itself is never made inert. */
const LIVE = '[aria-live], [role="status"], [role="alert"]';
/** Anything a keyboard or screen reader could act on. Inside a live region these are made inert one by one. */
const CONTROLS =
  'a[href], area[href], button, input, select, textarea, iframe, summary, details, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/**
 * `keep` matches siblings that stay fully usable (call panels, the waiting-calls
 * stack, the modal's own scrim). Returns the function that ends the hold.
 */
export function inertOutside(modal: HTMLElement, keep: string): () => void {
  // What other code wants for each element we hold, updated whenever it writes `inert`.
  const wanted = new Map<Element, boolean>();
  const observer = new MutationObserver((records) => handle(records));

  const write = (el: Element, on: boolean) => {
    handle(observer.takeRecords());
    if (el.hasAttribute('inert') === on) return;
    el.toggleAttribute('inert', on);
    observer.takeRecords(); // our own write, not another owner's
  };

  const hold = (el: Element) => {
    if (wanted.has(el)) return;
    wanted.set(el, el.hasAttribute('inert'));
    observer.observe(el, { attributes: true, attributeFilter: ['inert'] });
    write(el, true);
  };

  const holdControls = (root: Element) => {
    if (root.matches(CONTROLS)) hold(root);
    for (const el of Array.from(root.querySelectorAll(CONTROLS))) hold(el);
  };

  function handle(records: MutationRecord[]) {
    for (const r of records) {
      if (r.type === 'attributes' && wanted.has(r.target as Element)) {
        const el = r.target as Element;
        // Another owner wrote `inert`: remember its wish, but the modal still needs it now.
        wanted.set(el, el.hasAttribute('inert'));
        if (!el.hasAttribute('inert')) {
          el.toggleAttribute('inert', true);
          observer.takeRecords();
        }
      } else if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) if (n instanceof Element) holdControls(n);
      }
    }
  }

  for (let node: Element = modal; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.matches(keep)) continue;
      if (sibling.matches(LIVE)) {
        // Only the announcement stays live: its controls, now and later, are out of reach.
        holdControls(sibling);
        observer.observe(sibling, { childList: true, subtree: true });
      } else {
        hold(sibling);
      }
    }
  }

  return () => {
    handle(observer.takeRecords());
    observer.disconnect();
    for (const [el, on] of wanted) if (el.hasAttribute('inert') !== on) el.toggleAttribute('inert', on);
    wanted.clear();
  };
}
