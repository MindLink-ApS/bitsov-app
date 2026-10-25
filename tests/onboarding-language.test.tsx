import { afterEach, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { PairSteps } from '../src/onboarding/PairSteps';
import { Onboarding } from '../src/onboarding/Onboarding';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';
import { LockedNode } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); setLanguagePref('system'); clearMocks(); vi.unstubAllGlobals(); });
const mount = (view: () => ReturnType<typeof PairSteps>) => {
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(view, root);
  return root;
};
it('updates step labels and accessible names without remounting', () => {
  setLanguagePref('en');
  const root = mount(() => <PairSteps current={1} secondDevice />);
  expect(root.textContent).toContain('Prepare comparison words');
  setLanguagePref('da');
  expect(root.textContent).toContain('Gør ordene klar til sammenligning');
  expect(root.querySelector('ol')?.getAttribute('aria-label')).toBe('Tilføjelse af en enhed');
  expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Gør ordene klar');
  setLanguagePref('en');
  expect(root.textContent).toContain('Prepare comparison words');
});
it('updates onboarding status labels when the language changes', () => {
  setLanguagePref('en');
  const root = mount(() => <Onboarding status={() => ({ ready: false, node_id: null, error: null })}
    pairing={() => INITIAL_PAIRING} trustAck={() => false} onRetry={() => {}} />);
  expect(root.querySelector('[data-step="node"]')?.textContent).toContain('now');
  const privacy = root.querySelector<HTMLAnchorElement>('[data-privacy-policy]');
  expect(privacy?.textContent).toBe('Privacy policy');
  expect(privacy?.href).toBe('https://mindlink.tech/bitsov/privacy');
  setLanguagePref('da');
  expect(root.querySelector('[data-step="node"] .step-label')?.textContent).toBe('Start node');
  expect(root.querySelector('[data-step="node"] .step-status')?.textContent).toBe('nu');
  expect(root.querySelector('h1')?.textContent).toBe('Hvor skal din node køre?');
  expect(privacy?.textContent).toBe('Privatlivspolitik');
});
it('localizes local ticket validation while preserving host errors', async () => {
  setLanguagePref('da');
  const root = mount(() => <Onboarding formOnly selectedTarget="network"
    initialPairingLink="not-a-ticket" status={() => ({ ready: false, node_id: null, error: null })}
    pairing={() => INITIAL_PAIRING} trustAck={() => false} onRetry={() => {}} />);
  await Promise.resolve();
  expect(root.textContent).toContain('Brug et bitsov://pair/-parringslink fra din node.');
  dispose?.();
  const message = 'Node rejected request {0}: device id å42';
  const locked = mount(() => <LockedNode onUnlock={async () => {}} hostError={message} />);
  expect(locked.querySelector('[role="alert"]')?.textContent).toBe(message);
});

it('keeps onboarding open and offers a localized retry when the native policy opener fails', async () => {
  setLanguagePref('en');
  vi.stubGlobal('isTauri', true);
  mockIPC(() => Promise.reject(new Error('native diagnostic')));
  const root = mount(() => <Onboarding status={() => ({ ready: false, node_id: null, error: null })}
    pairing={() => INITIAL_PAIRING} trustAck={() => false} onRetry={() => {}} />);
  const link = root.querySelector<HTMLAnchorElement>('[data-privacy-policy]')!;
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not open the privacy policy.'));
  expect(root.textContent).not.toContain('native diagnostic');
  setLanguagePref('da');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Kunne ikke åbne privatlivspolitikken.');
  mockIPC(() => Promise.resolve());
  link.click();
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).toBeNull());
  expect(root.querySelector('.onboarding')).not.toBeNull();
});
