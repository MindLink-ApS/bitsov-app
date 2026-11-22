import { invoke } from '@tauri-apps/api/core';
import { Show, createSignal } from 'solid-js';
import { t as tr } from '../i18n';
import { appPlatform, isMobilePlatform } from '../platform';
import { permissionPlace, type CallMedia } from './call';

/**
 * The microphone (or camera) was refused when Call or Accept was tapped.
 * Nothing was sent or paid; this says where to allow it. Phones get a button
 * to the app's own settings page (a fixed destination); desktop names the place.
 */
export function MicAccessNote(props: { media: CallMedia; openSettings?: () => Promise<void> }) {
  const [failed, setFailed] = createSignal(false);
  const open = props.openSettings ?? (() => invoke<void>('open_app_settings'));
  const video = () => props.media === 'video';
  return (
    <section class="call-permission" role="alert" data-call-permission={props.media}>
      <strong data-call-permission-title>{tr(video() ? 'caMicCameraAccessTitle' : 'caMicAccessTitle')}</strong>
      <p class="hint" data-call-permission-steps>
        {tr('caMicAccessSteps', tr(video() ? 'caMicCameraPane' : 'caMicPane'), permissionPlace(appPlatform()))}
      </p>
      <p class="hint" data-call-permission-nothing>{tr('caNothingSentOrPaid')}</p>
      <Show when={isMobilePlatform() || props.openSettings}>
        <button type="button" class="primary soft" data-call-permission-open disabled={failed()}
          onClick={() => { void open().catch(() => setFailed(true)); }}>{tr('caOpenSettings')}</button>
      </Show>
    </section>
  );
}
