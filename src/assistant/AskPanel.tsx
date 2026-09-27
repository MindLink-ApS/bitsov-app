import { createSignal, For, Match, onCleanup, onMount, Switch, type JSX } from 'solid-js';
import { UNAVAILABLE, type Answerer } from './ask';
import { questionFor } from './questions';
import type { SitRow } from './rows';
import {
  freshnessText,
  mockReasonText,
  summarize,
  type Freshness,
  type FreshnessState,
  type RouteKey,
  type Source,
} from './source';

type Label = { source: Source['kind']; freshness?: FreshnessState; text: string };

type AskState =
  | { kind: 'empty' }
  | { kind: 'loading'; id: string }
  | { kind: 'answered'; id: string; value: string; label: Label }
  | { kind: 'unavailable'; id: string; why: string; next: string }
  | { kind: 'stopped'; id: string }
  | { kind: 'error'; id: string };

const NOT_SENT: Record<RouteKey, string> = {
  balance: 'its balance',
  channels: 'its channel list',
  health: 'its status',
  messages: 'its messages',
  pricing: 'its prices',
};

const OUT_OF_DATE: Record<RouteKey, string> = {
  balance: 'balance was',
  channels: 'channel list was',
  health: 'status was',
  messages: 'messages were',
  pricing: 'prices were',
};

const RETRY =
  'Nothing was changed on your node. Wait a minute, then close and reopen the assistant. ' +
  'If it is still unavailable, check in the BitSov app that your node is running.';

const NOT_YET = 'The assistant cannot read this from your node yet.';

const NOT_YET_NEXT =
  'Nothing was changed on your node. The other questions in the list still work.';

const ERROR_TEXT =
  'Something went wrong showing this answer. Nothing was changed on your node. ' +
  'Try again, or close and reopen the assistant.';

/**
 * Pick a question, get its answer with where it came from and how old it is.
 * Answers come from the `answerer` (by default the rows the host handed
 * over). Stop never waits on a pending answer.
 */
