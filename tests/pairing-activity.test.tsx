import { createSignal, Show, type Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, it } from 'vitest';
import { PairingActivityProvider, usePairingActivity, usePairingBlocked } from '../src/pairingActivity';

it('keeps nested panel activity visible to the outer guard and releases it on unmount', () => {
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(true);
  let panelBusy: Accessor<boolean> = () => false;
  const Action = () => { usePairingActivity(busy); return <button disabled={busy()}>Action</button>; };
  const Status = () => { const blocked = usePairingBlocked(); return <p>{blocked() ? 'Blocked' : 'Available'}</p>; };
  const mount = document.createElement('div'); document.body.append(mount);
  const dispose = render(() => <PairingActivityProvider><Status /><Show when={open()}>
    <PairingActivityProvider onActivity={active => { panelBusy = active; }}><Action /></PairingActivityProvider>
  </Show></PairingActivityProvider>, mount);
  try {
    expect(mount.querySelector('p')!.textContent).toBe('Available');
    setBusy(true);
    expect(panelBusy()).toBe(true);
    expect(mount.querySelector('p')!.textContent).toBe('Blocked');
    setOpen(false);
    expect(panelBusy()).toBe(false);
    expect(mount.querySelector('p')!.textContent).toBe('Available');
    setOpen(true);
    expect(panelBusy()).toBe(true);
    expect(mount.querySelector('p')!.textContent).toBe('Blocked');
    setBusy(false);
    expect(panelBusy()).toBe(false);
    expect(mount.querySelector('p')!.textContent).toBe('Available');
  } finally { dispose(); mount.remove(); }
});
