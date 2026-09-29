import { For, Show, createSignal } from 'solid-js';
import type { FrontDoor } from './types';
import type { Source } from './source';
import { amount as fmtAmount } from './format';
import { asActionError } from './state';

type Props = {
  source: Source;
  now: number;
  /** After Knock dials, open the peer track for first contact. */
  onKnocked: (card: FrontDoor) => void;
};

/**
 * Discover: paste or scan a front-door link, preview the card, Knock via the
 * existing first-contact path (unprivileged dial, then composer quote).
 */
export function DiscoverPanel(props: Props) {
  const [pasted, setPasted] = createSignal('');
  const [card, setCard] = createSignal<FrontDoor | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [opening, setOpening] = createSignal(false);
  const [localConsent, setLocalConsent] = createSignal(false);
  let readRevision = 0;

  const nowSecs = () => Math.floor(props.now / 1000);
  const live = () => {
    const c = card();
    return c && c.expires_at > nowSecs() ? c : null;
  };

  const read = () => {
    const revision = ++readRevision;
    setCard(null);
    setErr(null);
    setLocalConsent(false);
    props.source.frontDoorRead(pasted()).then(
      (c) => {
        if (revision === readRevision) setCard(c);
      },
      (e) => {
        if (revision === readRevision) setErr(asActionError(e).message);
      },
    );
  };

  const knock = async () => {
    const c = live();
    if (!c || opening()) return;
    setOpening(true);
    setErr(null);
    try {
      const opened = await props.source.frontDoorOpen(
        c.link,
        c.reach === 'local' && localConsent(),
      );
      props.onKnocked(opened);
    } catch (e) {
      setErr(asActionError(e).message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div class="panel discover" data-panel="discover">
      <h2>Discover</h2>
      <p class="hint">
        Paste a front-door link or scan a QR. Reading is free and local. Knocking uses the existing
        first-contact path — you pay their admission price once.
      </p>
      <label class="field">
        <span>Front-door link</span>
        <textarea
          data-discover-paste
          rows={3}
          value={pasted()}
          onInput={(e) => {
            setPasted(e.currentTarget.value);
            setCard(null);
            setErr(null);
          }}
          placeholder="bitsov://front-door#…"
        />
      </label>
      <div class="row">
        <button type="button" data-discover-read onClick={read} disabled={!pasted().trim()}>
          Read card
        </button>
      </div>
      <Show when={err()}>
        <p class="hint err" data-discover-error>
          {err()}
        </p>
      </Show>
      <Show when={card()} keyed>
        {(c) => <FrontDoorCardView card={c} now={props.now} />}
      </Show>
      <Show when={live()}>
        {(c) => (
          <>
            <Show when={c().reach === 'local'}>
              <label class="row check">
                <input
                  type="checkbox"
                  data-discover-local
                  checked={localConsent()}
                  onChange={(e) => setLocalConsent(e.currentTarget.checked)}
                />
                <span>Allow dialing the local address {c().endpoint}</span>
              </label>
            </Show>
            <button
              type="button"
              class="primary"
              data-discover-knock
              disabled={opening() || (c().reach === 'local' && !localConsent())}
              onClick={() => void knock()}
            >
              Knock · {fmtAmount(c().prices.admission_msat)}
            </button>
          </>
        )}
      </Show>
      <Show when={card() && !live()}>
        <p class="hint" data-discover-stale>
          This card expired. You can still read it, but Knock needs a fresh one.
        </p>
      </Show>
    </div>
  );
}

export function FrontDoorCardView(props: { card: FrontDoor; now: number }) {
  const c = () => props.card;
  const avatar = () => c().profile.avatar?.inline_b64;
  const daysAgo = () => {
    const secs = Math.max(0, Math.floor(props.now / 1000) - c().issued_at);
    return Math.max(0, Math.floor(secs / 86400));
  };
  return (
    <article class="front-door-card" data-front-door-card>
      <header class="row">
        <Show
          when={avatar()}
          fallback={
            <span class="avatar-mark" aria-hidden="true">
              {c().profile.display_name.slice(0, 2).toUpperCase()}
            </span>
          }
        >
          {(b64) => (
            <img
              class="avatar-img"
              alt=""
              src={`data:${c().profile.avatar?.mime ?? 'image/png'};base64,${b64()}`}
            />
          )}
        </Show>
        <div>
          <h3 data-fd-name>{c().profile.display_name}</h3>
          <p class="hint" data-fd-tagline>
            {c().profile.tagline || c().profile.kind}
          </p>
          <p class="meta">
            {c().verified ? 'verified' : 'unverified'}
            {c().fresh ? '' : ' · expired'}
            {' · '}
            signed {daysAgo() === 0 ? 'today' : `${daysAgo()}d ago`}
          </p>
        </div>
      </header>
      <Show when={c().profile.about}>
        <p data-fd-about>{c().profile.about}</p>
      </Show>
      <Show when={c().cv}>
        <p class="hint" data-fd-cv>
          CV on porch · {c().cv!.path}
        </p>
      </Show>
      <Show when={c().media.length > 0}>
        <div class="media-strip" data-fd-media>
          <For each={c().media}>
            {(m) => (
              <figure>
                <Show when={m.thumb_b64} fallback={<span class="thumb-ph">{m.title || m.mime}</span>}>
                  {(t) => <img alt={m.title} src={`data:${m.mime};base64,${t()}`} />}
                </Show>
                <figcaption>{m.title || m.mime}</figcaption>
              </figure>
            )}
          </For>
        </div>
      </Show>
      <dl class="prices">
        <div>
          <dt>Knock</dt>
          <dd data-fd-knock-price>{fmtAmount(c().prices.admission_msat)}</dd>
        </div>
        <div>
          <dt>Message</dt>
          <dd>{fmtAmount(c().prices.message_msat)}</dd>
        </div>
      </dl>
    </article>
  );
}

/** My front door editor for the profile/settings modal. */
export function FrontDoorEditor(props: { source: Source; now: number }) {
  const [mine, setMine] = createSignal<FrontDoor | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [name, setName] = createSignal('');
  const [tagline, setTagline] = createSignal('');
  const [about, setAbout] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  const load = () => {
    setErr(null);
    props.source.frontDoorMine().then(
      (c) => {
        setMine(c);
        setName(c.profile.display_name);
        setTagline(c.profile.tagline);
        setAbout(c.profile.about);
      },
      (e) => {
        setMine(null);
        const m = asActionError(e).message;
        if (!m.includes('front_door_missing')) setErr(m);
      },
    );
  };
  load();

  const publish = async () => {
    if (!name().trim() || saving()) return;
    setSaving(true);
    setErr(null);
    try {
      const c = await props.source.frontDoorPublish({
        display_name: name().trim(),
        tagline: tagline(),
        about: about(),
      });
      setMine(c);
    } catch (e) {
      setErr(asActionError(e).message);
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    const link = mine()?.link;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      setErr('Select and copy the link above.');
    }
  };

  return (
    <div class="panel" data-panel="front-door">
      <h2>My front door</h2>
      <p class="hint">
        A signed card anyone may carry. Reading it costs nothing. Knocking still pays your admission
        price.
      </p>
      <label class="field">
        <span>Display name</span>
        <input
          data-fd-edit-name
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          maxlength={48}
        />
      </label>
      <label class="field">
        <span>Tagline</span>
        <input
          data-fd-edit-tagline
          value={tagline()}
          onInput={(e) => setTagline(e.currentTarget.value)}
          maxlength={80}
        />
      </label>
      <label class="field">
        <span>About</span>
        <textarea
          data-fd-edit-about
          rows={3}
          value={about()}
          onInput={(e) => setAbout(e.currentTarget.value)}
          maxlength={280}
        />
      </label>
      <div class="row">
        <button
          type="button"
          class="primary"
          data-fd-publish
          disabled={!name().trim() || saving()}
          onClick={() => void publish()}
        >
          {mine() ? 'Update' : 'Publish'}
        </button>
        <Show when={mine()?.link}>
          <button type="button" class="link" data-fd-copy onClick={() => void copyLink()}>
            Copy link
          </button>
        </Show>
      </div>
      <Show when={err()}>
        <p class="hint err" data-fd-edit-error>
          {err()}
        </p>
      </Show>
      <Show when={mine()}>
        {(c) => (
          <>
            <p class="hint" data-fd-seq>
              seq {c().seq} · expires {new Date(c().expires_at * 1000).toLocaleDateString()}
            </p>
            <code class="mono" data-fd-link>
              {c().link}
            </code>
          </>
        )}
      </Show>
    </div>
  );
}
