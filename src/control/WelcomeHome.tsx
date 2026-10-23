import { t as tr } from '../i18n';
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
  const shareReason = () => !props.overview ? tr('caWaitingForYourNodeSCapabilities')
    : !props.overview.capabilities?.includes('front_door_v1') ? tr('caProfileCardsAreNotAvailableOnThisNodeYet')
    : tr('caOpenYourProfileToCreateOrShareYourCard');
  const canShare = () => props.overview?.capabilities?.includes('front_door_v1') === true;
  const canFund = () => !!props.overview?.lightning_available && props.walletReady && !props.moneyBlocked;
  const fundReason = () => props.moneyBlocked ? tr('caYourNodeSWalletIsNotReadyYet')
    : !props.overview || !props.walletReady ? tr('caWaitingForYourNodeSWallet')
    : !props.overview.lightning_available ? tr('caReceivingSatsIsNotAvailableOnThisNodeYet')
    : tr('caOpenYourWalletToReceiveBitcoin');
  return (
    <section class="welcome-home" data-welcome aria-label={tr('caWelcomeHome')}>
      <h1>{tr('caWelcomeHome')}</h1>
      <p class="hint">{tr('caStartAConversationWithSomeoneYouKnowEachMessage')}</p>
      <div class="welcome-cards">
        <article>
          <h2>{tr('caShareYourCard')}</h2>
          <p class="hint" id={`${id}-share`}>{shareReason()}</p>
          <button type="button" class="primary soft" disabled={!canShare()} aria-describedby={`${id}-share`} onClick={props.onShare}>{tr('caShareMyCardQR')}</button>
        </article>
        <article>
          <h2>{tr('caAddAContact')}</h2>
          <p class="hint" id={`${id}-contact`}>{tr('caPasteAProfileCardToPreviewItCameraScanning')}</p>
          <button type="button" class="primary soft" aria-describedby={`${id}-contact`} onClick={props.onAddContact}>{tr('caPasteAContactSCard')}</button>
        </article>
        <article>
          <h2>{tr('caAddSats')}</h2>
          <p class="hint" id={`${id}-fund`}>{fundReason()}</p>
          <button type="button" class="primary soft money" disabled={!canFund()} aria-describedby={`${id}-fund`} onClick={props.onAddSats}>{tr('caAddSats')}</button>
        </article>
      </div>
    </section>
  );
}
