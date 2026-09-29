import { For, Show, createMemo, createSignal } from 'solid-js';
import type { FrontDoor, FrontDoorPublish } from './types';
import type { Source } from './source';
import { amount as fmtAmount } from './format';
import { asActionError } from './state';
import {
  hashText,
  MAX_MEDIA_ITEMS,
  prepareAvatar,
  prepareMedia,
  safeImageMime,
  type PreparedAvatar,
  type PreparedMedia,
} from './frontDoorMedia';

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
              Knock
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
  const avatarSrc = () => {
    const a = c().profile.avatar;
    if (!a?.inline_b64) return null;
    const mime = safeImageMime(a.mime);
    if (!mime) return null;
    return `data:${mime};base64,${a.inline_b64}`;
  };
  const daysAgo = () => {
    const secs = Math.max(0, Math.floor(props.now / 1000) - c().issued_at);
    return Math.max(0, Math.floor(secs / 86400));
  };
  const openLink = (url: string) => {
    // Explicit user action only — never auto-fetched. noopener so the remote
    // page cannot script us back.
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  return (
    <article class="front-door-card" data-front-door-card>
      <header class="row">
        <Show
          when={avatarSrc()}
          fallback={
            <span class="avatar-mark" aria-hidden="true">
              {c().profile.display_name.slice(0, 2).toUpperCase()}
            </span>
          }
        >
          {(src) => <img class="avatar-img" alt="" src={src()} data-fd-avatar />}
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
            {(m) => {
              const thumb = () => {
                if (!m.thumb_b64) return null;
                const mime = safeImageMime(m.mime);
                if (!mime) return null;
                return `data:${mime};base64,${m.thumb_b64}`;
              };
              return (
                <figure>
                  <Show when={thumb()} fallback={<span class="thumb-ph">{m.title || m.mime}</span>}>
                    {(src) => <img alt={m.title} src={src()} />}
                  </Show>
                  <figcaption>{m.title || m.mime}</figcaption>
                </figure>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={c().links.length > 0}>
        <ul class="fd-links" data-fd-links>
          <For each={c().links}>
            {(l) => (
              <li>
                <span class="fd-link-label">{l.label}: </span>
                <code class="mono" data-fd-link-url>
                  {l.url}
                </code>
                <button
                  type="button"
                  class="link"
                  data-fd-link-open
                  onClick={() => openLink(l.url)}
                >
                  Open
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <dl class="prices">
        <div>
          <dt>Knock (from card)</dt>
          <dd data-fd-knock-price>{fmtAmount(c().prices.admission_msat)}</dd>
        </div>
        <div>
          <dt>Message (from card)</dt>
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
  const [cvText, setCvText] = createSignal('');
  const [website, setWebsite] = createSignal('');
  const [avatar, setAvatar] = createSignal<PreparedAvatar | null>(null);
  const [media, setMedia] = createSignal<PreparedMedia[]>([]);
  const [saving, setSaving] = createSignal(false);

  const load = () => {
    setErr(null);
    props.source.frontDoorMine().then(
      (c) => {
        setMine(c);
        setName(c.profile.display_name);
        setTagline(c.profile.tagline);
        setAbout(c.profile.about);
        setWebsite(c.links.find((l) => l.label.toLowerCase() === 'website')?.url ?? c.links[0]?.url ?? '');
        if (c.profile.avatar) {
          setAvatar({
            inline_b64: c.profile.avatar.inline_b64,
            hash: c.profile.avatar.hash ?? '',
            size: c.profile.avatar.size ?? 0,
            mime: c.profile.avatar.mime ?? 'image/jpeg',
          });
        }
        setMedia(c.media.map((m) => ({ ...m })));
      },
      (e) => {
        setMine(null);
        const m = asActionError(e).message;
        if (!m.includes('front_door_missing')) setErr(m);
      },
    );
  };
  load();

  const hashBytes = (b64: string) => props.source.frontDoorHashBytes(b64);

  const onAvatar = async (file: File | null) => {
    if (!file) return;
    setErr(null);
    try {
      setAvatar(await prepareAvatar(file, hashBytes));
    } catch (e) {
      setErr(asActionError(e).message);
    }
  };

  const onMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      const next = [...media()];
      for (const file of Array.from(files)) {
        if (next.length >= MAX_MEDIA_ITEMS) break;
        next.push(await prepareMedia(file, file.name, hashBytes));
      }
      setMedia(next.slice(0, MAX_MEDIA_ITEMS));
    } catch (e) {
      setErr(asActionError(e).message);
    }
  };

  const preview = createMemo((): FrontDoor | null => {
    if (!name().trim()) return null;
    const now = Math.floor(props.now / 1000);
    const links =
      website().trim().length > 0
        ? [{ label: 'Website', url: website().trim() }]
        : [];
    const av = avatar();
    return {
      node_id: mine()?.node_id ?? '0'.repeat(64),
      network: mine()?.network ?? 'regtest',
      endpoint: mine()?.endpoint ?? 'local',
      reach: mine()?.reach ?? 'public',
      seq: mine()?.seq ?? 0,
      issued_at: now,
      expires_at: now + 7 * 24 * 3600,
      prices: mine()?.prices ?? {
        admission_msat: 100_000,
        message_msat: 10_000,
        page_msat: 1_000,
        price_epoch: 0,
      },
      profile: {
        kind: 'person',
        display_name: name().trim(),
        tagline: tagline(),
        about: about(),
        avatar: av
          ? {
              inline_b64: av.inline_b64,
              hash: av.hash || undefined,
              size: av.size || undefined,
              mime: av.mime,
            }
          : undefined,
      },
      cv: cvText().trim()
        ? { path: 'cv.md', hash: 'preview', size: cvText().trim().length }
        : undefined,
      media: media(),
      links,
      link: mine()?.link ?? 'bitsov://front-door#preview',
      verified: true,
      fresh: true,
    };
  });

  const publish = async () => {
    if (!name().trim() || saving()) return;
    setSaving(true);
    setErr(null);
    try {
      const fields: FrontDoorPublish = {
        display_name: name().trim(),
        tagline: tagline(),
        about: about(),
        avatar: avatar()
          ? {
              inline_b64: avatar()!.inline_b64,
              hash: avatar()!.hash || undefined,
              size: avatar()!.size || undefined,
              mime: avatar()!.mime,
            }
          : undefined,
        media: media(),
        links: website().trim()
          ? [{ label: 'Website', url: website().trim() }]
          : [],
      };
      if (cvText().trim()) {
        const h = await hashText(cvText().trim(), hashBytes);
        fields.cv = { path: 'cv.md', hash: h.hash, size: h.size };
      }
      const c = await props.source.frontDoorPublish(fields);
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
        price. Media is hashed locally; large images stay off the card.
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
      <label class="field">
        <span>CV text (hashed on the card; porch later)</span>
        <textarea
          data-fd-edit-cv
          rows={4}
          value={cvText()}
          onInput={(e) => setCvText(e.currentTarget.value)}
          maxlength={8000}
        />
      </label>
      <label class="field">
        <span>Website (shown as text; never auto-opened)</span>
        <input
          data-fd-edit-website
          type="url"
          placeholder={'https' + '://'}
          value={website()}
          onInput={(e) => setWebsite(e.currentTarget.value)}
          maxlength={512}
        />
      </label>
      <label class="field">
        <span>Avatar</span>
        <input
          data-fd-edit-avatar
          type="file"
          accept="image/*"
          onChange={(e) => void onAvatar(e.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <label class="field">
        <span>Media (up to {MAX_MEDIA_ITEMS}, by hash)</span>
        <input
          data-fd-edit-media
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void onMedia(e.currentTarget.files)}
        />
        <Show when={media().length > 0}>
          <p class="hint" data-fd-media-count>
            {media().length} item{media().length === 1 ? '' : 's'} ready
          </p>
        </Show>
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
      <Show when={preview()}>
        {(p) => (
          <div class="fd-preview" data-fd-preview>
            <h3>Preview</h3>
            <p class="hint">How others will see this card after you publish.</p>
            <FrontDoorCardView card={p()} now={props.now} />
          </div>
        )}
      </Show>
    </div>
  );
}
