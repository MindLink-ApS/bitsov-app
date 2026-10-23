import { createUniqueId } from 'solid-js';
import type { NodeOverview } from './types';

/** Null means the entry is ready; shared by desktop welcome and phone entries. */
export const shareDisabledReason = (overview: NodeOverview | null): string | null => !overview
  ? 'Waiting for your node’s capabilities.'
  : !overview.capabilities?.includes('front_door_v1') ? 'Profile cards are not available on this node yet.' : null;
export const fundingDisabledReason = (overview: NodeOverview | null, walletReady: boolean, moneyBlocked: boolean): string | null => moneyBlocked
  ? 'Your node’s wallet is not ready yet.'
  : !overview || !walletReady ? 'Waiting for your node’s wallet.'
  : !overview.lightning_available ? 'Receiving sats is not available on this node yet.' : null;

/** Navigation only: no admission, payment, publication or contact creation. */
export function WelcomeHome(props: {
  overview: NodeOverview | null;
  moneyBlocked: boolean;
  walletReady: boolean;
  onShare: () => void;
  onAddContact: () => void;
  onAddSats: () => void;
}) {
  const id = createUniqueId();
  const shareReason = () => shareDisabledReason(props.overview) ?? 'Open your profile to create or share your card and QR.';
  const canShare = () => shareDisabledReason(props.overview) === null;
  const canFund = () => fundingDisabledReason(props.overview, props.walletReady, props.moneyBlocked) === null;
  const fundReason = () => fundingDisabledReason(props.overview, props.walletReady, props.moneyBlocked) ?? 'Open your wallet to receive bitcoin.';
  return (
    <section class="welcome-home" data-welcome aria-label="Welcome home">
      <h1>Welcome home</h1>
      <p class="hint">Start a conversation with someone you know. Each message requires a settled payment; you see the price before sending.</p>
      <div class="welcome-cards">
        <article>
          <h2>Share your card</h2>
          <p class="hint" id={`${id}-share`}>{shareReason()}</p>
          <button type="button" class="primary soft" disabled={!canShare()} aria-describedby={`${id}-share`} onClick={props.onShare}>Share my card / QR</button>
        </article>
        <article>
          <h2>Add a contact</h2>
          <p class="hint" id={`${id}-contact`}>Paste a profile card to preview it. Camera scanning is not available for profile cards.</p>
          <button type="button" class="primary soft" aria-describedby={`${id}-contact`} onClick={props.onAddContact}>Paste a contact’s card</button>
        </article>
        <article>
          <h2>Add sats</h2>
          <p class="hint" id={`${id}-fund`}>{fundReason()}</p>
          <button type="button" class="primary soft money" disabled={!canFund()} aria-describedby={`${id}-fund`} onClick={props.onAddSats}>Add sats</button>
        </article>
      </div>
    </section>
  );
}
