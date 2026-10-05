// Porch reads (Browse): a contact's profile card or a flat page, fetched by
// this node from theirs. Each read pays once, after one review the owner
// confirms; cards the node already holds open for free and say so.
import { createEffect, createSignal, For, Match, on, onMount, Show, Switch, type JSX } from 'solid-js';
import type { PaymentQuote, Peer, PorchCard, PorchRead, SpendView } from './types';
import type { Source } from './source';
import { amount as fmtAmount, shortId } from './format';
import { asActionError, spendLine } from './state';
import { FrontDoorCardView } from './Discover';
import { SoftError } from './SoftError';
import { cleanText, parseMarkdown, porchPath, PORCH_CARD_PATH, type Block, type Inline } from './porchText';

type Props = {
  source: Source;
  now: number;
  peers: Peer[];
  /** This node answers and makes porch reads (`porch_read_v1`). */
  nodeReads: boolean;
  moneyBlocked: boolean;
  spend: SpendView | null;
  spendGate: JSX.Element;
  nameOf: (id: string) => string;
};

type Review = { peer: string; path: string; quote: PaymentQuote };
type Shown = { peer: string; card: PorchCard | null; page: PorchRead | null };

export function PorchPanel(props: Props) {
  const readable = () => props.peers.filter((p) => p.porch === true);
  const offers = (peer: string) => props.nodeReads && readable().some((p) => p.node_id.toLowerCase() === peer.toLowerCase());
  const [quotes, setQuotes] = createSignal<Record<string, PaymentQuote>>({});
  const [held, setHeld] = createSignal<PorchCard[]>([]);
  const [review, setReview] = createSignal<Review | null>(null);
  const [shown, setShown] = createSignal<Shown | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [other, setOther] = createSignal('');

  const loadHeld = async () => {
    try {
      setHeld(await props.source.porchCards());
    } catch {
      // Held cards are a convenience; a failed read leaves the list as it was.
    }
  };
  onMount(() => void loadHeld());
  createEffect(
    on(
      () => (props.nodeReads ? readable().map((p) => p.node_id.toLowerCase()) : []),
      (ids) => {
        for (const id of ids) {
          if (quotes()[id]) continue;
          props.source.porchQuote(id).then(
            (q) => setQuotes((all) => ({ ...all, [id]: q })),
            () => {},
          );
        }
      },
    ),
  );
  // A review is for one read as quoted; anything that could change it withdraws it.
  createEffect(() => {
    const rv = review();
    if (rv && (props.moneyBlocked || !offers(rv.peer))) setReview(null);
  });

  const cost = (peer: string) => {
    const q = quotes()[peer.toLowerCase()];
    return q ? fmtAmount(q.principal_msat) : '…';
  };
  const heldFor = (peer: string) => held().find((c) => c.node_id.toLowerCase() === peer.toLowerCase()) ?? null;

  const ask = async (peer: string, path: string) => {
    if (busy()) return;
    setError(null);
    setReview(null);
    setBusy(true);
    try {
      const quote = await props.source.porchQuote(peer);
      setQuotes((all) => ({ ...all, [peer.toLowerCase()]: quote }));
      setReview({ peer: peer.toLowerCase(), path, quote });
    } catch (e) {
      setError(asActionError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const rv = review();
    if (!rv || busy()) return;
    // One confirm pays one read: the review is gone before the read is sent.
    setReview(null);
    setError(null);
    setBusy(true);
    try {
      const r = await props.source.porchRead(rv.peer, rv.path, rv.quote.total_msat);
      if (r.kind === 'card') {
        setShown({ peer: rv.peer, card: r.card, page: null });
        await loadHeld();
      } else {
        const prior = shown();
        setShown({ peer: rv.peer, card: prior?.peer === rv.peer ? prior.card : heldFor(rv.peer), page: r });
      }
    } catch (e) {
      setError(asActionError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const otherPath = () => (other().trim() ? porchPath(other()) : null);
  const pagesOf = (card: PorchCard | null): string[] => {
    const paths = [card?.site?.index_path, card?.cv?.path].map((p) => (p ? porchPath(p) : null));
    return [...new Set(paths.filter((p): p is string => p !== null && p !== PORCH_CARD_PATH))];
  };

  return (
    <div class="panel porch" data-panel="porch">
      <h2>Porch</h2>
      <p class="hint">
        Read a contact’s profile card or pages straight from their node. Each read pays their page price
        once, to them, after you confirm it. Pages are shown as text: nothing in them runs or opens.
      </p>
      <Show
        when={props.nodeReads}
        fallback={
          <p class="hint" data-porch-node-off>
            Your node does not make porch reads yet. Update it to read contacts’ cards and pages.
          </p>
        }
      >
        <Show
          when={readable().length > 0}
          fallback={
            <p class="hint" data-porch-none>
              No connected contact offers porch reads right now. Contacts appear here when their node is
              connected and advertises porch_read_v1.
            </p>
          }
        >
          <ul class="porch-peers" data-porch-peers>
            <For each={readable()}>
              {(p) => (
                <li data-porch-peer={p.node_id.toLowerCase()}>
                  <span class="name">{props.nameOf(p.node_id)}</span>
                  <span class="meta id">{shortId(p.node_id)}</span>
                  <button
                    type="button"
                    class="link"
                    data-porch-open-card
                    disabled={busy() || props.moneyBlocked}
                    onClick={() => void ask(p.node_id, PORCH_CARD_PATH)}
                  >
                    Open profile card · {cost(p.node_id)}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={props.moneyBlocked}>
        <p class="hint" data-porch-blocked>Payments are not ready yet.</p>
      </Show>
      <Show when={!props.moneyBlocked && props.nodeReads && readable().length > 0 && !spendLine(props.spend, props.now).open}>
        <p class="hint" data-porch-window>
          A read uses this contact’s budget, or your ten-minute approval at your node. Approving pays nothing.
        </p>
        {props.spendGate}
      </Show>

      <Show when={review()}>
        {(rv) => (
          <div class="pay-review" data-porch-review data-review-msat={rv().quote.principal_msat} data-review-max-msat={rv().quote.total_msat}>
            <p class="pay-review-title" data-porch-review-what>
              {rv().path === PORCH_CARD_PATH ? `Read ${props.nameOf(rv().peer)}’s profile card` : `Read ${rv().path} from ${props.nameOf(rv().peer)}`}
            </p>
            <p class="hint">Paid to their node, once. Nothing is retried: reading again pays again.</p>
            <dl>
              <dt>Read</dt>
              <dd data-review-amount>{fmtAmount(rv().quote.principal_msat)}</dd>
              <dt>Network fee</dt>
              <dd data-review-fee>up to {fmtAmount(rv().quote.max_routing_fee_msat)}</dd>
              <dt>Total at most</dt>
              <dd data-review-total>{fmtAmount(rv().quote.total_msat)}</dd>
            </dl>
            <div class="composer-bar">
              <button type="button" class="link" data-porch-back disabled={busy()} onClick={() => setReview(null)}>Back</button>
              <span class="basis">You pay the real fee, never above this.</span>
              <button type="button" class="primary soft money" data-porch-confirm disabled={busy() || props.moneyBlocked} onClick={() => void confirm()}>
                Confirm and pay
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={busy()}>
        <p class="hint" data-porch-busy>Asking their node…</p>
      </Show>
      <Show when={error()}>{(m) => <SoftError message={m()} data="porch-error" />}</Show>

      <Show when={shown()}>
        {(s) => (
          <section class="porch-reader" data-porch-reader={s().peer}>
            <Show when={s().card}>
              {(card) => (
                <>
                  <Show when={card().cached}>
                    <p class="hint" data-porch-cached>
                      Cached · held by your node from an earlier read, signature checked. Refresh pays for a new read.
                    </p>
                  </Show>
                  <Show when={card().stale}>
                    <p class="hint" data-porch-stale>
                      Their node served an older card than the one your node holds. Showing what they served.
                    </p>
                  </Show>
                  <FrontDoorCardView card={card()} now={props.now} />
                  <Show when={card().cached && offers(s().peer)}>
                    <button type="button" class="link" data-porch-refresh disabled={busy() || props.moneyBlocked} onClick={() => void ask(s().peer, PORCH_CARD_PATH)}>
                      Refresh · {cost(s().peer)}
                    </button>
                  </Show>
                </>
              )}
            </Show>
            <Show when={offers(s().peer)}>
              <div class="porch-pages" data-porch-pages>
                <For each={pagesOf(s().card)}>
                  {(path) => (
                    <button type="button" class="link" data-porch-page-read={path} disabled={busy() || props.moneyBlocked} onClick={() => void ask(s().peer, path)}>
                      Read {path} · {cost(s().peer)}
                    </button>
                  )}
                </For>
                <form
                  class="porch-other"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const path = otherPath();
                    if (path) void ask(s().peer, path);
                  }}
                >
                  <input data-porch-path placeholder="Another page, e.g. notes.md" value={other()} onInput={(e) => setOther(e.currentTarget.value)} aria-label="Page" />
                  <button type="submit" class="link" data-porch-path-read disabled={busy() || props.moneyBlocked || otherPath() === null}>
                    Read · {cost(s().peer)}
                  </button>
                </form>
                <Show when={other().trim() && otherPath() === null}>
                  <p class="hint" data-porch-path-hint>A page is a single .md or .txt file name, like notes.md.</p>
                </Show>
              </div>
            </Show>
            <Show when={s().page}>{(page) => <PorchPageView page={page()} />}</Show>
          </section>
        )}
      </Show>

      <Show when={held().length > 0}>
        <div class="porch-held" data-porch-held>
          <h3>Cards your node holds</h3>
          <ul>
            <For each={held()}>
              {(c) => (
                <li data-porch-held-card={c.node_id.toLowerCase()}>
                  <span class="name">{props.nameOf(c.node_id)}</span>
                  <span class="meta">Cached{c.fresh ? '' : ' · expired'}</span>
                  <button type="button" class="link" data-porch-held-open onClick={() => setShown({ peer: c.node_id.toLowerCase(), card: c, page: null })}>
                    Open
                  </button>
                  <Show when={offers(c.node_id)}>
                    <button type="button" class="link" data-porch-held-refresh disabled={busy() || props.moneyBlocked} onClick={() => void ask(c.node_id, PORCH_CARD_PATH)}>
                      Refresh · {cost(c.node_id)}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

function PorchPageView(props: { page: PorchRead }) {
  const p = () => props.page;
  return (
    <article class="porch-page" data-porch-page={p().path} data-porch-kind={p().kind}>
      <p class="meta">
        {p().path} · paid {fmtAmount(p().amount_msat)}
      </p>
      <Switch>
        <Match when={p().status === 'not_found'}>
          <p class="hint" data-porch-not-found>
            Their node has no page at {p().path}. The read was still paid.
          </p>
        </Match>
        <Match when={p().status !== 'ok'}>
          <p class="hint" data-porch-unavailable>
            Their node could not serve {p().path} right now. The read was still paid.
          </p>
        </Match>
        <Match when={p().kind === 'markdown'}>
          <For each={parseMarkdown(p().body)}>{(b) => <BlockView block={b} />}</For>
        </Match>
        <Match when={p().kind === 'text'}>
          <pre class="porch-text">{cleanText(p().body)}</pre>
        </Match>
      </Switch>
    </article>
  );
}

function BlockView(props: { block: Block }): JSX.Element {
  const b = props.block;
  switch (b.t) {
    case 'h':
      return b.level === 1 ? <h3><Runs runs={b.inline} /></h3> : b.level === 2 ? <h4><Runs runs={b.inline} /></h4> : <h5><Runs runs={b.inline} /></h5>;
    case 'p':
      return <p><Runs runs={b.inline} /></p>;
    case 'quote':
      return <blockquote><Runs runs={b.inline} /></blockquote>;
    case 'code':
      return <pre class="porch-text"><code>{b.text}</code></pre>;
    case 'hr':
      return <hr />;
    case 'list':
      return b.ordered ? (
        <ol><For each={b.items}>{(item) => <li><Runs runs={item} /></li>}</For></ol>
      ) : (
        <ul><For each={b.items}>{(item) => <li><Runs runs={item} /></li>}</For></ul>
      );
  }
}

function Runs(props: { runs: Inline[] }) {
  return (
    <For each={props.runs}>
      {(r) => {
        switch (r.t) {
          case 'code':
            return <code>{r.text}</code>;
          case 'strong':
            return <strong>{r.text}</strong>;
          case 'em':
            return <em>{r.text}</em>;
          case 'link':
            return (
              <span class="porch-link" data-porch-link>
                {r.text}
                <Show when={r.url && r.url !== r.text}>
                  <span class="meta"> ({r.url})</span>
                </Show>
              </span>
            );
          case 'image':
            return <span class="meta" data-porch-image>[image{r.text ? `: ${r.text}` : ''}]</span>;
          default:
            return <>{r.text}</>;
        }
      }}
    </For>
  );
}
