import { t as tr } from '../i18n';
import { onCleanup, onMount } from 'solid-js';
import { onEscape } from './escapeStack';
import { inertOutside } from './modalInert';

/**
 * "You are in a call with X. Closing BitSov drops the call. Close anyway?"
 * A real modal: everything behind it is inert while it is open (so Tab cannot
 * leave it), Escape or the scrim means Stay, and closing it returns focus to
 * whatever had it before.
 */
export function QuitConfirm(props: { name: string; onStay: () => void; onClose: () => void }) {
  let layer!: HTMLDivElement;
  const opener = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  onMount(() => {
    const release = inertOutside(layer, '[data-quit-keep]');
    layer.querySelector<HTMLElement>('[data-quit-stay]')?.focus();
    const stopEscape = onEscape(() => props.onStay());
    onCleanup(() => {
      stopEscape();
      release();
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    });
  });
  return (
    <div ref={layer} data-quit-layer>
      <div class="settings-scrim open" data-quit-scrim onClick={() => props.onStay()} />
      <div class="panel quit-confirm" role="alertdialog" aria-modal="true" aria-labelledby="quit-confirm-text" data-quit-confirm>
        <p id="quit-confirm-text">{tr('quitDuringCall', props.name)}</p>
        <div class="row" style={{ 'justify-content': 'flex-end', gap: 'var(--s-2)' }}>
          <button type="button" class="quiet" data-quit-stay onClick={() => props.onStay()}>{tr('quitStayInCall')}</button>
          <button type="button" class="danger" data-quit-yes onClick={() => props.onClose()}>{tr('quitCloseAndDrop')}</button>
        </div>
      </div>
    </div>
  );
}
