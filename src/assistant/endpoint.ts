// Which endpoint answers, who gets paid and what leaves: one vocabulary for the
// sealed assistant window and the AI track. Text only, from the host's
// `ProviderView`; nothing here reads the node or asks the host.

import type { Preset, ProviderKind, ProviderView } from '../control/types';

/** Own (green), Shared open (amber), Frontier (red). */
export type Tier = 'own' | 'shared' | 'frontier';

export type BadgeInput = Pick<ProviderView, 'kind' | 'host' | 'model' | 'pays' | 'data_leaves'>;

/** The rules on this computer: no model, nobody paid, nothing leaves. */
export const OWN_RULES: ProviderView = {
  kind: 'local',
  label: 'On this computer',
  enabled: true,
  host: null,
  model: null,
  note: null,
  pays: { to: null, rail: 'none' },
  data_leaves: null,
};

const TIER: Record<ProviderKind, Tier> = { local: 'own', shared: 'shared', frontier: 'frontier' };
const TIER_NAME: Record<Tier, string> = { own: 'Own', shared: 'Shared open', frontier: 'Frontier' };

/** What each preset lets leave, in a few words. */
export const PRESET_WORDS: Record<Preset, string> = {
  counts: 'counts only',
  rounded: 'rounded figures',
  exact: 'exact figures and node ids',
};

export type Badge = {
  tier: Tier;
  /** `Own`, `Shared open` or `Frontier`. */
  name: string;
  /** The endpoint: `On this computer · rules`, or `<model> at <host>`. */
  where: string;
  /** Who gets paid, one short phrase. */
  paid: string;
  /** What leaves the node, one short phrase. */
  leaves: string;
  /** Everything above in one line, for a tooltip and screen readers. */
  text: string;
};

/**
 * The badge for `p`. `previewed` is the preset of the latest preview shown for
 * it, when there is one; otherwise the preset a preview starts at.
 */
export function endpointBadge(p: BadgeInput, previewed: Preset | null = null): Badge {
  const tier = TIER[p.kind];
  const name = TIER_NAME[tier];
  // Own, or a remote that is off: nothing can leave and nobody is paid.
  if (tier === 'own' || p.data_leaves === null) {
    const where = tier === 'own' ? `On this computer · ${p.model ?? 'rules'}` : 'Off on this computer';
    const quiet = { tier, name, where, paid: 'Nobody is paid', leaves: 'Nothing leaves' };
    return { ...quiet, text: join(quiet) };
  }
  const where = `${p.model ?? 'model'} at ${p.host ?? 'a remote host'}`;
  const paid =
    p.pays.rail !== 'fiat' || !p.pays.to
      ? 'Nobody is paid by this app'
      : isLoopback(p.pays.to)
        ? 'Paid: your API key (local endpoint)'
        : `Paid: ${p.pays.to}, your API key`;
  const preset = previewed ?? p.data_leaves;
  const leaves =
    `Leaves: the preview you send, ${PRESET_WORDS[preset]}` + (tier === 'frontier' ? '; vendor terms apply' : '');
  const badge = { tier, name, where, paid, leaves };
  return { ...badge, text: join(badge) };
}

/** A loopback IP literal: the only plain-http host the app allows (a model server on this computer). */
function isLoopback(host: string): boolean {
  return host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** One endpoint the badge could describe, with the preset of its preview, if one is on screen. */
export type Exposure = { provider: BadgeInput; previewed: Preset | null };

const TIER_RANK: Record<Tier, number> = { own: 0, shared: 1, frontier: 2 };
const PRESET_RANK: Record<Preset, number> = { counts: 0, rounded: 1, exact: 2 };

function rank(e: Exposure): [number, number] {
  const preset = e.previewed ?? e.provider.data_leaves;
  // An endpoint that lets nothing leave ranks below every one that does.
  if (preset === null) return [-1, 0];
  return [TIER_RANK[TIER[e.provider.kind]], PRESET_RANK[preset]];
}

/**
 * The widest of `candidates`: a frontier endpoint over a shared one over Own,
 * and a wider preset over a narrower one. The header shows this, so a preview
 * still waiting for Send can never be understated by the selection.
 */
export function widestExposure(candidates: readonly Exposure[]): Exposure {
  let widest = candidates[0] ?? { provider: OWN_RULES, previewed: null };
  for (const c of candidates.slice(1)) {
    const [a, b] = [rank(c), rank(widest)];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) widest = c;
  }
  return widest;
}

function join(b: Omit<Badge, 'text'>): string {
  return `${b.name} · ${b.where} · ${b.paid} · ${b.leaves}`;
}
