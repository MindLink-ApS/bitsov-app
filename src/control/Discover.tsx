import { t as tr } from '../i18n';
import { usePairingActivity } from '../pairingActivity';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { copyPlainText } from '../assistant/copy';
import { qrSvg } from '../qr';
import type { FrontDoor, FrontDoorPublish } from './types';
import type { Source } from './source';
import { amount as fmtAmount } from './format';
import { asActionError } from './state';
import { SoftError } from './SoftError';
import {
  CARD_TOO_LARGE,
  CARD_PUBLISH_BUDGET,
  dropOldestThumbsToFit,
  estimateCardBytes,
  hashText,
  MAX_CARD_BYTES,
  MAX_MEDIA_ITEMS,
  prepareAvatar,
  prepareMedia,
  safeImageMime,
  type PreparedAvatar,
  type PreparedMedia,
} from './frontDoorMedia';

/** Host prefix of the error that asks the owner for `front_door` (main.rs `FRONT_DOOR_OWNER`). */
const FRONT_DOOR_OWNER = 'front_door_owner:';

/** Split the owner request into its text and the `konsensus grant --op <id> [--config <path>]` command, if named. */
export function frontDoorOwnerAsk(message: string | null): { text: string; command: string | null } | null {
  if (!message?.startsWith(FRONT_DOOR_OWNER)) return null;
  const text = message.slice(FRONT_DOOR_OWNER.length).trim();
  // A quoted config may hold spaces, but no quote, backslash, control or
  // invisible formatting character (the node leaves such a path out), and it
  // must end the word: never a truncated half of something longer.
  const command =
    /konsensus grant --op [0-9a-f]{1,64}(?: --config (?:'[^'\\\p{Cc}\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]*'|[\w/.+:@%,=-]+)(?=\s|$))?/u.exec(text)?.[0] ??
    null;
  return { text, command };
}

/** Encoder-only QR of a share link; null when the link is too long for versions 1–30. */
function shareQr(link: string): { extent: number; path: string } | null {
  try {
    return qrSvg(link);
  } catch {
    return null;
  }
}

function FrontDoorShareQr(props: { link: string; label: string }) {
  const qr = createMemo(() => shareQr(props.link));
  return (
    <Show
      when={qr()}
      fallback={
        <p class="hint" data-fd-qr-skip>
          {tr('caThisLinkIsTooLongForAQRCopy')}</p>
      }
    >
      {(q) => (
        <svg
          class="qr"
          data-fd-qr
          viewBox={`0 0 ${q().extent} ${q().extent}`}
          shape-rendering="crispEdges"
          role="img"
          aria-label={props.label}
        >
          <rect width={q().extent} height={q().extent} fill="#ffffff" />
          <path d={q().path} fill="#000000" />
        </svg>
      )}
    </Show>
  );
}

type Props = {
  source: Source;
  now: number;
  /** After Knock dials, open the peer track for first contact. */
  onKnocked: (card: FrontDoor) => void;
};

/**
 * Discover: paste a front-door link, preview the card (with share QR), Knock via
 * the existing first-contact path (unprivileged dial, then composer quote).
 * Desktop has no camera scan — show a QR to share; paste to read.
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
      <h2>{tr('uiBrowse')}</h2>
      <p class="hint">
        {tr('caPasteAProfileLinkOrHoldUpItsQR')}</p>
      <p class="hint" data-browse-porch-hint>
        {tr('caToReadAContactSPagesOrFetchTheir')}</p>
      <label class="field">
        <span>{tr('caProfileLink')}</span>
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
          {tr('caReadCard')}</button>
      </div>
      <Show when={err()}>
        {(e) => <SoftError message={e()} data="discover-error" />}
      </Show>
      <Show when={card()} keyed>
        {(c) => <FrontDoorCardView card={c} now={props.now} shareQr />}
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
                <span>{tr('caAllowDialingTheLocalAddress')}{' '}{c().endpoint}</span>
              </label>
            </Show>
            <button
              type="button"
              class="primary"
              data-discover-knock
              disabled={opening() || (c().reach === 'local' && !localConsent())}
              onClick={() => void knock()}
            >
              {tr('caKnock')}</button>
          </>
        )}
      </Show>
      <Show when={card() && !live()}>
        <p class="hint" data-discover-stale>
          {tr('caThisCardExpiredYouCanStillReadItBut')}</p>
      </Show>
    </div>
  );
}

export function FrontDoorCardView(props: { card: FrontDoor; now: number; shareQr?: boolean }) {
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
  const copyUrl = (url: string) => {
    void copyPlainText(url).catch(() => {});
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
          <p class="hint" data-fd-claimed>
            {tr('caSelfClaimedNameOnTheirProfileCardASuggestion')}</p>
          <p class="hint" data-fd-tagline>
            {c().profile.tagline || tr(c().profile.kind === 'company' ? 'caCompanyKind' : 'caPersonKind')}
          </p>
          <p class="meta">
            {c().verified ? tr('caVerified') : tr('caUnverified')}
            {c().fresh ? '' : tr('caExpired')}
            {' · '}
            {tr('caSigned')}{' '}{daysAgo() === 0 ? tr('caToday') : tr('caDAgo', daysAgo())}
          </p>
        </div>
      </header>
      <Show when={props.shareQr && c().link}>
        <FrontDoorShareQr link={c().link} label={tr('caProfileLinkAsAQRCode')} />
      </Show>
      <Show when={c().profile.about}>
        <p data-fd-about>{c().profile.about}</p>
      </Show>
      <Show when={c().cv}>
        <p class="hint" data-fd-cv>
          {tr('caCVOnPorch')}{' '}{c().cv!.path}
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
                  data-fd-link-copy
                  onClick={() => copyUrl(l.url)}
                >
                  {tr('caCopy')}</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <dl class="prices">
        <div>
          <dt>{tr('caKnockFromCard')}</dt>
          <dd data-fd-knock-price>{fmtAmount(c().prices.admission_msat)}</dd>
        </div>
        <div>
          <dt>{tr('caMessageFromCard')}</dt>
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
  usePairingActivity(saving);
  const [sizeNote, setSizeNote] = createSignal<string | null>(null);

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

  const estimateParts = () => {
    const links =
      website().trim().length > 0 ? [{ label: tr('caWebsite'), url: website().trim() }] : [];
    return {
      display_name: name().trim() || 'x',
      tagline: tagline(),
      about: about(),
      avatar: avatar(),
      media: media(),
      links,
      cv: cvText().trim()
        ? { path: 'cv.md', hash: '0'.repeat(64), size: cvText().trim().length }
        : null,
    };
  };

  const cardBytes = createMemo(() => estimateCardBytes(estimateParts()));
  const overBudget = createMemo(() => cardBytes() > CARD_PUBLISH_BUDGET);

  const onAvatar = async (file: File | null) => {
    if (!file) return;
    setErr(null);
    setSizeNote(null);
    try {
      const prepared = await prepareAvatar(file, hashBytes);
      const fit = dropOldestThumbsToFit({ ...estimateParts(), avatar: prepared });
      setMedia(fit.media);
      setAvatar(prepared);
      if (fit.dropped > 0) {
        setSizeNote(
          tr(fit.dropped === 1 ? 'caThumbnailOne' : 'caThumbnailMany', fit.dropped, CARD_PUBLISH_BUDGET),
        );
      }
      if (fit.bytes > CARD_PUBLISH_BUDGET) setErr(CARD_TOO_LARGE());
    } catch (e) {
      setErr(asActionError(e).message);
    }
  };

  const onMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    setSizeNote(null);
    try {
      let next = [...media()];
      for (const file of Array.from(files)) {
        if (next.length >= MAX_MEDIA_ITEMS) break;
        next.push(await prepareMedia(file, file.name, hashBytes));
      }
      next = next.slice(0, MAX_MEDIA_ITEMS);
      const fit = dropOldestThumbsToFit({ ...estimateParts(), media: next });
      setMedia(fit.media);
      if (fit.dropped > 0) {
        setSizeNote(
          tr(fit.dropped === 1 ? 'caThumbnailOne' : 'caThumbnailMany', fit.dropped, CARD_PUBLISH_BUDGET),
        );
      }
      if (fit.bytes > CARD_PUBLISH_BUDGET) setErr(CARD_TOO_LARGE());
    } catch (e) {
      setErr(asActionError(e).message);
    }
  };

  const preview = createMemo((): FrontDoor | null => {
    if (!name().trim()) return null;
    const now = Math.floor(props.now / 1000);
    const links =
      website().trim().length > 0
        ? [{ label: tr('caWebsite'), url: website().trim() }]
        : [];
    const av = avatar();
    return {
      node_id: mine()?.node_id ?? '0'.repeat(64),
      network: mine()?.network ?? 'unknown',
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

  // The host's `front_door_owner` refusal: the owner must allow publishing at
  // the node. Shown as a request with the node's own command, not a failure.
  const ownerAsk = createMemo(() => frontDoorOwnerAsk(err()));

  const publish = async () => {
    if (!name().trim() || saving()) return;
    if (overBudget()) {
      setErr(CARD_TOO_LARGE());
      return;
    }
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
          ? [{ label: tr('caWebsite'), url: website().trim() }]
          : [],
      };
      if (cvText().trim()) {
        const h = await hashText(cvText().trim(), hashBytes);
        fields.cv = { path: 'cv.md', hash: h.hash, size: h.size };
        const afterCv = estimateCardBytes({
          ...estimateParts(),
          cv: fields.cv,
        });
        if (afterCv > CARD_PUBLISH_BUDGET) {
          setErr(CARD_TOO_LARGE());
          return;
        }
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
      setErr(tr('caSelectAndCopyTheLinkAbove'));
    }
  };

  return (
    <div class="panel" data-panel="front-door">
      <h2>{tr('caMyProfile')}</h2>
      <p class="hint">
        {tr('caASignedCardAnyoneMayCarryReadingItCosts')}</p>
      <label class="field">
        <span>{tr('caDisplayName')}</span>
        <input
          data-fd-edit-name
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          maxlength={48}
        />
      </label>
      <label class="field">
        <span>{tr('caTagline')}</span>
        <input
          data-fd-edit-tagline
          value={tagline()}
          onInput={(e) => setTagline(e.currentTarget.value)}
          maxlength={80}
        />
      </label>
      <label class="field">
        <span>{tr('caAbout')}</span>
        <textarea
          data-fd-edit-about
          rows={3}
          value={about()}
          onInput={(e) => setAbout(e.currentTarget.value)}
          maxlength={280}
        />
      </label>
      <label class="field">
        <span>{tr('caCVTextHashedOnTheCardPorchLater')}</span>
        <textarea
          data-fd-edit-cv
          rows={4}
          value={cvText()}
          onInput={(e) => setCvText(e.currentTarget.value)}
          maxlength={8000}
        />
      </label>
      <label class="field">
        <span>{tr('caWebsiteShownAsTextNeverOpened')}</span>
        <input
          data-fd-edit-website
          type="text"
          placeholder="example.com"
          value={website()}
          onInput={(e) => setWebsite(e.currentTarget.value)}
          maxlength={512}
        />
      </label>
      {/* The native file control is hidden: WebKit draws "Choose File / No file chosen"
          in the OS language (Danish on a Danish Mac), next to English copy. */}
      <label class="field file-pick">
        <span>{tr('caAvatar')}</span>
        <input
          class="sr-only"
          data-fd-edit-avatar
          type="file"
          accept="image/*"
          onChange={(e) => void onAvatar(e.currentTarget.files?.[0] ?? null)}
        />
        <span class="file-pick-row" aria-hidden="true">
          <span class="file-pick-btn">{tr('caChooseImage')}</span>
          <span class="hint" data-fd-avatar-state>{avatar() ? tr('caImageChosen') : tr('caNoImageChosen')}</span>
        </span>
      </label>
      <label class="field file-pick">
        <span>{tr('caMediaUpTo')}{' '}{MAX_MEDIA_ITEMS}{tr('caByHash')}</span>
        <input
          class="sr-only"
          data-fd-edit-media
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void onMedia(e.currentTarget.files)}
        />
        <span class="file-pick-row" aria-hidden="true">
          <span class="file-pick-btn">{tr('caChooseImages')}</span>
          <Show when={media().length === 0}><span class="hint">{tr('caNoImagesChosen')}</span></Show>
        </span>
        <Show when={media().length > 0}>
          <p class="hint" data-fd-media-count>
            {media().length}{' '}{tr(media().length === 1 ? 'caItemOne' : 'caItemMany')}{' '}{tr('caReady')}</p>
        </Show>
      </label>
      <p class="hint" data-fd-card-bytes data-over={overBudget() ? 'true' : 'false'}>
        {tr('caCardSize')}{' '}{cardBytes().toLocaleString()} / {CARD_PUBLISH_BUDGET.toLocaleString()} bytes
        {' '}{tr('caNodeMax')}{' '}{MAX_CARD_BYTES.toLocaleString()})
        {overBudget() ? tr('caTooLargeToPublish') : ''}
      </p>
      <Show when={sizeNote()}>
        <p class="hint" data-fd-size-note>
          {sizeNote()}
        </p>
      </Show>
      <div class="row">
        <button
          type="button"
          class="primary"
          data-fd-publish
          disabled={!name().trim() || saving() || overBudget()}
          onClick={() => void publish()}
        >
          {mine() ? tr('caUpdate') : tr('caPublish')}
        </button>
        <Show when={mine()?.link}>
          <button type="button" class="link" data-fd-copy onClick={() => void copyLink()}>
            {tr('caCopyLink')}</button>
        </Show>
      </div>
      <Show when={!ownerAsk() ? err() : null}>
        {(e) => <SoftError message={e()} data="fd-edit-error" class="hint" />}
      </Show>
      <Show when={ownerAsk()}>
        {(ask) => (
          <div class="hint" data-fd-owner-action>
            <p>{ask().text}</p>
            <Show when={ask().command}>
              <code class="mono" data-fd-owner-command>{ask().command}</code>
            </Show>
          </div>
        )}
      </Show>
      <Show when={mine()}>
        {(c) => (
          <>
            <p class="hint" data-fd-seq>
              {tr('caSeq')}{' '}{c().seq}{' '}{tr('caExpires')}{' '}{new Date(c().expires_at * 1000).toLocaleDateString()}
            </p>
            <p class="hint">{tr('caHoldThisQRUpForSomeoneToScanWith')}</p>
            <FrontDoorShareQr link={c().link} label={tr('caYourProfileLinkAsAQRCode')} />
            <code class="mono" data-fd-link>
              {c().link}
            </code>
          </>
        )}
      </Show>
      <Show when={preview()}>
        {(p) => (
          <div class="fd-preview" data-fd-preview>
            <h3>{tr('caPreview')}</h3>
            <p class="hint">{tr('caHowOthersWillSeeThisCardAfterYouPublish')}</p>
            <FrontDoorCardView card={p()} now={props.now} />
          </div>
        )}
      </Show>
    </div>
  );
}
