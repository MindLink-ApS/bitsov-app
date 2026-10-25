import { t } from '../i18n';
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
        label: t('extraSeedOnThisMachine'),
        tone: 'warn',
        title: t('extraYourRecoveryPhraseIsStoredUnencryptedOnThis'),
      };
    case 'encrypted_seed':
      return {
        label: t('extraEncryptedSeed'),
        tone: 'ok',
        title: t('extraYourRecoveryPhraseIsEncryptedOnThisMachine'),
      };
    case 'hosted_custody':
      return {
        label: t('extraHostedCustody'),
        tone: 'warn',
        title: t('extraSeedOnAnotherComputerOrServerOrThis'),
      };
    case 'money_signer':
      return {
        label: t('extraMoneyOnYourDevice'),
        tone: 'warn',
        title: t('extraLightningAndOnChainKeysAndOwnerApprovals'),
      };
    case 'remote_signer':
      return {
        label: t('extraYourKeysRemoteNode'),
        tone: 'ok',
        title: t('extraMoneyKeysOwnerApprovalsAndTheIdentityRoot'),
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
