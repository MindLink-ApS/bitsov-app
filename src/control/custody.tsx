import { Show } from 'solid-js';
import type { CustodyMode } from './types';

// Where the node's seed lives, said plainly (node REMOTE-SIGNER.md §2, §6).
// The host already strengthened unverified connections to `hosted_custody`;
// this only words the mode the host passed through.

export type CustodyBadge = { label: string; tone: 'ok' | 'warn' | 'plain'; title: string };

export function custodyBadge(mode: CustodyMode | null | undefined): CustodyBadge | null {
  switch (mode) {
    case 'local_seed':
      return {
        label: 'Seed on this machine',
        tone: 'plain',
        title: 'Your recovery phrase is stored unencrypted on this machine, in the node this app started. Any program running as you here can read it.',
      };
    case 'encrypted_seed':
      return {
        label: 'Encrypted seed',
        tone: 'ok',
        title: 'Your recovery phrase is encrypted on this machine, in the node this app started. The node unlocks it while it runs.',
      };
    case 'hosted_custody':
      return {
        label: 'Hosted custody',
        tone: 'warn',
        title: 'The seed for this node is on a server (or this connection is not proven local). Whoever runs that server can spend its bitcoin and read its messages. Move it home to hold your own keys.',
      };
    case 'money_signer':
      return {
        label: 'Money on your device',
        tone: 'warn',
        title: 'Lightning and on-chain keys, and owner approvals, stay on your device. The NodeId chat-identity private key stays on the server. Messages are stored on the server.',
      };
    case 'remote_signer':
      return {
        label: 'Your keys, remote node',
        tone: 'ok',
        title: 'Money keys, owner approvals, and the identity root stay on your device, which signs every payment and identity act. Transport and storage keys, and message plaintext, stay on the server.',
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
