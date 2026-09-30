// "Ask your node": the AI track in the main window.
//
// The app is the broker. A question becomes a topic; the host reads it through
// its closed read broker and hands back the allowlisted projection with its
// freshness. On this computer (the default) the answer is composed here and
// nothing leaves. A remote model, when this computer's settings turn one on,
// gets only the body shown in the preview, and only after the owner presses
// Send for that one question. Proposed actions only prefill a composer.

import { createSignal, For, Match, onCleanup, Show, Switch, type JSX } from 'solid-js';
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
import { amount, clock, day, sats, satsWhole, satUnit, uptime } from './format';
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
  at: number;
  question: string;
  provider: ProviderKind;
  state: 'reading' | 'answered' | 'no-read' | 'error' | 'preview' | 'sending' | 'sent' | 'not-sent';
  answer?: Answer;
  source?: { routes: string[]; freshness: AiFreshness; receivedAt: number };
  proposal?: Proposal;
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
  const [localStatus, setLocalStatus] = createSignal<LocalStatus | null>(null);
  const [localBusy, setLocalBusy] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [portDraft, setPortDraft] = createSignal('');
  let stream: HTMLDivElement | undefined;

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
  /** Own tier with a picked loopback model: same disclose/send as remotes. */
  const ownModel = () => session.provider === 'local' && !!provider()?.model;
  const needsDisclose = () => remote() || ownModel();
  const busy = () => session.turns.some((t) => t.state === 'reading' || t.state === 'sending') || localBusy();
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
      const d = await props.source.aiDisclose(t.provider, t.topic, t.sinceMs ?? null, preset, t.question);
      update(id, { state: 'preview', disclosure: d });
    } catch (e) {
      update(id, { state: 'error', error: asActionError(e).message });
    }
    scroll();
  };

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy()) return;
    setDraft('');
    const id = turnSeq++;
    const now = Date.now();
    const intent: Intent = understand(question, props.peers, now, { draft_text: draftText() });
    const base: Turn = { id, at: now, question, provider: session.provider, state: 'reading' };
    setSession('turns', (list) => [...list, base]);
    scroll();

    if (intent.kind === 'act') {
      setDraftText('');
      update(id, { state: 'answered', provider: 'local', proposal: intent.proposal, answer: { text: proposalText(intent.proposal), cards: [] } });
      return scroll();
    }
    if (intent.kind === 'no-peer' || intent.kind === 'unknown') {
      const text = intent.kind === 'unknown' ? unknownText() : noPeerText(intent.what);
      update(id, { state: 'answered', provider: 'local', answer: { text, cards: [] } });
      return scroll();
    }
    if (needsDisclose()) {
      update(id, { topic: intent.topic, sinceMs: intent.sinceMs, window: intent.window });
      return disclose(id, provider()?.data_leaves ?? 'counts');
    }
    try {
      const read = await props.source.aiRead(intent.topic, intent.sinceMs);
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
  };

  const dontSend = (id: number) => {
    const t = session.turns.find((x) => x.id === id);
    if (t?.disclosure) void props.source.aiCancel(t.disclosure.id).catch(() => {});
    update(id, { state: 'not-sent' });
  };

  // The persistent endpoint badge: which endpoint answers, who gets paid and
  // what leaves. It changes with the selection, before the first question.
  const sub = () => <EndpointBadge provider={exposure().provider} previewed={exposure().previewed} />;

  return (
    <>
      {props.head('Ask your node', sub())}
      <div class="ai-providers" role="radiogroup" aria-label="Who answers" data-ai-providers>
        <For each={session.providers ?? []}>
          {(p) => (
            <button
              type="button"
              role="radio"
              class="ai-provider"
              aria-checked={session.provider === p.kind}
              disabled={!p.enabled || locked()}
              title={
                p.note ??
                (locked() && session.provider !== p.kind
                  ? 'Send or don’t send the preview first'
                  : p.host
                    ? `${p.model ?? ''} at ${p.host}`
                    : 'Nothing leaves this computer')
              }
              data-provider={p.kind}
              data-tier={endpointBadge(p).tier}
              onClick={() => setSession('provider', p.kind)}
            >
              <span class="name">{p.label}</span>
              <span class="meta">
                {p.kind === 'local'
                  ? p.model
                    ? p.model
                    : 'nothing leaves'
                  : p.enabled
                    ? p.host
                    : 'off'}
              </span>
            </button>
          )}
        </For>
      </div>

      <Show when={session.provider === 'local'}>
        <div class="ai-own" data-ai-own>
          <Show
            when={localStatus()?.running}
            fallback={
              <p class="hint" data-ai-own-howto>
                {localStatus()?.howto ??
                  'Looking for a local model server on this computer…'}
              </p>
            }
          >
            <p class="hint" data-ai-own-found>
              Found{' '}
              {localStatus()!.kind === 'ollama' ? 'Ollama' : 'a local model server'} on 127.0.0.1:
              {localStatus()!.port}. Nobody is paid; nothing leaves this computer.
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
            <div class="ai-own-models" role="listbox" aria-label="Local models" data-ai-own-models>
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
            <p class="err-note" data-ai-own-error>
              {localError()}
            </p>
          </Show>
        </div>
      </Show>

      <div class="stream ai-stream" ref={stream} data-stream data-ai-track>
        <Show when={session.turns.length === 0}>
          <div class="empty-track">
            <h2>Ask about your own node</h2>
            <p class="hint">
              This app reads your node through a closed list of read-only routes and answers here. Your node never talks
              to a model. If you turn on a remote model, each question shows exactly what would leave this computer, and
              nothing is sent until you press Send.
            </p>
          </div>
        </Show>
        <For each={session.turns}>
          {(t, i) => (
            <>
              <Show when={i() === 0 || day(session.turns[i() - 1].at) !== day(t.at)}>
                <p class="day">{day(t.at)}</p>
              </Show>
              <article class="msg out" data-ai-question>
                <div class="bubble">{t.question}</div>
              </article>
              <TurnView
                turn={t}
                now={props.now}
                nameOf={nameOf}
                onPreset={(p) => void disclose(t.id, p)}
                onSend={() => void send(t.id)}
                onDontSend={() => dontSend(t.id)}
                onPrefill={props.onPrefill}
              />
            </>
          )}
        </For>
      </div>

      <form
        class="composer ai-composer"
        data-ai-composer
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft());
        }}
      >
        <div class="ai-suggest" aria-label="Suggestions">
          <For each={SUGGESTIONS}>
            {(s) => (
              <button type="button" class="chip" disabled={busy()} onClick={() => void ask(s)} data-suggestion>
                {s}
              </button>
            )}
          </For>
        </div>
        <div class="composer-bar">
          <textarea
            rows={1}
            placeholder="Ask your node…"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(draft());
              }
            }}
            aria-label="Ask your node"
            data-ai-input
          />
          <button type="submit" class="primary" disabled={busy() || !draft().trim()} data-ai-ask>
            {needsDisclose() ? 'Preview' : 'Ask'}
          </button>
        </div>
        <label class="ai-draft-field">
          <span>Draft text (optional)</span>
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
        <p class="send-next" data-ai-policy>
          {remote()
            ? `Each question shows the exact request for ${provider()?.label ?? 'the remote model'} first. Nothing is approved ahead of time.`
            : ownModel()
              ? `Each question shows the exact request for ${provider()?.model} on this computer first. Nobody is paid; the preview never leaves this machine.`
              : 'Nothing leaves this computer. The AI never spends: it can only prepare a draft for you to send.'}
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
            <span class="spinner small" />{' '}
            {t().provider === 'local' && !t().disclosure && !t().topic
              ? 'Reading your node…'
              : 'Preparing the preview. Nothing is sent…'}
          </div>
        </div>
      </Match>
      <Match when={t().state === 'error'}>
        <div class="ai-answer" data-ai-answer="error">
          <div class="bubble err-note">{t().error}</div>
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
          <Show when={t().proposal}>{(p) => <ProposalCard p={p()} onPrefill={props.onPrefill} />}</Show>
          <Show when={t().source}>
            {(s) => <SourceStamp routes={s().routes} line={sourceLine(s().freshness, s().receivedAt, props.now)} />}
          </Show>
          <Show when={!t().source && !t().proposal}>
            <p class="ai-source" data-ai-source="none">Nothing was read from your node for this.</p>
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
                <span class="ai-from">Own</span> · On this computer · {r().model} · Nobody is paid · from what you shared
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
  const [done, setDone] = createSignal(false);
  return (
    <button
      type="button"
      class="link copy"
      data-copy
      onClick={() => {
        void copyPlainText(props.text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      {done() ? 'Copied' : 'Copy'}
    </button>
  );
}

const fig = (a: Amount | undefined) => (value(a) === null ? 'unavailable' : sats(value(a)!));

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
                        {fig(e.amount)} {value(e.amount) === null ? '' : satUnit(value(e.amount)!)}
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
        <span class="kind">{props.state === 'not-sent' ? 'Not sent' : 'Nothing has left this computer yet'}</span>
      </div>
      <Show
        when={props.state !== 'not-sent'}
        fallback={<p class="hint">This preview was canceled. Nothing left this computer.</p>}
      >
        <p>
          This is exactly what would go to <strong>{props.d.label}</strong> ({props.d.model}) at{' '}
          <span class="id">{props.d.host}</span>: {satsWhole(props.d.bytes)} bytes, once.
          <Show when={props.d.key_env}> Its key is added from {props.d.key_env} on this computer and is not shown.</Show>
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
