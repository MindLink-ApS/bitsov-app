import { t as tr } from '../i18n';
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
  get balance() { return tr('caItsBalance'); },
  get channels() { return tr('caItsChannelList'); },
  get health() { return tr('caItsStatus'); },
  get messages() { return tr('caItsMessages'); },
  get pricing() { return tr('caItsPrices'); },
};

const OUT_OF_DATE: Record<RouteKey, string> = {
  get balance() { return tr('caBalanceWas'); },
  get channels() { return tr('caChannelListWas'); },
  get health() { return tr('caStatusWas'); },
  get messages() { return tr('caMessagesWere'); },
  get pricing() { return tr('caPricesWere'); },
};

const RETRY = () => tr('caNothingWasChangedOnYourNodeWaitAMinute') +
  tr('caIfItIsStillUnavailableCheckInTheBitSov');

const NOT_YET = () => tr('caTheAssistantCannotReadThisFromYourNodeYet');

const NOT_YET_NEXT = () => tr('caNothingWasChangedOnYourNodeTheOtherQuestions');

const ERROR_TEXT = () => tr('caSomethingWentWrongShowingThisAnswerNothingWasChanged') +
  tr('caTryAgainOrCloseAndReopenTheAssistant');

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
      return { source: 'mock', text: tr('caSampleDataNotYourNode', mockReasonText(source.reason)) };
    }
    const summary = summarize(props.freshness, props.openMs(), route ?? undefined);
    return {
      source: 'live',
      freshness: summary.state,
      text: tr('caFromYourNode1340', freshnessText(summary)),
    };
  };

  const unavailable = (id: string, route: RouteKey | null): AskState => {
    if (props.source.kind === 'mock') {
      return {
        kind: 'unavailable',
        id,
        why: tr('caThisIsSampleDataAndThisSampleQuestionHas'),
        next: tr('caToSeeYourOwnAnswersOpenTheBitSovApp'),
      };
    }
    if (route === null || props.freshness === null) {
      return { kind: 'unavailable', id, why: NOT_YET(), next: NOT_YET_NEXT() };
    }
    const read = props.freshness.routes.find((entry) => entry.route === route);
    if (!read || read.state === 'unknown') {
      return {
        kind: 'unavailable',
        id,
        why: tr('caYourNodeDidNotSendWhenThisWindowOpened', NOT_SENT[route]),
        next: RETRY(),
      };
    }
    if (summarize(props.freshness, props.openMs(), route).state === 'stale') {
      return {
        kind: 'unavailable',
        id,
        why: tr('caYourNodeSOutOfDateSoTheAssistant', OUT_OF_DATE[route]),
        next: RETRY(),
      };
    }
    return { kind: 'unavailable', id, why: NOT_YET(), next: NOT_YET_NEXT() };
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
    <section class="ask" aria-label={tr('caAskAboutYourNode')}>
      <div class="ask-row">
        <label class="ask-label" for="ask-question">
          {tr('caQuestion')}</label>
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
            {tr('caAsk')}</button>
          <button
            type="button"
            class="ask-stop"
            data-testid="ask-stop"
            ref={stopper}
            disabled={!loading()}
            onClick={stop}
          >
            {tr('caStop')}</button>
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
              {tr('caPickAQuestionThenPressEnterOrAskPress')}</p>
          </Match>
          <Match when={state().kind === 'loading'}>
            <p class="ask-hint">{tr('caLookingUpTheAnswer')}</p>
          </Match>
          <Match when={state().kind === 'stopped'}>
            <p class="ask-hint">
              {tr('caStoppedNothingWasChangedOnYourNodePickA')}</p>
          </Match>
          <Match when={state().kind === 'error'}>
            <p class="ask-error">{ERROR_TEXT()}</p>
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
                <p class="ask-unavailable">{tr('caNoAnswerForThisQuestionRightNow')}</p>
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
