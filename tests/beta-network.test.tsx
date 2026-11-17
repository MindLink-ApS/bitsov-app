import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
let root: HTMLElement;
afterEach(() => { dispose?.(); root?.remove(); vi.unstubAllGlobals(); localStorage.clear(); setLanguagePref('en'); });

function show(refusal: string, remote = true) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'node_status') return { ready: false, node_id: null, error: null, network_refusal: refusal };
    if (cmd === 'pairing_status') return { ...INITIAL_PAIRING, remote };
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  root = document.createElement('div'); document.body.appendChild(root);
  dispose = render(() => <App />, root);
  return invoke;
}

it.each(['en', 'da'] as const)('renders each beta refusal in %s without a conversion action', async lang => {
  setLanguagePref(lang);
  const cases = [
    ['mainnet', true, lang === 'en' ? 'This test version of BitSov works only with signet test nodes.' : 'Denne testversion af BitSov virker kun med signet-testnoder.'],
    ['mainnet', false, lang === 'en' ? 'The node files in this test version are set up for Bitcoin mainnet.' : 'Nodefilerne i denne testversion er sat op til Bitcoin mainnet.'],
    ['unknown', true, lang === 'en' ? 'BitSov could not confirm that this node uses signet' : 'BitSov kunne ikke bekræfte, at noden bruger signet'],
    ['other', true, lang === 'en' ? 'BitSov could not confirm that this node uses signet' : 'BitSov kunne ikke bekræfte, at noden bruger signet'],
    ['local_unavailable', false, lang === 'en' ? 'This test version cannot create a node on this computer yet.' : 'Denne testversion kan endnu ikke oprette en node på denne computer.'],
  ] as const;
  for (const [refusal, remote, text] of cases) {
    show(refusal, remote);
    await vi.waitFor(() => expect(root.querySelector('[data-network-refusal]')?.textContent).toContain(text));
    expect(root.querySelector('[data-network-refusal] button')).toBeNull();
    expect(root.querySelector('[data-identity-gate]')).toBeNull();
    dispose?.(); root.remove();
  }
});

it.each(['en', 'da'] as const)('offers signet pairing and hides local creation when unavailable in %s', async lang => {
  setLanguagePref(lang);
  const invoke = show('local_unavailable', false);
  await vi.waitFor(() => expect(root.querySelector('[data-network-refusal]')).not.toBeNull());
  expect(root.querySelector('[data-target="local"]')).toBeNull();
  expect(root.querySelector('[data-local-setup-confirm]')).toBeNull();
  expect(root.querySelector('[data-target="network"]')?.textContent).toContain(lang === 'en' ? 'Connect to a signet node' : 'Forbind til en signet-node');
  expect(root.querySelector('[data-remote-access]')).not.toBeNull();
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'node_setup_local')).toHaveLength(0);
});

it('does not show a refusal for the product status', async () => {
  show('none', false);
  await vi.waitFor(() => expect(root.querySelector('[data-target="local"]')).not.toBeNull());
  expect(root.querySelector('[data-network-refusal]')).toBeNull();
});
