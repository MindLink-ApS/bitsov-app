import { afterEach, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { PairSteps } from '../src/onboarding/PairSteps';
import { Onboarding } from '../src/onboarding/Onboarding';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';
import { LockedNode } from '../src/onboarding/LockedNode';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); setLanguagePref('system'); });
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
  setLanguagePref('da');
  expect(root.querySelector('[data-step="node"] .step-label')?.textContent).toBe('Start node');
  expect(root.querySelector('[data-step="node"] .step-status')?.textContent).toBe('nu');
  expect(root.querySelector('h1')?.textContent).toBe('Hvor skal din node køre?');
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
