import { createSignal, onCleanup, Show } from 'solid-js';
import { t as tr } from '../i18n';
import { appPlatform, type AppPlatform } from '../platform';
import { shortId } from './format';
import type { NodeOverview } from './types';

// M6 P2: testers on two machines read off exactly which app and node build each
// side runs, and copy it into the rehearsal record. Display only.

/** The app's short git commit from the build (`-dirty` for a local build with changes). */
export const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' && __APP_COMMIT__ ? __APP_COMMIT__ : 'unknown';
/** package.json version from the build. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown';

// Node-reported strings pass only in their known shapes, so nothing URL- or
// address-like can reach the copied block.
const word = (value: string | null | undefined, shape: RegExp) => (value && shape.test(value) ? value : null);
const capabilityList = (o: NodeOverview) => (o.capabilities ?? []).filter((c) => /^[a-z0-9_]{1,64}$/.test(c));
const apiVersion = (o: NodeOverview) => word(o.version, /^[A-Za-z0-9 ._-]{1,32}$/);
const network = (o: NodeOverview) => word(o.network, /^[a-z0-9_-]{1,32}$/i);

export type VersionsInput = { overview: NodeOverview; commit?: string; version?: string; platform?: AppPlatform; now?: Date };

/** The plain block "Copy versions" writes: fixed keys, so both sides' records line up. */
export function versionsBlock(input: VersionsInput): string {
  const o = input.overview;
  const caps = capabilityList(o);
  const rows: [string, string][] = [
    ['app_commit', input.commit ?? APP_COMMIT],
    ['app_version', input.version ?? APP_VERSION],
    ['platform', input.platform ?? appPlatform()],
    ['node_id', /^[0-9a-f]{8,128}$/i.test(o.node_id) ? shortId(o.node_id) : 'unknown'],
    ['node_api', apiVersion(o) ?? 'unknown'],
    ['node_capabilities', caps.length ? caps.join(',') : 'none'],
    ['network', network(o) ?? 'unknown'],
    ['time', (input.now ?? new Date()).toISOString()],
  ];
  return rows.map(([key, value]) => `${key}: ${value}`).join('\n');
}

/** Rows for the Node panel's facts list, next to the node's own rows. */
export function VersionRows(props: { overview: NodeOverview; commit?: string }) {
  const commit = () => props.commit ?? APP_COMMIT;
  const caps = () => capabilityList(props.overview);
  return (
    <>
      <dt>{tr('caAppBuild')}</dt>
      <dd class="id" data-version-app-build>{commit() === 'unknown' ? tr('caUnknown') : commit()}</dd>
      <dt>{tr('caNodeApi')}</dt>
      <dd data-version-node-api>{props.overview.version ?? tr('caUnknown')}</dd>
      <dt>{tr('caNodeCapabilities')}</dt>
      <dd data-version-capabilities>{caps().length ? caps().join(', ') : tr('caNone')}</dd>
      <dt>{tr('caNetwork')}</dt>
      <dd data-version-network>{network(props.overview) ?? tr('caUnknown')}</dd>
    </>
  );
}

/** "Copy versions" with a short confirmation; the clipboard write is injectable for tests. */
export function CopyVersions(props: { overview: NodeOverview; commit?: string; copy?: (text: string) => Promise<void> }) {
  const [copied, setCopied] = createSignal<'yes' | 'no' | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    const write = props.copy ?? ((text: string) => navigator.clipboard.writeText(text));
    try { await write(versionsBlock({ overview: props.overview, commit: props.commit })); setCopied('yes'); } catch { setCopied('no'); }
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(null), 4000);
  };
  return (
    <div class="row" style={{ gap: 'var(--s-2)' }}>
      <button type="button" class="link" data-versions-copy onClick={() => void copy()}>{tr('caCopyVersions')}</button>
      <Show when={copied()}>{(c) => <span class="hint" role="status" data-versions-copied>{c() === 'yes' ? tr('caCopied') : tr('caCouldNotCopy')}</span>}</Show>
    </div>
  );
}
