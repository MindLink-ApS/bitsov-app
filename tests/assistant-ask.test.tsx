import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AssistantPage } from '../src/assistant/Page';
import { rowsAnswerer, type Answerer } from '../src/assistant/ask';
import { QUESTIONS, questionFor } from '../src/assistant/questions';
import { NO_ROWS_TEXT, type SitRow } from '../src/assistant/rows';
import type { Freshness, Source, View } from '../src/assistant/source';

const LIVE: Source = { kind: 'live' };

const ROWS: SitRow[] = [
  { id: 'q01', answer: '500000' },
  { id: 'q02', answer: '52500000' },
  { id: 'q26', answer: 'Unavailable' },
  { id: 'q34', answer: 'Unavailable' },
  { id: 'q32', answer: 'Unavailable' },
];

function route(
  name: Freshness['routes'][number]['route'],
  state: 'fresh' | 'stale' | 'unknown',
  ageMs: number | null,
): Freshness['routes'][number] {
  const staleAfterMs = name === 'balance' || name === 'channels' ? 180_000 : 60_000;
  return { route: name, state, ageMs, clockSkew: false, staleAfterMs };
}

const FRESHNESS: Freshness = {
  routes: [
    route('balance', 'fresh', 90_000),
    route('channels', 'unknown', null),
    route('health', 'fresh', 4_000),
    route('messages', 'fresh', 4_000),
    route('pricing', 'stale', 4_000),
  ],
};

/** An answer that never arrives: a read that hangs. */
function hanging(): { answerer: Answerer; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    answerer: (_id, signal) => {
      signals.push(signal);
      return new Promise<string | null>(() => {});
    },
  };
}

/** An answer released by the test. */
function deferred(): { answerer: Answerer; release: (value: string | null) => void } {
  let release: (value: string | null) => void = () => {};
  return {
    release: (value) => release(value),
    answerer: () =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
  };
}

describe('question list', () => {
  it('has plain-language text and a route for every fixture question the window can show', () => {
    expect(QUESTIONS).toHaveLength(50);
    for (const question of QUESTIONS) {
      expect(question.text.length).toBeGreaterThan(10);
      expect(question.text.endsWith('?')).toBe(true);
    }
    expect(questionFor('q01')?.route).toBe('channels');
    expect(questionFor('q02')?.route).toBe('balance');
    expect(questionFor('q09')?.route).toBe('health');
    expect(questionFor('q20')?.route).toBe('messages');
    expect(questionFor('q26')?.route).toBe('pricing');
    expect(questionFor('q31')?.route).toBe('pricing');
    expect(questionFor('q32')?.route).toBeNull();
    expect(questionFor('q99')).toBeUndefined();
  });

  it('answers from the host rows, and not for a question it does not have', async () => {
    const answer = rowsAnswerer(ROWS);
    const signal = new AbortController().signal;
    await expect(answer('q01', signal)).resolves.toBe('500000');
    await expect(answer('q50', signal)).resolves.toBeNull();
  });
});

