import { Show } from 'solid-js';
import type { CustodyMode } from './types';

// Where the node's seed lives, said plainly (node REMOTE-SIGNER.md §2, §6).
// The host already made a non-loopback node `hosted_custody`; this only words it.

export type CustodyBadge = { label: string; tone: 'ok' | 'warn' | 'plain'; title: string };

export function custodyBadge(mode: CustodyMode | null | undefined): CustodyBadge | null {
  switch (mode) {
    case 'local_seed':
      return {
        label: 'Seed on this machine',
        tone: 'plain',
        title: 'Your recovery phrase is stored unencrypted on the machine running your node. Any program running as you there can read it.',
      };
    case 'encrypted_seed':
      return {
        label: 'Encrypted seed',
        tone: 'ok',
        title: 'Your recovery phrase is encrypted on the machine running your node. The node unlocks it while it runs.',
      };
    case 'hosted_custody':
      return {
        label: 'Hosted custody',
        tone: 'warn',
        title: 'The seed for this node is on a server. Whoever runs that server can spend its bitcoin and read its messages. Move it home to hold your own keys.',
      };
    case 'remote_signer':
      return {
        label: 'Your keys, remote node',
        tone: 'ok',
        title: 'Your keys stay on your device, which signs every payment. Messages are stored on the server.',
      };
    default:
      return null;
  }
}

export function CustodyBadgeView(props: { mode: CustodyMode | null | undefined }) {
  const badge = () => custodyBadge(props.mode);
  return (
    <Show when={badge()}>
      {(b) => (
        <span class={`contact-pill ${b().tone}`} data-custody={props.mode} title={b().title}>
          {b().label}
        </span>
      )}
    </Show>
  );
}
