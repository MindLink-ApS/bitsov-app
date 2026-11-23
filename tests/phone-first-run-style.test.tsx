import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { Onboarding } from '../src/onboarding/Onboarding';
import { INITIAL_PAIRING, type NodeStatus, type PairingView } from '../src/onboarding/pairing';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; });

const offline: NodeStatus = { ready: false, node_id: null, error: null };
const starting: PairingView = { ...INITIAL_PAIRING, state: 'starting', remote: false };
const show = (pairing: PairingView, opts: { phone?: boolean; scan?: boolean; status?: NodeStatus } = {}) => {
  const phone = opts.phone ?? true;
  dispose = render(() => <Onboarding status={() => opts.status ?? offline} pairing={() => pairing} trustAck={() => false} onRetry={() => {}}
    selectedTarget="network" phone={phone} mobile={phone}
    onScanRemote={opts.scan === false ? undefined : async () => 'bitsov://pair/x'}
    onPreviewRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd' })} onImportRemote={async () => ({ endpoint: 'home:4242', node_id_fingerprint: 'ab…cd', restart_required: false })} />, document.body);
  return {
    primaries: () => [...document.querySelectorAll<HTMLButtonElement>('button.primary')],
    scan: () => document.querySelector<HTMLButtonElement>('[data-scan-pairing-qr]'),
    submit: () => document.querySelector<HTMLButtonElement>('form[data-remote-access] button[type="submit"]')!,
  };
};

describe('general first run on a phone wears the phone flow face', () => {
  it('makes Scan the one primary action before pairing', () => {
    const ui = show(starting);
    expect(ui.primaries()).toEqual([ui.scan()]);
    expect(ui.submit().classList.contains('quiet')).toBe(true);
  });

  it('hands the primary to Review once a link is typed', () => {
    const ui = show(starting);
    const input = document.querySelector<HTMLInputElement>('#remote-pairing-link')!;
    input.value = 'bitsov://pair/typed';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(ui.primaries()).toEqual([ui.submit()]);
    expect(ui.scan()!.classList.contains('quiet')).toBe(true);
  });

  it.each(['paired', 'fallback', 'failed'] as const)('keeps Scan secondary when pairing is %s', state => {
    const ui = show({ ...starting, state, remote: true }, { status: { ready: state !== 'failed', node_id: state !== 'failed' ? 'ab'.repeat(32) : null, error: null } });
    expect(ui.scan()!.classList.contains('primary')).toBe(false);
    expect(ui.submit().classList.contains('primary')).toBe(false);
  });

  it('keeps Review primary on a phone without a scanner', () => {
    const ui = show(starting, { scan: false });
    expect(ui.scan()).toBeNull();
    expect(ui.primaries()).toEqual([ui.submit()]);
  });

  it('leaves the desktop first run as it was', () => {
    const ui = show(starting, { phone: false });
    expect(ui.scan()!.classList.contains('quiet')).toBe(true);
    expect(ui.primaries()).toEqual([ui.submit()]);
  });
});
