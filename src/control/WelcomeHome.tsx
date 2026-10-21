import { createUniqueId } from 'solid-js';
import type { NodeOverview } from './types';

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
  const shareReason = () => !props.overview ? 'Waiting for your node’s capabilities.'
    : !props.overview.capabilities?.includes('front_door_v1') ? 'Profile cards are not available on this node yet.'
    : 'Open your profile to create or share your card and QR.';
  const canShare = () => props.overview?.capabilities?.includes('front_door_v1') === true;
  const canFund = () => !!props.overview?.lightning_available && props.walletReady && !props.moneyBlocked;
  const fundReason = () => props.moneyBlocked ? 'Your node’s wallet is not ready yet.'
    : !props.overview || !props.walletReady ? 'Waiting for your node’s wallet.'
    : !props.overview.lightning_available ? 'Receiving sats is not available on this node yet.'
    : 'Open your wallet to receive bitcoin.';
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
