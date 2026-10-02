import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import type { NodeStatus, PairingView } from '../src/onboarding/pairing';
import { questionFor } from '../src/assistant/questions';

// First run → onboarding → pairing → the assistant's first answer with a
// freshness label, window side, on mock data. The main window runs against
// stubbed host commands (the #77 pairing views F1's host reports). The
// assistant window then gets the exact init script the Rust host writes for a
// paired, live feed: `tests/fixtures/assistant-live-init.js`, kept equal to
// `Feed::init_script_at` by `the_live_init_script_matches_the_window_golden`
// in src-tauri/src/jarvis/assistant_feed.rs. The host half (pairing over a
// loopback port, then reading with the paired token) is
// src-tauri/tests/onboarding_assistant.rs. No Tauri, no node, no network.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BASE: PairingView = {
  state: 'starting',
  scopes: [],
  short_code: null,
  code_from_node: false,
  reason: null,
  remote: false, bootstrap: null,
};

/** What the host reports on each 1.5 s poll of a first run. */
const FIRST_RUN: { status: NodeStatus; pairing: PairingView }[] = [
  { status: { ready: false, node_id: null, error: null }, pairing: BASE },
  { status: { ready: true, node_id: 'mock-node', error: null }, pairing: { ...BASE, state: 'pending' } },
  {
    status: { ready: true, node_id: 'mock-node', error: null },
    pairing: {
      ...BASE,
      state: 'paired',
      scopes: ['read', 'receive'],
      short_code: 'ABCD-EFGH',
      code_from_node: true,
    },
  },
];

function steps(root: HTMLElement): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  root.querySelectorAll<HTMLElement>('[data-step]').forEach((step) => {
    out[step.dataset.step as string] = step.dataset.status;
  });
  return out;
}

describe('first run to the first assistant answer (mock)', () => {
  const disposers: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('onboards, pairs, then answers live with a freshness label', async () => {
    // --- main window: first run and pairing ---
    vi.useFakeTimers();
    let poll = 0;
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (cmd: string) => {
        calls.push(cmd);
        const step = FIRST_RUN[Math.min(poll, FIRST_RUN.length - 1)];
        if (cmd === 'node_status') return Promise.resolve(step.status);
        if (cmd === 'pairing_status') {
          poll += 1;
          return Promise.resolve(step.pairing);
        }
        if (cmd === 'device_key_status') {
          return Promise.resolve({
            available: false,
            state: 'none',
            fingerprint: null,
            owner_action: null,
            expires_at_ms: null,
          });
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled')));

    const shell = document.createElement('div');
    document.body.appendChild(shell);
    disposers.push(render(() => <App />, shell));

    await vi.advanceTimersByTimeAsync(0);
    expect(steps(shell)).toEqual({ node: 'active', pair: 'todo', identity: 'todo', fund: 'todo' });

    await vi.advanceTimersByTimeAsync(1500);
    expect(steps(shell).node).toBe('done');
    expect(steps(shell).pair).toBe('active');
    expect(shell.querySelector('[data-pairing="pending"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1500);
    expect(steps(shell).pair).toBe('done');
    const paired = shell.querySelector('[data-pairing="paired"]');
    expect(paired?.textContent).toContain('read + receive');
    expect(paired?.textContent).toContain('ABCD-EFGH');
    expect(new Set(calls)).toEqual(new Set(['node_status', 'pairing_status', 'device_key_status']));
    vi.useRealTimers();

    // --- assistant window: the host's live init script for that pairing ---
    const assistantCalls: unknown[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (...args: unknown[]) => {
        assistantCalls.push(args);
        return Promise.resolve(null);
      },
    });
    const script = readFileSync(resolve(rootDir, 'tests/fixtures/assistant-live-init.js'), 'utf8');
    new Function(script)();

    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    vi.resetModules();
    await import('../src/assistant/main');

    const label = root.querySelector<HTMLElement>('[data-testid="source-label"]');
    expect(label?.dataset.source).toBe('live');
    expect(label?.textContent).toContain('From your node');
    // Oldest route is the balance as-of (92 s): fresh under its 180 s bound.
    const header = root.querySelector<HTMLElement>('[data-testid="source-freshness"]');
    expect(header?.dataset.freshness).toBe('fresh');
    expect(header?.textContent).toBe('Updated 1 min ago.');

    // Focus starts on the question; Enter asks the first one.
    const select = root.querySelector<HTMLSelectElement>('[data-testid="ask-question"]');
    expect(document.activeElement).toBe(select);
    expect(select?.value).toBe('q01');
    select?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="ask-answer"]')?.getAttribute('data-state')).toBe(
        'answered',
      );
    });
    expect(root.querySelector('[data-testid="answer-question"]')?.textContent).toBe(
      questionFor('q01')?.text,
    );
    expect(root.querySelector('[data-testid="answer-value"]')?.textContent).toBe('500000');
    const source = root.querySelector<HTMLElement>('[data-testid="answer-source"]');
    expect(source?.dataset.source).toBe('live');
    expect(source?.dataset.freshness).toBe('fresh');
    // q01 reads channels, read 12 s before the script was written.
    expect(source?.textContent).toBe('From your node. Updated 12 s ago.');
    expect(document.activeElement).toBe(select);

    expect(assistantCalls).toEqual([]);
  });
});
