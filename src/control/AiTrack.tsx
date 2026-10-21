import { WATCHES, type WatchNotice, type WatchRule, type WatchUpdate } from './watches';
import { ASSISTANTS, modelProposalText, type ModelProposal, type LocalTurn, type AssistantId, type AssistantThread } from './assistants';
import { SoftError } from './SoftError';
import { DelayedSpinner } from './DelayedSpinner';
// "Ask your node": the AI track in the main window.
//
// The app is the broker. A question becomes a topic; the host reads it through
// its closed read broker and hands back the allowlisted projection with its
// freshness. On this computer (the default) the answer is composed here and
// nothing leaves. A remote model, when this computer's settings turn one on,
// gets only the body shown in the preview, and only after the owner presses
// Send for that one question. Proposed actions only prefill a composer.

import { createEffect, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { copyPlainText } from '../assistant/copy';
import { EndpointBadge } from '../assistant/EndpointBadge';
import { OWN_RULES, endpointBadge, widestExposure, type Exposure } from '../assistant/endpoint';
import {
  answerFrom,
  cardText,
  noPeerText,
  noReadText,
  PRESETS,
  proposalText,
  sourceLine,
  SUGGESTIONS,
  understand,
  unknownText,
  value,
  type Answer,
  type Card,
  type Intent,
  type Proposal,
} from './ai';
import { amount, clock, day, satsWhole, uptime } from './format';
import { deviceWord } from '../platform';

/** The host names its local provider "On this computer"; a phone build says "On this phone". */
const providerLabel = (p: { kind: string; label: string }) =>
  p.kind === 'local' && p.label === 'On this computer' ? `On this ${deviceWord()}` : p.label;
import type { Source } from './source';
import { asActionError, peerName } from './state';
import type {
  AiFreshness,
  AiTopic,
  Amount,
  Disclosure,
  LocalStatus,
  NoRead,
  Peer,
  Preset,
  ProviderKind,
  ProviderView,
  RemoteAnswer,
} from './types';

type Turn = {
  id: number;
  saved?: boolean;
  at: number;
  question: string;
  provider: ProviderKind;
  state: 'reading' | 'answered' | 'no-read' | 'error' | 'preview' | 'sending' | 'sent' | 'not-sent';
  answer?: Answer;
  source?: { routes: string[]; freshness: AiFreshness; receivedAt: number };
  proposal?: Proposal;
  modelTurn?: LocalTurn;
  noRead?: NoRead;
  error?: string;
  // remote
  topic?: AiTopic;
  sinceMs?: number | null;
  window?: string | null;
  disclosure?: Disclosure;
  remote?: RemoteAnswer;
};

/** The track's conversation. Lives in the shell so it survives switching tracks. */
export type AiSession = {
  turns: Turn[];
  provider: ProviderKind;
  providers: ProviderView[] | null;
};

export function createAiSession() {
  return createStore<AiSession>({ turns: [], provider: 'local', providers: null });
}

let turnSeq = 0;

export function AiTrack(props: {
  source: Source;
  assistant?: AssistantId;
  watchUpdate?: WatchUpdate;
  watchError?: string | null;
  session: ReturnType<typeof createAiSession>;
  peers: Peer[];
  now: number;
  onPrefill: (p: Proposal) => void;
  onContext: () => void;
  head: (title: string, sub: JSX.Element) => JSX.Element;
}) {
  const [session, setSession] = props.session;
  const [draft, setDraft] = createSignal('');
  const [draftText, setDraftText] = createSignal('');
  const [showExtras, setShowExtras] = createSignal(false);
  const [localStatus, setLocalStatus] = createSignal<LocalStatus | null>(null);
  const [localBusy, setLocalBusy] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [portDraft, setPortDraft] = createSignal('');
  let stream: HTMLDivElement | undefined;
  const assistant = props.assistant ? ASSISTANTS[props.assistant] : null;
  const suggestions = assistant?.suggestions ?? SUGGESTIONS;
  const [threadReady, setThreadReady] = createSignal(!assistant);
  const [threadBusy, setThreadBusy] = createSignal(!!assistant);
  const [threadError, setThreadError] = createSignal<string | null>(null);
  let revision = '';
  const [watchNotices, setWatchNotices] = createSignal<WatchNotice[]>([]);
  const [disabledWatches, setDisabledWatches] = createSignal<WatchRule[]>([]);
  let closed = false;
  const restore = (thread: AssistantThread) => {
    revision = thread.revision;
    setWatchNotices(thread.notices ?? []);
    setDisabledWatches(thread.disabled_watches ?? []);
    setSession('turns', thread.turns.map(t => ({ id: turnSeq++, at: t.at, question: t.question,
      state: 'answered' as const, provider: 'local' as const, saved: true,
      answer: { text: t.answer, cards: [] } })));
    setThreadReady(true);
  };
  createEffect(() => {
    const update = props.watchUpdate;
    if (threadReady() && update?.revision === revision && update.notices) {
      setWatchNotices(old => {
        const merged = new Map(old.map(n => [`${n.at}:${n.rule}`, n]));
        for (const n of update.notices!) merged.set(`${n.at}:${n.rule}`, n);
        return [...merged.values()].sort((a, b) => a.at - b.at).slice(-100);
      });
    }
  });
  const setWatch = async (rule: WatchRule, enabled: boolean) => {
    if (!props.assistant || threadBusy()) return;
    setThreadBusy(true);
    try {
      const thread = await props.source.aiThread(props.assistant, { action: 'set_watch', rule, enabled });
      if (!closed) { setDisabledWatches(thread.disabled_watches ?? []); setThreadError(null); }
    } catch (e) { if (!closed) setThreadError(asActionError(e).message); }
    finally { if (!closed) setThreadBusy(false); }
  };
  if (props.assistant) {
    void props.source.aiThread(props.assistant, { action: 'load' })
      .then(thread => { if (!closed) restore(thread); })
      .catch(e => { if (!closed) setThreadError(asActionError(e).message); })
      .finally(() => setThreadBusy(false));
  }
  const persistTurn = async (id: number) => {
    if (!props.assistant) return;
    const t = session.turns.find(t => t.id === id);
    if (!t || t.saved || ['reading', 'preview', 'sending'].includes(t.state)) return;
    const answer = t.modelTurn?.output.kind === 'proposal' ? modelProposalText(t.modelTurn.output.proposal) : t.remote?.text ?? (t.answer
      ? [t.answer.text, ...t.answer.cards.map(c => cardText(c, nameOf))].join('\n')
      : t.noRead ? noReadText(t.noRead) : t.error ?? 'Nothing was sent.');
    setThreadBusy(true);
    try {
      const thread = await props.source.aiThread(props.assistant, { action: 'append', revision,
        turn: { at: t.at, question: t.question.slice(0, 500), answer: Array.from(answer).slice(0, 16_000).join('') } });
      revision = thread.revision;
    } catch (e) {
      setThreadError(`This answer was not saved. ${asActionError(e).message}`);
      setThreadReady(false);
    } finally { setThreadBusy(false); }
  };
  const forget = async () => {
    if (!props.assistant || threadBusy()) return;
    setThreadBusy(true);
    try {
      await Promise.all(session.turns.filter(t => t.state === 'preview' && t.disclosure)
        .map(t => props.source.aiCancel(t.disclosure!.id)));
      const thread = await props.source.aiThread(props.assistant, { action: 'forget' });
      restore(thread);
      setDraft('');
      setThreadError(null);
    } catch (e) { setThreadError(asActionError(e).message); }
    finally { setThreadBusy(false); }
  };

  const refreshLocal = (port?: number | null) => {
    setLocalBusy(true);
    setLocalError(null);
    return props.source
      .aiLocalStatus(port ?? null)
      .then(async (status) => {
        setLocalStatus(status);
        if (status.selected_port) setPortDraft(String(status.selected_port));
        else if (status.port) setPortDraft(String(status.port));
        // N2: re-read providers so Own badges as rules when the server is down.
        try {
          const list = await props.source.aiProviders();
          setSession('providers', list);
        } catch {
          /* keep last providers list */
        }
      })
      .catch((e) => setLocalError(asActionError(e).message))
      .finally(() => setLocalBusy(false));
  };

  if (session.providers === null) {
    props.source
      .aiProviders()
      .then((list) => setSession('providers', list))
      .catch(() => setSession('providers', [OWN_RULES]));
    void refreshLocal();
  }

  const nameOf = (id: string) => peerName(props.peers.find((p) => p.node_id.toLowerCase() === id.toLowerCase()), id);
  const provider = () => session.providers?.find((p) => p.kind === session.provider) ?? null;
  /** Turns whose preview is on screen or being sent: bytes held for a remote. */
  const pending = () => session.turns.filter((t) => t.disclosure && (t.state === 'preview' || t.state === 'sending'));
  /** The provider a pending turn's disclosure goes to, as the host described it. */
  const viewOf = (t: Turn): ProviderView => {
    const d = t.disclosure!;
    const listed = session.providers?.find((p) => p.kind === d.provider);
    return (
      listed ?? {
        kind: d.provider,
        label: d.label,
        enabled: true,
        host: d.host,
        model: d.model,
        note: null,
        pays: { to: d.key_env ? d.host : null, rail: d.key_env ? 'fiat' : 'none' },
        data_leaves: d.preset,
      }
    );
  };
  /**
   * The header badge: the widest exposure of the selection and every preview
   * still waiting for Send, so it can never say less than what could leave.
   * Until the provider list loads, the selection is Own.
   */
  const exposure = () => {
    const candidates: Exposure[] = [{ provider: provider() ?? OWN_RULES, previewed: null }];
    for (const t of pending()) candidates.push({ provider: viewOf(t), previewed: t.disclosure!.preset });
    return widestExposure(candidates);
  };
  const remote = () => session.provider !== 'local';
  /** Named Own assistants use the host loop; original Ask keeps disclose/send. */
  const ownModel = () => session.provider === 'local' && !!provider()?.model;
  const needsDisclose = () => remote() || (!assistant && ownModel());
  const busy = () => session.turns.some((t) => t.state === 'reading' || t.state === 'sending') || localBusy() || threadBusy() || !threadReady();
  /** Who answers is fixed while a preview waits for Send: Send or Don't send it first. */
  const locked = () => busy() || pending().length > 0;

  const pickModel = async (model: string) => {
    const port = Number.parseInt(portDraft(), 10);
    setLocalBusy(true);
    setLocalError(null);
    try {
      const list = await props.source.aiLocalSelect(model, Number.isFinite(port) && port > 0 ? port : null);
      setSession('providers', list);
      setSession('provider', 'local');
      await refreshLocal(Number.isFinite(port) && port > 0 ? port : null);
    } catch (e) {
      setLocalError(asActionError(e).message);
    } finally {
      setLocalBusy(false);
    }
  };

  const clearModel = async () => {
    setLocalBusy(true);
    setLocalError(null);
    try {
      const list = await props.source.aiLocalClear();
      setSession('providers', list);
      await refreshLocal();
    } catch (e) {
      setLocalError(asActionError(e).message);
    } finally {
      setLocalBusy(false);
    }
  };

  const update = (id: number, change: Partial<Turn>) =>
    setSession('turns', (t) => t.id === id, produce((t) => Object.assign(t, change)));
  const scroll = () => queueMicrotask(() => stream?.scrollTo?.({ top: stream.scrollHeight }));

  // A preview left on screen is dropped host-side when the track closes.
  onCleanup(() => {
    closed = true;
    for (const t of session.turns) {
      if (t.state !== 'preview' || !t.disclosure) continue;
      void props.source.aiCancel(t.disclosure.id).catch(() => {});
      // The shell keeps this session when switching tracks. Its restored view
      // must not offer Send for a disclosure that was just canceled.
      update(t.id, { state: 'not-sent' });
    }
  });

  const disclose = async (id: number, preset: Preset) => {
    const t = session.turns.find((x) => x.id === id);
    if (!t || !t.topic) return;
    if (t.disclosure) void props.source.aiCancel(t.disclosure.id).catch(() => {});
    update(id, { state: 'reading', disclosure: undefined, error: undefined });
    try {
      const d = await props.source.aiDisclose(t.provider, t.topic, t.sinceMs ?? null, preset, t.question, props.assistant);
      if (closed) {
        await props.source.aiCancel(d.id);
        update(id, { state: 'not-sent' });
      } else update(id, { state: 'preview', disclosure: d });
    } catch (e) {
      update(id, { state: 'error', error: asActionError(e).message });
    }
    scroll();
  };

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy() || (assistant && pending().length > 0)) return;
    setDraft('');
    const id = turnSeq++;
    const now = Date.now();
    const intent: Intent = understand(question, props.peers, now, { draft_text: draftText() });
    const base: Turn = { id, at: now, question, provider: session.provider, state: 'reading' };
    setSession('turns', (list) => [...list, base]);
    scroll();

    try {
      if (props.assistant && ownModel()) {
        try {
          const result = await props.source.aiLocalTurn(props.assistant, question, draftText());
          update(id, { state: 'answered', modelTurn: result, answer: {
            text: result.output.kind === 'answer' ? result.output.text : 'Draft only — nothing was sent or changed.',
            cards: result.reads.flatMap(read => read.state === 'live'
              ? answerFrom(read, { kind: 'read', topic: read.topic, sinceMs: null, window: null }, nameOf).cards : []),
          } });
        } catch (e) { update(id, { state: 'error', error: asActionError(e).message }); }
        return scroll();
      }
      if (assistant && (intent.kind === 'act' || intent.kind === 'no-peer')) {
        update(id, { state: 'answered', answer: { text: 'This assistant is read-only. It cannot send, spend or prepare drafts.', cards: [] } });
        return scroll();
      }
      if (intent.kind === 'act') {
        setDraftText('');
        update(id, { state: 'answered', provider: 'local', proposal: intent.proposal, answer: { text: proposalText(intent.proposal), cards: [] } });
        return scroll();
      }
      if (intent.kind === 'no-peer' || intent.kind === 'unknown') {
        const text = assistant ? `${assistant.role} This assistant is read-only. Try one of the suggestions.`
          : intent.kind === 'unknown' ? unknownText() : noPeerText(intent.what);
        update(id, { state: 'answered', provider: 'local', answer: { text, cards: [] } });
        return scroll();
      }
      if (needsDisclose()) {
        update(id, { topic: intent.topic, sinceMs: intent.sinceMs, window: intent.window });
        return await disclose(id, provider()?.data_leaves ?? 'counts');
      }
      try {
        const read = await props.source.aiRead(intent.topic, intent.sinceMs, props.assistant);
        if (read.state === 'unavailable') update(id, { state: 'no-read', noRead: read.reason });
        else {
          update(id, {
            state: 'answered',
            answer: answerFrom(read, intent, nameOf),
            source: { routes: read.routes, freshness: read.freshness, receivedAt: Date.now() },
          });
        }
      } catch (e) {
        update(id, { state: 'error', error: asActionError(e).message });
      }
      scroll();
    } finally { await persistTurn(id); }
  };

  const send = async (id: number) => {
    const t = session.turns.find((x) => x.id === id);
    if (!t?.disclosure || t.state !== 'preview') return;
    update(id, { state: 'sending' });
    try {
      const answer = await props.source.aiSend(t.disclosure.id);
      update(id, { state: 'sent', remote: answer });
    } catch (e) {
      update(id, { state: 'error', error: asActionError(e).message });
    }
    scroll();
    await persistTurn(id);
  };

  const dontSend = (id: number) => {
    const t = session.turns.find((x) => x.id === id);
    if (t?.disclosure) void props.source.aiCancel(t.disclosure.id).catch(() => {});
    update(id, { state: 'not-sent' });
    void persistTurn(id);
  };

  // The persistent endpoint badge: which endpoint answers, who gets paid and
  // what leaves. It changes with the selection, before the first question.
  const sub = () => <EndpointBadge provider={exposure().provider} previewed={exposure().previewed} />;

  return (
    <>
      {props.head(assistant ? `${assistant.name} assistant` : 'Ask your node', sub())}
      <Show when={assistant}>
        <div class="ai-providers-bar" data-assistant-ready={threadReady() ? '' : undefined}>
          {/* Threads are sealed by the Mac host only (ai/threads/storage.rs); a phone does not claim it. */}
          <p data-assistant-role>{assistant!.role}{deviceWord() === 'computer' ? ' Questions and answers stay sealed on this Mac. Keeps the latest 100 turns.' : ''}</p>
          <button type="button" class="soft" data-assistant-forget
            disabled={threadBusy() || session.turns.some(t => t.state === 'reading' || t.state === 'sending')}
            onClick={() => void forget()}>Forget</button>
        </div>
        <Show when={threadError()}><p role="alert" data-assistant-error>{threadError()}</p></Show>
        <details class="ai-providers-bar ai-watches" data-assistant-watches>
          <summary>Watches · while this app is open</summary>
          <p>Local rules use existing status and counts. No model, extra network reads, drafts or actions. Keeps the latest 100 notices.</p>
          <For each={WATCHES[props.assistant!]}>{watch => <label style={{ display: 'block' }}>
            <input type="checkbox" data-watch={watch.rule} checked={!disabledWatches().includes(watch.rule)}
              disabled={threadBusy() || !threadReady()} onChange={e => {
                const enabled = e.currentTarget.checked;
                e.currentTarget.checked = !disabledWatches().includes(watch.rule);
                void setWatch(watch.rule, enabled);
              }} /> {watch.label}
          </label>}</For>
        </details>
        <Show when={props.watchError}><p role="status">{props.watchError}</p></Show>
        <Show when={watchNotices().length}>
          <section class="ai-providers-bar ai-watch-notices" aria-label="Watch notices">
            <For each={watchNotices()}>{notice => <p data-watch-notice>
              <span class="ai-source">Watch · {new Date(notice.at).toLocaleString()} · saved observation</span><br />
              {notice.text}
            </p>}</For>
          </section>
        </Show>
      </Show>
      <div class="ai-providers-bar">
        <div class="ai-providers" role="radiogroup" aria-label="Who answers" data-ai-providers>
          <For each={session.providers ?? []}>
            {(p) => (
              <button
                type="button"
                role="radio"
                class="ai-provider"
                classList={{ current: session.provider === p.kind }}
                aria-checked={session.provider === p.kind}
                disabled={!p.enabled || locked() || (!!assistant && p.kind !== 'local')}
                title={
                  (assistant && p.kind !== 'local' ? 'Remote models are off for named assistants.' : p.note) ??
                  (locked() && session.provider !== p.kind
                    ? 'Send or don’t send the preview first'
                    : p.host
                      ? `${p.model ?? ''} at ${p.host}`
                      : `Nothing leaves this ${deviceWord()}`)
                }
                data-provider={p.kind}
                data-tier={endpointBadge(p).tier}
                onClick={() => setSession('provider', p.kind)}
              >
                <span class="name">{providerLabel(p)}</span>
                <span class="meta">
                  {p.kind === 'local'
                    ? p.model
                      ? p.model
                      : 'nothing leaves'
                    : p.enabled && !assistant
                      ? p.host
                      : 'off'}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={session.provider === 'local'}>
        <div class="ai-own-bar">
          <details class="ai-own-details" open={Boolean(localStatus()?.running)}>
            <summary class="ai-own-summary">
              <span class="ai-own-icon" aria-hidden="true">⚙</span>
              <span class="ai-own-title">
                {localStatus()?.running
                  ? `Local model server active (${localStatus()!.kind === 'ollama' ? 'Ollama' : 'Server'} :${localStatus()!.port})`
                  : 'Local server options (Ollama / llama.cpp)'}
              </span>
              <span class="ai-own-toggle-hint">Configure ▾</span>
            </summary>
            <div class="ai-own" data-ai-own>
              <Show
                when={localStatus()?.running}
                fallback={
                  <p class="hint" data-ai-own-howto>
                    {localStatus()?.howto ??
                      `Looking for a local model server on this ${deviceWord()}…`}
                  </p>
                }
              >
                <p class="hint" data-ai-own-found>
                  Found{' '}
                  {localStatus()!.kind === 'ollama' ? 'Ollama' : 'a local model server'} on 127.0.0.1:
                  {localStatus()!.port}. Nobody is paid; nothing leaves this {deviceWord()}.
                </p>
                <div class="ai-own-row">
                  <label class="ai-own-port">
                    <span>Port</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={portDraft()}
                      disabled={localBusy() || locked()}
                      onInput={(e) => setPortDraft(e.currentTarget.value)}
                      onChange={() => {
                        const port = Number.parseInt(portDraft(), 10);
                        if (Number.isFinite(port) && port > 0) void refreshLocal(port);
                      }}
                      data-ai-own-port
                      aria-label="Local model server port"
                    />
                  </label>
                  <button
                    type="button"
                    class="quiet"
                    disabled={localBusy() || locked()}
                    onClick={() => {
                      const port = Number.parseInt(portDraft(), 10);
                      void refreshLocal(Number.isFinite(port) && port > 0 ? port : null);
                    }}
                    data-ai-own-refresh
                  >
                    Refresh
                  </button>
                  <Show when={provider()?.model}>
                    <button
                      type="button"
                      class="quiet"
                      disabled={localBusy() || locked()}
                      onClick={() => void clearModel()}
                      data-ai-own-clear
                    >
                      Use rules only
                    </button>
                  </Show>
                </div>
                <div class="ai-own-models" role={(localStatus()?.models.length ?? 0) > 0 ? 'listbox' : 'group'} aria-label="Local models" data-ai-own-models>
                  <For each={localStatus()?.models ?? []}>
                    {(name) => (
                      <button
                        type="button"
                        role="option"
                        class="chip"
                        aria-selected={provider()?.model === name}
                        disabled={localBusy() || locked()}
                        data-ai-own-model={name}
                        onClick={() => void pickModel(name)}
                      >
                        {name}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={localError()}>
                <div data-ai-own-error><SoftError message={localError()!} /></div>
              </Show>
            </div>
          </details>
        </div>
      </Show>

      <div class="stream ai-stream" ref={stream} data-stream data-ai-track>
        <div class="chat-column ai-chat-column">
          <Show when={session.turns.length === 0}>
            <div class="empty-track ai-hero">
              <div class="ai-hero-spark" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <h2>Ask about your own node</h2>
              <p class="hint">
                {assistant ? `Ask about the topics in this assistant’s role. Rules answer here. With a local model selected, Ask lets it read up to three topics on this ${deviceWord()} and return an answer or a display-only draft.` : `This app reads your node through a closed list of read-only routes and answers here. Your node never talks to a model. If you turn on a remote model, each question shows exactly what would leave this ${deviceWord()}, and nothing is sent until you press Send.`}
              </p>
              <div class="ai-hero-suggestions" aria-label="Suggestions">
                <For each={suggestions}>
                  {(s) => (
                    <button type="button" class="ai-hero-card" disabled={busy()} onClick={() => void ask(s)} data-suggestion>
                      <span class="ai-hero-card-arrow" aria-hidden="true">↳</span>
                      <span class="ai-hero-card-text">{s}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <For each={session.turns}>
            {(t, i) => (
              <>
                <Show when={i() === 0 || day(session.turns[i() - 1].at) !== day(t.at)}>
                  <p class="day">{day(t.at)}</p>
                </Show>
                <article class="msg out ai-question-out" data-ai-question>
                  <div class="bubble">{t.question}</div>
                </article>
                <div class="ai-turn-wrap">
                  <TurnView
                    turn={t}
                    now={props.now}
                    nameOf={nameOf}
                    onPreset={(p) => void disclose(t.id, p)}
                    onSend={() => void send(t.id)}
                    onDontSend={() => dontSend(t.id)}
                    onPrefill={props.onPrefill}
                  />
                </div>
              </>
            )}
          </For>
        </div>
      </div>

      <form
        class="composer ai-composer"
        data-ai-composer
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft());
        }}
      >
        <Show when={session.turns.length > 0}>
          <div class="ai-suggest" aria-label="Suggestions">
            <For each={suggestions}>
              {(s) => (
                <button type="button" class="chip" disabled={busy()} onClick={() => void ask(s)} data-suggestion>
                  {s}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={!assistant || (props.assistant === 'inbox' && ownModel())}>
        <div
          class="ai-composer-extras"
          classList={{ 'is-open': showExtras() || Boolean(draftText()) }}
        >
          <div class="ai-extras-card">
            <div class="ai-extras-head">
              <span class="ai-extras-title">Draft note attachment</span>
              <button
                type="button"
                class="ai-extras-close"
                onClick={() => {
                  setShowExtras(false);
                  if (draftText()) setDraftText('');
                }}
                title="Clear and close"
                aria-label="Close draft field"
              >
                ✕
              </button>
            </div>
            <label class="ai-draft-field">
              <textarea
                rows={2}
                placeholder="Message or invoice note — copied exactly into the draft"
                value={draftText()}
                onInput={(e) => setDraftText(e.currentTarget.value)}
                disabled={busy()}
                data-ai-draft-text
              />
              <span class="hint">For messages and invoice notes. Leave blank to write in the composer.</span>
            </label>
          </div>
        </div>

        </Show>
        <div class="composer-main ai-composer-main">
          <Show when={!assistant || (props.assistant === 'inbox' && ownModel())}><button
            type="button"
            class="attach soft ai-plus-btn"
            classList={{ active: showExtras() || Boolean(draftText()) }}
            onClick={() => setShowExtras((v) => !v)}
            title="Attach message draft note or options"
            aria-label="Composer options"
            aria-expanded={showExtras()}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button></Show>
          <textarea
            rows={1}
            placeholder="Ask your node…"
            value={draft()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              e.currentTarget.style.height = 'auto';
              e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(draft());
              }
            }}
            aria-label="Ask your node"
            data-ai-input
          />
          <button
            type="submit"
            class="primary ai-ask-btn"
            classList={{ 'is-preview': needsDisclose() }}
            disabled={busy() || !draft().trim()}
            data-ai-ask
            title={needsDisclose() ? 'Preview what will be sent' : 'Ask your node'}
            aria-label={needsDisclose() ? 'Preview' : 'Ask'}
          >
            <Show when={needsDisclose()} fallback={
              <>
                <span class="sr-only">Ask</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </>
            }>
              <span>Preview</span>
            </Show>
          </button>
        </div>

        <p class="send-next ai-policy" data-ai-policy>
          <span class="ai-policy-lock" aria-hidden="true">🔒</span>
          <span>
            {assistant
              ? ownModel()
                ? `Read-only assistant. Up to three reads per question; drafts are display-only. Nothing is sent or spent. The model stays on this ${deviceWord()}.`
                : `Read-only assistant. No payments, messages or drafts. Rules stay on this ${deviceWord()}.`
              : remote()
              ? `Each question shows the exact request for ${provider()?.label ?? 'the remote model'} first. Nothing is approved ahead of time.`
              : ownModel()
                ? `Each question shows the exact request for ${provider()?.model} on this ${deviceWord()} first. Nobody is paid; the preview never leaves this ${deviceWord()}.`
                : `Nothing leaves this ${deviceWord()}. The AI never spends: it can only prepare a draft for you to send.`}
          </span>
        </p>
      </form>
    </>
  );
}

function TurnView(props: {
  turn: Turn;
  now: number;
  nameOf: (id: string) => string;
  onPreset: (p: Preset) => void;
  onSend: () => void;
  onDontSend: () => void;
  onPrefill: (p: Proposal) => void;
}) {
  const t = () => props.turn;
  return (
    <Switch>
      <Match when={t().state === 'reading'}>
        <div class="ai-answer" data-ai-answer="reading">
          <div class="bubble ai-thinking">
            <DelayedSpinner small />{' '}
            {t().provider === 'local' && !t().disclosure && !t().topic
              ? 'Reading your node…'
              : 'Preparing the preview. Nothing is sent…'}
          </div>
        </div>
      </Match>
      <Match when={t().state === 'error'}>
        <div class="ai-answer" data-ai-answer="error">
          <SoftError class="bubble soft-error" message={t().error ?? 'The answer is unavailable.'} />
        </div>
      </Match>
      <Match when={t().state === 'no-read'}>
        <div class="ai-answer" data-ai-answer="no-read" data-reason={t().noRead}>
          <div class="bubble">{noReadText(t().noRead!)}</div>
        </div>
      </Match>
      <Match when={t().state === 'answered'}>
        <div class="ai-answer" data-ai-answer="answered">
          <div class="bubble" data-ai-text>{t().answer!.text}</div>
          <For each={t().answer!.cards}>{(c) => <CardView card={c} nameOf={props.nameOf} now={props.now} />}</For>
          <Show when={t().modelTurn}>
            {(turn) => <>
              <Show when={turn().output.kind === 'proposal' && (turn().output as Extract<LocalTurn['output'], { kind: 'proposal' }>).proposal}>
                {(p) => <ModelProposalCard p={p()} />}
              </Show>
              <p class="ai-source" data-ai-model-warning>Your node did not check this model answer. Drafts are never executed.</p>
              <For each={turn().reads}>{read => read.state === 'live'
                ? <SourceStamp routes={read.routes} line={sourceLine(read.freshness, t().at, props.now)} />
                : <p class="ai-source">{read.topic}: {noReadText(read.reason)}</p>}</For>
            </>}
          </Show>
          <Show when={t().proposal}>{(p) => <ProposalCard p={p()} onPrefill={props.onPrefill} />}</Show>
          <Show when={t().source}>
            {(s) => <SourceStamp routes={s().routes} line={sourceLine(s().freshness, s().receivedAt, props.now)} />}
          </Show>
          <Show when={!t().source && !t().proposal && !t().modelTurn}>
            <p class="ai-source" data-ai-source="none">{t().saved ? 'Saved answer — historical, not a fresh node read. Model answers are not checked by your node.' : 'Nothing was read from your node for this.'}</p>
          </Show>
        </div>
      </Match>
      <Match when={t().disclosure && (t().state === 'preview' || t().state === 'sending' || t().state === 'not-sent')}>
        <DisclosureCard
          d={t().disclosure!}
          state={t().state as 'preview' | 'sending' | 'not-sent'}
          onPreset={props.onPreset}
          onSend={props.onSend}
          onDontSend={props.onDontSend}
        />
      </Match>
      <Match when={t().state === 'sent' && t().remote}>
        {(r) => (
          <div class="ai-answer" data-ai-answer={r().provider === 'local' ? 'own' : 'remote'}>
            <div class="bubble" data-ai-text>
              {r().text}
            </div>
            <Show
              when={r().provider === 'local'}
              fallback={
                <p class="ai-source" data-ai-source="remote">
                  <span class="ai-from">{r().label}</span> · {r().model} at <span class="id">{r().host}</span> · from what you
                  shared ({PRESETS.find((p) => p.id === t().disclosure?.preset)?.label.toLowerCase()},{' '}
                  {r().sent_bytes > 0 ? `${satsWhole(r().sent_bytes)} bytes` : 'sample, nothing sent'}). Your node did not
                  check this answer.
                </p>
              }
            >
              <p class="ai-source" data-ai-source="own">
                <span class="ai-from">Own</span> · On this {deviceWord()} · {r().model} · Nobody is paid · from what you shared
                ({PRESETS.find((p) => p.id === t().disclosure?.preset)?.label.toLowerCase()},{' '}
                {r().sent_bytes > 0 ? `${satsWhole(r().sent_bytes)} bytes` : 'sample'}). Your node did not check this
                answer.
              </p>
            </Show>
            <details class="ai-sent" data-ai-sent>
              <summary>{r().sent_bytes > 0 ? 'What was sent' : 'What would have been sent'}</summary>
              <pre class="ai-payload">{t().disclosure?.body}</pre>
            </details>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function SourceStamp(props: { routes: string[]; line: ReturnType<typeof sourceLine> }) {
  return (
    <p class="ai-source" data-ai-source="node" data-freshness={props.line.state}>
      <span class="ai-from">From your node</span>, through the app’s read broker · <span class="id">{props.routes.join(' · ')}</span>
      <br />
      <span classList={{ stale: props.line.state === 'stale' }} class="ai-fresh" data-ai-fresh>
        {props.line.text}
      </span>
    </p>
  );
}

function CopyButton(props: { text: () => string }) {
  const [done, setDone] = createSignal<false | 'copied' | 'failed'>(false);
  return (
    <button
      type="button"
      class="link copy"
      data-copy
      onClick={() => {
        void copyPlainText(props.text()).then(() => 'copied' as const, () => 'failed' as const).then((r) => {
          setDone(r);
          setTimeout(() => setDone(false), r === 'failed' ? 4000 : 1600);
        });
      }}
    >
      {done() === 'copied' ? 'Copied' : done() === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

const fig = (a: Amount | undefined) => (value(a) === null ? 'unavailable' : amount(value(a)!));

function CardView(props: { card: Card; nameOf: (id: string) => string; now: number }) {
  const text = () => cardText(props.card, props.nameOf);
  return (
    <Switch>
      <Match when={props.card.type === 'node' && props.card}>
        {(c) => {
          const h = () => (c() as Extract<Card, { type: 'node' }>).health;
          return (
            <div class="artifact ai-card" data-ai-card="node">
              <div class="row card-head">
                <span class="kind">Node</span>
                <CopyButton text={text} />
              </div>
              <div class="row" style={{ gap: 'var(--s-2)' }}>
                <span class={`dot ${h().liveness === 'ok' ? 'ok' : 'warn'}`} />
                <strong>{h().liveness === 'ok' ? 'Healthy' : 'Not healthy'}</strong>
              </div>
              <dl class="facts">
                <dt>Peers connected</dt>
                <dd class="sats">{value(h().connected_peers) ?? 'unavailable'}</dd>
                <dt>Encrypted sessions</dt>
                <dd class="sats">{value(h().e2ee_sessions) ?? 'unavailable'}</dd>
                <dt>Waiting to deliver</dt>
                <dd class="sats">{value(h().pending_deliveries) ?? 'unavailable'}</dd>
                <dt>Block height</dt>
                <dd class="sats">{value(h().block_height) === null ? 'unavailable' : satsWhole(value(h().block_height)!)}</dd>
                <dt>Lightning</dt>
                <dd>{h().lightning_backend}{h().lightning_payment_capable ? ', can pay' : ', cannot pay'}</dd>
                <dt>Uptime</dt>
                <dd class="sats">{value(h().uptime) === null ? 'unavailable' : uptime(value(h().uptime)!)}</dd>
              </dl>
            </div>
          );
        }}
      </Match>
      <Match when={props.card.type === 'balance' && props.card}>
        {(c) => {
          const card = () => c() as Extract<Card, { type: 'balance' }>;
          return (
            <div class="artifact ai-card" data-ai-card="balance">
              <div class="row card-head">
                <span class="kind">{card().balance ? 'Balance' : 'Channels'}</span>
                <CopyButton text={text} />
              </div>
              <Show when={card().balance}>
                {(b) => (
                  <>
                    <span class="sats big" data-ai-balance>
                      {value(b().wallet_balance) === null ? fig(b().wallet_balance) : amount(value(b().wallet_balance)!)}
                    </span>
                    <dl class="facts">
                      <dt>Lightning, yours</dt>
                      <dd class="sats">{fig(b().channel_local_balance)}</dd>
                      <dt>Lightning, theirs</dt>
                      <dd class="sats">{fig(b().channel_remote_balance)}</dd>
                      <dt>Channel capacity</dt>
                      <dd class="sats">{fig(b().channel_capacity)}</dd>
                    </dl>
                  </>
                )}
              </Show>
              <Show when={card().channels}>
                {(ch) => (
                  <For each={ch().channels}>
                    {(x) => {
                      const cap = value(x.capacity) ?? 0;
                      const mine = value(x.local_balance) ?? 0;
                      return (
                        <div class="channel">
                          <div class="row">
                            <span>{x.active ? 'active' : 'inactive'}</span>
                            <span class="sats">{fig(x.capacity)} capacity</span>
                          </div>
                          <div class="liquidity">
                            <div style={{ width: `${cap > 0 ? (mine / cap) * 100 : 0}%`, opacity: x.active ? 1 : 0.4 }} />
                          </div>
                          <div class="row">
                            <span class="sats">{fig(x.local_balance)} yours</span>
                            <span class="sats">{fig(x.remote_balance)} theirs</span>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                )}
              </Show>
            </div>
          );
        }}
      </Match>
      <Match when={props.card.type === 'payments' && props.card}>
        {(c) => {
          const card = () => c() as Extract<Card, { type: 'payments' }>;
          const r = () => card().report;
          const shown = () => r().entries.slice(0, 8);
          return (
            <div class="artifact ai-card" data-ai-card="payments">
              <div class="row card-head">
                <span class="kind">Paid messages · {card().window}</span>
                <CopyButton text={text} />
              </div>
              <div class="row ai-totals">
                <span>
                  <span class="label">Spent</span> <span class="sats">{value(r().sent_total) === null ? fig(r().sent_total) : amount(value(r().sent_total)!)}</span>
                </span>
                <span>
                  <span class="label">Received</span> <span class="sats">{value(r().received_total) === null ? fig(r().received_total) : amount(value(r().received_total)!)}</span>
                </span>
              </div>
              <ul class="ai-payments">
                <For each={shown()}>
                  {(e) => (
                    <li data-direction={e.direction}>
                      <span class="dir" aria-label={e.direction}>{e.direction === 'sent' ? '↑' : '↓'}</span>
                      <span class="who">{e.peer.state === 'value' ? props.nameOf(e.peer.value) : 'withheld'}</span>
                      <span class="when">{day(e.at_ms)} {clock(e.at_ms)}</span>
                      <span class="sats">
                        {e.direction === 'sent' ? '−' : '+'}
                        {fig(e.amount)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={r().entries.length > shown().length}>
                <span class="hint">and {r().entries.length - shown().length} more (Copy includes them)</span>
              </Show>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function ModelProposalCard(props: { p: ModelProposal }) {
  return <div class="artifact ai-card proposal" data-model-proposal={props.p.kind}>
    <span class="kind">Draft · display only</span>
    <div class="bubble quote">{modelProposalText(props.p)}</div>
    <span class="hint">Review this draft. To send anything, open the contact’s composer yourself.</span>
  </div>;
}

function ProposalCard(props: { p: Proposal; onPrefill: (p: Proposal) => void }) {
  const title = () =>
    ({ message: `Message to ${props.p.name}`, pay: `Payment to ${props.p.name}`, request: `Invoice for ${props.p.name}` })[props.p.kind];
  return (
    <div class="artifact ai-card proposal" data-ai-card="proposal" data-proposal={props.p.kind}>
      <span class="kind">Draft · you send it</span>
      <strong>{title()}</strong>
      <Show when={props.p.kind === 'message' && (props.p as Extract<Proposal, { kind: 'message' }>).draft_text}>
        {(text) => <div class="bubble quote">{text()}</div>}
      </Show>
      <Show when={props.p.kind !== 'message'}>
        <span class="sats big">
          {amount((props.p as { sats: number }).sats * 1000)}
        </span>
      </Show>
      <span class="hint">
        {props.p.kind === 'request'
          ? 'Opens the Request tab with this amount filled in.'
          : 'Opens the composer with this filled in. The cost is shown there, and spending needs your approval.'}
      </span>
      <button type="button" class="primary" data-ai-prefill onClick={() => props.onPrefill(props.p)}>
        Open in {props.p.name}’s composer
      </button>
    </div>
  );
}

function DisclosureCard(props: {
  d: Disclosure;
  state: 'preview' | 'sending' | 'not-sent';
  onPreset: (p: Preset) => void;
  onSend: () => void;
  onDontSend: () => void;
}) {
  const [view, setView] = createSignal<'shared' | 'exact'>('shared');
  /** The user message as it sits inside the body: decoded from its JSON string, not rebuilt. */
  const shared = () => {
    try {
      const body = JSON.parse(props.d.body) as { messages?: { role: string; content: string }[] };
      const user = body.messages?.find((m) => m.role === 'user');
      return typeof user?.content === 'string' ? user.content : null;
    } catch {
      return null;
    }
  };
  return (
    <div class="artifact ai-card disclosure" data-ai-card="disclosure" data-state={props.state} data-preset={props.d.preset}>
      <div class="row card-head">
        <span class="kind">{props.state === 'not-sent' ? 'Not sent' : `Nothing has left this ${deviceWord()} yet`}</span>
      </div>
      <Show
        when={props.state !== 'not-sent'}
        fallback={<p class="hint">This preview was canceled. Nothing left this {deviceWord()}.</p>}
      >
        <p>
          This is exactly what would go to <strong>{props.d.label}</strong> ({props.d.model}) at{' '}
          <span class="id">{props.d.host}</span>: {satsWhole(props.d.bytes)} bytes, once.
          <Show when={props.d.key_env}> Its key is added from {props.d.key_env} on this {deviceWord()} and is not shown.</Show>
        </p>
        <div class="modes small" role="radiogroup" aria-label="What to share" data-ai-presets>
          <For each={PRESETS}>
            {(p) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.d.preset === p.id}
                title={p.detail}
                disabled={props.state === 'sending'}
                data-preset-option={p.id}
                onClick={() => props.d.preset !== p.id && props.onPreset(p.id)}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
        <p class="hint">{PRESETS.find((p) => p.id === props.d.preset)?.detail}</p>
        <div class="modes small" role="tablist" aria-label="Preview view">
          <button type="button" role="tab" aria-selected={view() === 'shared'} data-ai-view="shared" onClick={() => setView('shared')}>
            What you share
          </button>
          <button type="button" role="tab" aria-selected={view() === 'exact'} data-ai-view="exact" onClick={() => setView('exact')}>
            Exact bytes
          </button>
        </div>
        <pre class="ai-payload" data-ai-payload data-view={view()} tabindex="0">
          {view() === 'shared' ? shared() ?? props.d.body : props.d.body}
        </pre>
        <Show when={view() === 'shared'}>
          <p class="hint">
            This is the question and data part, character for character. The rest is the model name and the fixed
            instructions in Exact bytes.
          </p>
        </Show>
        <div class="row" style={{ 'justify-content': 'flex-end' }}>
          <button type="button" class="quiet" data-ai-dont-send disabled={props.state === 'sending'} onClick={() => props.onDontSend()}>
            Don’t send
          </button>
          <button type="button" class="primary" data-ai-send disabled={props.state === 'sending'} onClick={() => props.onSend()}>
            {props.state === 'sending' ? 'Sending…' : `Send to ${props.d.label}`}
          </button>
        </div>
        <p class="hint">This approval covers this one request only. The preview lapses in {Math.round(props.d.expires_in_ms / 60_000)} min.</p>
      </Show>
    </div>
  );
}
