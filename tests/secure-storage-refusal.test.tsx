import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { copy, setLanguagePref } from '../src/i18n';
import { Onboarding } from '../src/onboarding/Onboarding';
import { connectionErrorDetail, type NodeStatus, type PairingView } from '../src/onboarding/pairing';

const EN = 'This Mac has no Secure Enclave, so BitSov cannot store your pairing key safely in this test build. Nothing was saved. Use a Mac with Apple silicon or a T2 chip, or a signed BitSov build.';
const DA = 'Denne Mac har ingen Secure Enclave, så BitSov kan ikke gemme din parringsnøgle sikkert i denne testudgave. Intet er gemt. Brug en Mac med Apple silicon eller T2-chip, eller en signeret BitSov-udgave.';
const key = (locale: 'en' | 'da', name: string) => (copy[locale] as Record<string, string>)[name];

const failed: PairingView = {
  remote: true, state: 'failed', scopes: [], short_code: null, code_from_node: false,
  reason: 'This Mac has no Secure Enclave, so BitSov cannot store its pairing key safely. Nothing was saved.',
  bootstrap: null,
};
const refusedBy = (detail: string): NodeStatus => ({
  ready: false, node_id: null, error: failed.reason,
  connection_error: { kind: 'secure_storage_unavailable', detail },
});

let mount: HTMLDivElement | undefined;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); mount?.remove(); dispose = mount = undefined; setLanguagePref('system'); });

function show(status: NodeStatus) {
  mount = document.createElement('div');
  document.body.append(mount);
  dispose = render(() => <Onboarding status={() => status} pairing={() => failed} trustAck={() => false}
    onRetry={() => { throw new Error('no retry offered'); }} selectedTarget="network" />, mount);
  return mount.querySelector<HTMLElement>('[data-pairing="secure-storage-unavailable"]');
}

describe('a Mac without a Secure Enclave', () => {
  it('has the decided copy in English and Danish', () => {
    expect(key('en', 'pairing.secureStorageUnavailable')).toBe(EN);
    expect(key('da', 'pairing.secureStorageUnavailable')).toBe(DA);
  });

  for (const locale of ['en', 'da'] as const) {
    it(`shows the refusal in ${locale} with no way to try again`, () => {
      setLanguagePref(locale);
      const panel = show(refusedBy('secure_storage_unavailable'));
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toContain(locale === 'en' ? EN : DA);
      expect(panel!.textContent).not.toContain(key(locale, 'pairing.secureStorageKept'));
      expect(mount!.querySelector('[data-pairing="failed"]')).toBeNull();
      expect(mount!.querySelector('[data-soft-reconnect]')).toBeNull();
      const words = [...mount!.querySelectorAll('button')].map(b => b.textContent ?? '');
      for (const word of [key(locale, 'obTryAgain'), key(locale, 'caReconnect')]) {
        expect(words.some(w => w.includes(word)), word).toBe(false);
      }
      expect(mount!.textContent).not.toMatch(/temporarily|try again|midlertidigt|prøv igen/i);
    });
  }

  it('says an existing pairing was kept, never to delete it', () => {
    setLanguagePref('en');
    const panel = show(refusedBy('secure_storage_unavailable_identity_kept'));
    expect(panel!.textContent).toContain(EN);
    expect(panel!.textContent).toContain(key('en', 'pairing.secureStorageKept'));
    expect(panel!.textContent).not.toMatch(/delete|clear/i);
  });

  it('a refused pairing-link import shows the same copy, not the code', () => {
    setLanguagePref('da');
    expect(connectionErrorDetail({ kind: 'secure_storage_unavailable', detail: 'secure_storage_unavailable' })).toBe(DA);
  });
});
