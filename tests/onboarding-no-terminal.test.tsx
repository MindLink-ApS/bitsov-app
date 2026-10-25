import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { setLanguagePref } from '../src/i18n';
import { AddDevice, JoinDevice } from '../src/onboarding/AddDevice';
import { DeviceApprovals } from '../src/onboarding/DeviceApprovals';
import { InitializationRepair } from '../src/onboarding/InitializationRepair';
import { LockedNode } from '../src/onboarding/LockedNode';
import { Onboarding } from '../src/onboarding/Onboarding';
import { PhoneOnboarding } from '../src/onboarding/PhoneOnboarding';
import { RemoteOwnerCeremony } from '../src/onboarding/RemoteOwnerCeremony';
import { INITIAL_PAIRING } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); setLanguagePref('system'); });
const noop = async () => {};
const pending = { fingerprint: 'AB-CD', owner_action: 'konsensus device approve --op ab12' };
const screens: [string, () => JSX.Element][] = [
  ...(['local', 'network', 'cloud'] as const).map(target => [
    `first run: ${target}`,
    () => <Onboarding selectedTarget={target} status={() => ({ ready: false, node_id: null, error: null })}
      pairing={() => INITIAL_PAIRING} trustAck={() => false} onRetry={() => {}} />,
  ] as [string, () => JSX.Element]),
  ...(['ready', 'no-password', 'not-enrolled', 'pending-approval'] as const).map(state => [
    `locked node: ${state}`,
    () => <LockedNode state={state} pending={pending} typedUnlockSupported onUnlock={noop}
      onUnlockWithPassword={noop} onCancel={noop} />,
  ] as [string, () => JSX.Element]),
  ['initialization repair', () => <InitializationRepair repairing={false} onConfirm={noop} />],
  ['page price repair', () => <InitializationRepair priceFloor repairing={false} onConfirm={noop} />],
  ['repair in progress', () => <InitializationRepair repairing onConfirm={noop} />],
  ['locked node host error', () => <LockedNode onUnlock={noop} hostError="Unlock with konsensus start --owner-control" />],
  ['pending device approval', () => <DeviceApprovals remote
    device={{ ...pending, available: true, state: 'pending', expires_at_ms: null }}
    onRegister={noop} onCancel={noop} />],
  ['device approvals off', () => <DeviceApprovals remote
    device={{ available: true, state: 'off', fingerprint: null, owner_action: null, expires_at_ms: null,
      off_reason: 'seed_not_encrypted', off_message: 'Encrypt your recovery phrase: run konsensus seed encrypt --config <path>.' }}
    onRegister={noop} onCancel={noop} />],
  ['pairing failure', () => <Onboarding status={() => ({ ready: false, node_id: null, error: null })}
    pairing={() => ({ ...INITIAL_PAIRING, state: 'failed', reason: 'Run konsensus pair-ticket on your node.' })}
    trustAck={() => false} onRetry={() => {}} />],
  ['phone expired link', () => <PhoneOnboarding
    status={() => ({ ready: false, node_id: null, error: null,
      connection_error: { kind: 'expired', detail: 'Link expired. Run konsensus pair-ticket for a new one.' } })}
    pairing={() => INITIAL_PAIRING} device={() => null}
    preview={async () => ({ endpoint: 'box', node_id_fingerprint: 'AB-CD' })}
    connect={async () => ({ endpoint: 'box', node_id_fingerprint: 'AB-CD', restart_required: false })}
    retry={noop} forget={noop} beginJoin={async () => ({ state: 'idle' })}
    join={async () => ({ state: 'idle' })} openSettings={noop} openTailscale={noop} onDone={() => {}} />],
  ['claim-code entry', () => <JoinDevice api={async () => ({ state: 'idle' })} />],
  ['owner ticket', () => <AddDevice api={async () => ({ state: 'ticket', uri: 'bitsov://pair/example',
    expires_at: Date.now() / 1000 + 300, pending: [] })} />],
  ['box setup', () => <RemoteOwnerCeremony onComplete={() => {}} />],
];