export function AskPanel(props: {
  rows: readonly SitRow[];
  source: Source;
  freshness: Freshness | null;
  answerer: Answerer;
  openMs: () => number;
}): JSX.Element {
  const [state, setState] = createSignal<AskState>({ kind: 'empty' });
  let picker: HTMLSelectElement | undefined;
  let stopper: HTMLButtonElement | undefined;
  let pending: AbortController | null = null;
  // Bumped on every ask and stop, so a late answer cannot land.
  let turn = 0;

  const loading = () => state().kind === 'loading';
  const answered = () => {
    const current = state();
    return current.kind === 'answered' ? current : undefined;
  };
  const missing = () => {
    const current = state();
    return current.kind === 'unavailable' ? current : undefined;
  };

  const label = (route: RouteKey | null): Label => {
    const source = props.source;
    if (source.kind === 'mock') {
      return { source: 'mock', text: `Mock data, not your node. ${mockReasonText(source.reason)}` };
    }
    const summary = summarize(props.freshness, props.openMs(), route ?? undefined);
    return {
      source: 'live',
      freshness: summary.state,
      text: `Live, from your paired node. ${freshnessText(summary)}`,
    };
  };

  const unavailable = (id: string, route: RouteKey | null): AskState => {
    if (props.source.kind === 'mock') {
      return {
        kind: 'unavailable',
        id,
        why: 'This is sample data, and this sample question has no answer on purpose.',
        next: 'To see your own answers, open the BitSov app and make sure your node is running and paired.',
      };
    }
    if (route === null || props.freshness === null) {
      return { kind: 'unavailable', id, why: NOT_YET, next: NOT_YET_NEXT };
    }
    const read = props.freshness.routes.find((entry) => entry.route === route);
    if (!read || read.state === 'unknown') {
      return {
        kind: 'unavailable',
        id,
        why: `Your node did not send ${NOT_SENT[route]} when this window opened.`,
        next: RETRY,
      };
    }
    if (summarize(props.freshness, props.openMs(), route).state === 'stale') {
      return {
        kind: 'unavailable',
        id,
        why: `Your node’s ${OUT_OF_DATE[route]} out of date, so the assistant will not guess.`,
        next: RETRY,
      };
    }
    return { kind: 'unavailable', id, why: NOT_YET, next: NOT_YET_NEXT };
  };

  const settle = (next: AskState) => {
    pending = null;
    setState(next);
    picker?.focus();
  };

  const ask = () => {
    if (loading() || !picker) return;
    const id = picker.value;
    if (!id) return;
    const mine = ++turn;
    const controller = new AbortController();
    pending = controller;
    setState({ kind: 'loading', id });
    stopper?.focus();
    let answer: Promise<string | null>;
    try {
      answer = props.answerer(id, controller.signal);
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      (value) => {
        if (mine !== turn) return;
        const route = questionFor(id)?.route ?? null;
        if (value === null || value === UNAVAILABLE) {
          settle(unavailable(id, route));
        } else {
          settle({ kind: 'answered', id, value, label: label(route) });
        }
      },
      () => {
        if (mine !== turn) return;
        settle({ kind: 'error', id });
      },
    );
  };

  const stop = () => {
    const current = state();
    if (current.kind !== 'loading') return;
    turn++;
    pending?.abort();
    settle({ kind: 'stopped', id: current.id });
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (loading()) {
      stop();
    } else {
      setState({ kind: 'empty' });
      picker?.focus();
    }
  };

  onMount(() => {
    picker?.focus();
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    turn++;
    pending?.abort();
  });

  const questionText = (id: string) => questionFor(id)?.text ?? id;

  return (
    <section class="ask" aria-label="Ask about your node">
      <div class="ask-row">
        <label class="ask-label" for="ask-question">
          Question
        </label>
        <select
          id="ask-question"
          class="ask-select"
          data-testid="ask-question"
          ref={picker}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              ask();
            }
          }}
        >
          <For each={props.rows}>
            {(row) => <option value={row.id}>{questionText(row.id)}</option>}
          </For>
        </select>
        <div class="ask-actions">
          <button
            type="button"
            class="ask-button"
            data-testid="ask-button"
            disabled={loading()}
            onClick={ask}
          >
            Ask
          </button>
          <button
            type="button"
            class="ask-stop"
            data-testid="ask-stop"
            ref={stopper}
            disabled={!loading()}
            onClick={stop}
          >
            Stop
          </button>
        </div>
      </div>
      <div
        class="ask-answer"
        data-testid="ask-answer"
        data-state={state().kind}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Switch>
          <Match when={state().kind === 'empty'}>
            <p class="ask-hint">
              Pick a question, then press Enter or Ask. Press Escape to stop or clear.
            </p>
          </Match>
          <Match when={state().kind === 'loading'}>
            <p class="ask-hint">Looking up the answer…</p>
          </Match>
          <Match when={state().kind === 'stopped'}>
            <p class="ask-hint">
              Stopped. Nothing was changed on your node. Pick a question to ask again.
            </p>
          </Match>
          <Match when={state().kind === 'error'}>
            <p class="ask-error">{ERROR_TEXT}</p>
          </Match>
          <Match when={answered()}>
            {(answered) => (
              <>
                <p class="ask-question-text" data-testid="answer-question">
                  {questionText(answered().id)}
                </p>
                <p class="ask-value" data-testid="answer-value">
                  {answered().value}
                </p>
                <p
                  class="ask-source"
                  classList={{
                    'ask-source-mock': answered().label.source === 'mock',
                    'ask-source-stale': answered().label.freshness === 'stale',
                  }}
                  data-testid="answer-source"
                  data-source={answered().label.source}
                  data-freshness={answered().label.freshness}
                >
                  {answered().label.text}
                </p>
              </>
            )}
          </Match>
          <Match when={missing()}>
            {(missing) => (
              <>
                <p class="ask-question-text">{questionText(missing().id)}</p>
                <p class="ask-unavailable">No answer for this question right now.</p>
                <p class="ask-why" data-testid="unavailable-why">
                  {missing().why}
                </p>
                <p class="ask-next" data-testid="unavailable-next">
                  {missing().next}
                </p>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </section>
  );
}