describe('assistant window', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement | undefined;

  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled')));
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    mount = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function show(view: Partial<View>, answerer?: Answerer): HTMLElement {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    const full: View = { source: LIVE, rows: ROWS, freshness: FRESHNESS, ...view };
    dispose = render(
      () => <AssistantPage view={full} answerer={answerer} now={() => 0} />,
      mount,
    );
    return mount;
  }

  const $ = <T extends HTMLElement>(root: HTMLElement, id: string) =>
    root.querySelector<T>(`[data-testid="${id}"]`) as T;
  const answer = (root: HTMLElement) => $(root, 'ask-answer');
  const select = (root: HTMLElement) => $<HTMLSelectElement>(root, 'ask-question');
  const askButton = (root: HTMLElement) => $<HTMLButtonElement>(root, 'ask-button');
  const stopButton = (root: HTMLElement) => $<HTMLButtonElement>(root, 'ask-stop');

  function key(target: HTMLElement, name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('opens in a clear empty state with focus on the question', () => {
    const root = show({});
    expect(answer(root).dataset.state).toBe('empty');
    expect(answer(root).textContent).toContain('Pick a question');
    expect(document.activeElement).toBe(select(root));
    expect(stopButton(root).disabled).toBe(true);
    expect(askButton(root).disabled).toBe(false);
    // Only the questions the host handed rows for.
    expect([...select(root).options].map((o) => o.value)).toEqual(ROWS.map((r) => r.id));
    expect(select(root).options[0].textContent).toBe(questionFor('q01')?.text);
    expect(root.querySelector('label[for="ask-question"]')?.textContent).toBe('Question');
  });

  it('announces answers politely and not the ticking header', () => {
    const root = show({});
    const region = answer(root);
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect($(root, 'source-freshness').closest('[aria-live]')).toBeNull();
  });

  it('shows the answer with its own route freshness, then returns focus to the question', async () => {
    const root = show({});
    select(root).value = 'q02';
    key(select(root), 'Enter');
    await settle();
    const region = answer(root);
    expect(region.dataset.state).toBe('answered');
    expect($(root, 'answer-value').textContent).toBe('52500000');
    expect($(root, 'answer-question').textContent).toBe(questionFor('q02')?.text);
    const label = $(root, 'answer-source');
    expect(label.dataset.source).toBe('live');
    // Balance is 90 s old: fresh under its 180 s bound, though the header
    // (pricing stale) says stale.
    expect(label.dataset.freshness).toBe('fresh');
    expect(label.textContent).toBe('From your node. Updated 1 min ago.');
    expect($(root, 'source-freshness').dataset.freshness).toBe('stale');
    expect(document.activeElement).toBe(select(root));
  });

  it('labels an answer from a stale route as stale', async () => {
    const root = show({ rows: [{ id: 'q30', answer: '1000' }] });
    askButton(root).click();
    await settle();
    const label = $(root, 'answer-source');
    expect(label.dataset.freshness).toBe('stale');
    expect(label.textContent).toBe(
      'From your node. Stale: updated 4 s ago. Reopen to refresh.',
    );
  });

  it('labels a mock answer as mock with no freshness claim', async () => {
    const root = show({ source: { kind: 'mock', reason: 'not_paired' }, freshness: null });
    askButton(root).click();
    await settle();
    const label = $(root, 'answer-source');
    expect(label.dataset.source).toBe('mock');
    expect(label.dataset.freshness).toBeUndefined();
    expect(label.textContent).toBe('Sample data, not your node. Not paired with a node.');
  });

  it('explains an unavailable answer in plain language: why, and what to do', async () => {
    const root = show({});
    // q34 reads channels; the channels read failed (unknown).
    select(root).value = 'q34';
    askButton(root).click();
    await settle();
    const region = answer(root);
    expect(region.dataset.state).toBe('unavailable');
    expect(region.textContent).toContain('No answer for this question right now.');
    expect($(root, 'unavailable-why').textContent).toBe(
      'Your node did not send its channel list when this window opened.',
    );
    expect($(root, 'unavailable-next').textContent).toBe(
      'Nothing was changed on your node. Wait a minute, then close and reopen the assistant. If it is still unavailable, check in the BitSov app that your node is running.',
    );
    expect(region.textContent).not.toMatch(/\bnull\b|undefined|route|503|http/i);

    // q26 reads pricing; pricing came back stale.
    select(root).value = 'q26';
    askButton(root).click();
    await settle();
    expect($(root, 'unavailable-why').textContent).toBe(
      'Your node’s prices were out of date, so the assistant will not guess.',
    );

    // q32 is a question the assistant cannot read yet.
    select(root).value = 'q32';
    askButton(root).click();
    await settle();
    expect($(root, 'unavailable-why').textContent).toBe(
      'The assistant cannot read this from your node yet.',
    );
  });

  it('explains an unavailable mock answer without blaming the node', async () => {
    const root = show({
      source: { kind: 'mock', reason: 'node_unreachable' },
      freshness: null,
      rows: [{ id: 'q34', answer: 'Unavailable' }],
    });
    askButton(root).click();
    await settle();
    expect($(root, 'unavailable-why').textContent).toBe(
      'This is sample data, and this sample question has no answer on purpose.',
    );
    expect($(root, 'unavailable-next').textContent).toBe(
      'To see your own answers, open the BitSov app and make sure your node is running and paired.',
    );
  });

  it('shows loading, moves focus to Stop, and Stop works while the read hangs', async () => {
    const pending = hanging();
    const root = show({}, pending.answerer);
    askButton(root).click();
    expect(answer(root).dataset.state).toBe('loading');
    expect(answer(root).textContent).toBe('Looking up the answer…');
    expect(stopButton(root).disabled).toBe(false);
    expect(askButton(root).disabled).toBe(true);
    expect(document.activeElement).toBe(stopButton(root));

    // No await: Stop must not wait on the pending read.
    stopButton(root).click();
    expect(answer(root).dataset.state).toBe('stopped');
    expect(answer(root).textContent).toContain('Stopped.');
    expect(pending.signals[0].aborted).toBe(true);
    expect(stopButton(root).disabled).toBe(true);
    expect(document.activeElement).toBe(select(root));
  });

  it('Escape stops an answer in progress', () => {
    const pending = hanging();
    const root = show({}, pending.answerer);
    key(select(root), 'Enter');
    expect(answer(root).dataset.state).toBe('loading');
    const event = key(stopButton(root), 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(answer(root).dataset.state).toBe('stopped');
    expect(pending.signals[0].aborted).toBe(true);
    expect(document.activeElement).toBe(select(root));
  });

  it('a late answer after Stop does not replace the stopped state', async () => {
    const late = deferred();
    const root = show({}, late.answerer);
    askButton(root).click();
    stopButton(root).click();
    late.release('999');
    await settle();
    expect(answer(root).dataset.state).toBe('stopped');
    expect(root.querySelector('[data-testid="answer-value"]')).toBeNull();
  });

  it('asking again while loading is ignored; Escape when idle clears the answer', async () => {
    const pending = hanging();
    const root = show({}, pending.answerer);
    key(select(root), 'Enter');
    key(select(root), 'Enter');
    askButton(root).click();
    expect(pending.signals).toHaveLength(1);
    stopButton(root).click();

    key(select(root), 'Escape');
    expect(answer(root).dataset.state).toBe('empty');
    expect(document.activeElement).toBe(select(root));
  });

  it('shows a plain error if the answer fails, and focus returns', async () => {
    const root = show({}, () => Promise.reject(new Error('CANARY-ask-err')));
    askButton(root).click();
    await settle();
    expect(answer(root).dataset.state).toBe('error');
    expect(answer(root).textContent).toBe(
      'Something went wrong showing this answer. Nothing was changed on your node. Try again, or close and reopen the assistant.',
    );
    expect(root.textContent).not.toContain('CANARY');
    expect(document.activeElement).toBe(select(root));
  });

  it('with no rows shows one clear empty state and no question controls', () => {
    const root = show({ rows: [], source: { kind: 'mock', reason: 'unknown' }, freshness: null });
    expect(root.querySelector('[data-testid="ask-question"]')).toBeNull();
    expect($(root, 'model-output').textContent).toBe(NO_ROWS_TEXT);
    expect(NO_ROWS_TEXT).toMatch(/close this window and open the assistant again/i);
  });

  it('adds no new way to reach the host: no invoke, no network', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(null);
      },
    });
    const network: unknown[] = [];
    vi.stubGlobal('fetch', (input: unknown) => {
      network.push(input);
      return Promise.reject(new Error('network disabled'));
    });
    const root = show({});
    for (const id of ROWS.map((r) => r.id)) {
      select(root).value = id;
      askButton(root).click();
      await settle();
    }
    expect(calls).toEqual([]);
    expect(network).toEqual([]);
  });
});
