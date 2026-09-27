// UI-E2E in-webview driver. DEV ONLY.
//
// macOS has no WebDriver for WKWebView, so Playwright cannot attach to the real
// Tauri window. This script runs inside that window instead: the dev server
// injects it only when BITSOV_UI_E2E=1 (vite.config.ts `uiE2eDriver`), never in
// `vite build`. It long-polls the dev server for one command at a time from
// scripts/ui-e2e/runner.py and answers with plain DOM results. It calls no
// Tauri command itself: every action is a click or keystroke the owner could
// make, and the app's own code does the rest.
//
// Snapshots serialize the live DOM with its stylesheets and form values so the
// runner can render real screenshots (Playwright Chromium) of what this
// webview showed. Nothing here reads node data directly.

const BASE = '/__e2e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function visible(el) {
  if (!(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function scope(within) {
  if (!within) return document.body;
  const el = find({ ...within });
  if (!el) throw new Error(`scope not found: ${JSON.stringify(within)}`);
  return el;
}

// Find one element by CSS selector and/or visible text (exact, then contains).
function find({ selector, text, exact, within, nth, role }) {
  const root = scope(within);
  const sel = selector ?? (role === 'button' ? 'button, [role=button], a' : role === 'tab' ? '[role=tab], button' : '*');
  let els = [...root.querySelectorAll(sel)].filter(visible);
  if (text !== undefined) {
    const want = norm(text);
    const hit = (el) => {
      const own = norm(el.innerText || el.textContent);
      const label = norm(el.getAttribute('aria-label'));
      return exact ? own === want || label === want : own.includes(want) || label.includes(want);
    };
    els = els.filter(hit);
    // Prefer the innermost match so a click lands on the control, not a wrapper.
    els = els.filter((el) => !els.some((other) => other !== el && el.contains(other)));
  }
  return els[nth ?? 0] ?? null;
}

async function waitFor(q, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const el = find(q);
    if (el) return el;
    if (Date.now() > end) throw new Error(`timeout waiting for ${JSON.stringify(q)}`);
    await sleep(150);
  }
}

function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function snapshot() {
  const clone = document.documentElement.cloneNode(true);
  // Keep what the owner saw: typed values, checked boxes, drawn canvases.
  const live = document.documentElement.querySelectorAll('input, textarea, select, canvas');
  const copies = clone.querySelectorAll('input, textarea, select, canvas');
  live.forEach((el, i) => {
    const copy = copies[i];
    if (!copy) return;
    if (el instanceof HTMLCanvasElement) {
      const img = document.createElement('img');
      try { img.src = el.toDataURL(); } catch { /* tainted canvas: leave blank */ }
      img.width = el.width; img.height = el.height; img.style.cssText = el.style.cssText;
      copy.replaceWith(img);
    } else if (el instanceof HTMLTextAreaElement) {
      copy.textContent = el.value;
    } else if (el instanceof HTMLSelectElement) {
      copy.querySelectorAll('option').forEach((o, j) => { if (j === el.selectedIndex) o.setAttribute('selected', ''); });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) copy.setAttribute('checked', '');
    } else if (el.type !== 'file' && el.type !== 'password') {
      copy.setAttribute('value', el.value);
    }
  });
  clone.querySelectorAll('script').forEach((s) => s.remove());
  let css = '';
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) css += rule.cssText + '\n'; } catch { /* cross-origin */ }
  }
  clone.querySelectorAll('style, link[rel=stylesheet]').forEach((s) => s.remove());
  const style = document.createElement('style');
  style.textContent = css;
  clone.querySelector('head')?.appendChild(style);
  return {
    html: '<!doctype html>\n' + clone.outerHTML,
    width: window.innerWidth,
    height: window.innerHeight,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  };
}

const ops = {
  async ping() { return { href: location.href, title: document.title }; },
  async text({ within }) { return norm(scope(within).innerText); },
  async exists(q) { return !!find(q); },
  async wait(q) { await waitFor(q, q.timeoutMs); return true; },
  async waitGone(q) {
    const end = Date.now() + (q.timeoutMs ?? 15000);
    while (find(q)) { if (Date.now() > end) throw new Error(`still present: ${JSON.stringify(q)}`); await sleep(150); }
    return true;
  },
  async click(q) {
    const el = await waitFor(q, q.timeoutMs);
    if (el.disabled) throw new Error(`disabled: ${JSON.stringify(q)}`);
    el.scrollIntoView({ block: 'center' });
    el.click();
    return norm(el.innerText || el.getAttribute('aria-label'));
  },
  async fill(q) {
    const el = await waitFor(q, q.timeoutMs);
    el.focus();
    setValue(el, q.value);
    return true;
  },
  async submit(q) {
    const el = await waitFor(q, q.timeoutMs);
    const form = el.closest('form') ?? el;
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  },
  async key(q) {
    const el = await waitFor(q, q.timeoutMs);
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: q.key, code: q.key, bubbles: true, cancelable: true, shiftKey: !!q.shift, metaKey: !!q.meta }));
    }
    return true;
  },
  async attach(q) {
    // A file the owner picks: bytes come from the runner, never from disk here.
    const el = await waitFor({ selector: q.selector, timeoutMs: q.timeoutMs });
    const bytes = Uint8Array.from(atob(q.data_b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], q.filename, { type: q.mime }));
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.files.length;
  },
  async attrs({ selector, names }) {
    return [...document.querySelectorAll(selector)].filter(visible).map((el) =>
      Object.fromEntries([['text', norm(el.innerText)], ...names.map((n) => [n, el.getAttribute(n)])]));
  },
  async snapshot() { return snapshot(); },
};

async function loop() {
  const who = `${location.pathname}#${Math.random().toString(16).slice(2, 8)}`;
  for (;;) {
    let cmd;
    try {
      const r = await fetch(`${BASE}/cmd?page=${encodeURIComponent(location.pathname)}&who=${who}`, { method: 'POST' });
      if (r.status !== 200) { await sleep(100); continue; }
      cmd = await r.json();
    } catch {
      await sleep(500);
      continue;
    }
    let result;
    try {
      const fn = ops[cmd.op];
      if (!fn) throw new Error(`unknown op ${cmd.op}`);
      result = { ok: true, value: await fn(cmd.args ?? {}) };
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e) };
    }
    await fetch(`${BASE}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: cmd.id, ...result }),
    }).catch(() => {});
  }
}

loop();