describe.each(['en', 'da'] as const)('onboarding without terminal commands (%s)', lang => {
  it.each(screens)('%s', async (_name, screen) => {
    setLanguagePref(lang);
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(screen, root);
    // Let host status promises settle so entry forms and tickets are scanned too.
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent?.trim()).not.toBe('');
    // textContent includes collapsed details; also scan accessible copy and form values.
    const rendered = [root.textContent, ...[...root.querySelectorAll('*')].flatMap(element => [
      element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('placeholder'),
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
    ])].join(' ');
    expect(rendered).not.toMatch(/konsensus\s/i);
  });

  it('explains why an approved owner is needed in a detail', () => {
    setLanguagePref(lang);
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <LockedNode state="not-enrolled" onUnlock={noop} />, root);
    expect(root.textContent).toContain(lang === 'en'
      ? 'Your node is locked. Open BitSov on a device that is already approved as an owner, or ask whoever set up the box to unlock it.'
      : 'Din node er låst. Åbn BitSov på en enhed, der allerede er godkendt som ejer, eller bed den, der satte boksen op, om at låse den op.');
    const detail = root.querySelector('details')!;
    expect(detail.querySelector('summary')?.textContent).toBe(lang === 'en' ? 'What does this mean?' : 'Hvad betyder det?');
    detail.open = true;
    expect(detail.textContent).toContain(lang === 'en' ? 'keys locked after a restart' : 'nøgler låst efter en genstart');
    expect(detail.textContent).toContain(lang === 'en' ? 'Settings' : 'Indstillinger');
  });

  it.each([false, true])('keeps repair consent explicit and localizes the explanation (page price: %s)', priceFloor => {
    setLanguagePref(lang);
    const root = document.createElement('div');
    document.body.append(root);
    const confirm = vi.fn(noop);
    dispose = render(() => <InitializationRepair priceFloor={priceFloor} repairing={false} onConfirm={confirm} />, root);
    expect(root.textContent).toContain(lang === 'en' ? 'With your permission' : 'Med din tilladelse');
    expect(root.textContent).toContain(lang === 'en' ? 'backup' : 'sikkerhedskopi');
    expect(root.textContent).toContain(lang === 'en' ? 'ask whoever set up the box' : 'den, der satte boksen op');
    expect(root.querySelector('[data-repair-consent]')?.textContent).toBe(lang === 'en'
      ? 'I agree — update and start my node' : 'Jeg accepterer — opdater og start min node');
    root.querySelector<HTMLButtonElement>('[data-repair-decline]')!.click();
    expect(root.querySelector('[data-repair-consent]')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('replaces repair command diagnostics with help in the selected language', async () => {
    setLanguagePref(lang);
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <InitializationRepair repairing={false}
      onConfirm={async () => { throw new Error('Run konsensus repair mark-initialized --confirm'); }} />, root);
    root.querySelector<HTMLButtonElement>('[data-repair-consent]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.textContent).not.toMatch(/konsensus\s/i);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(lang === 'en' ? 'ask whoever set up the box' : 'den, der satte boksen op');
  });

  it('replaces expired-link command diagnostics with a request for a new link', async () => {
    setLanguagePref(lang);
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <Onboarding formOnly selectedTarget="network" initialPairingLink="bitsov://pair/example"
      status={() => ({ ready: false, node_id: null, error: null })} pairing={() => INITIAL_PAIRING}
      trustAck={() => false} onRetry={() => {}}
      onPreviewRemote={async () => { throw new Error('Link expired. Run konsensus pair-ticket on your node.'); }} />, root);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.textContent).not.toMatch(/konsensus\s/i);
    expect(root.textContent).toContain(lang === 'en' ? 'new pairing link' : 'nyt parringslink');
  });
});
