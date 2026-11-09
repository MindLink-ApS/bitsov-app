import { invoke } from '@tauri-apps/api/core';
import { createSignal, Show } from 'solid-js';
import { language, systemLanguage, copy } from './i18n';

export function PrivacyPolicyLink(props: { locale?: string }) {
  const [failed, setFailed] = createSignal(false);
  const text = () => copy[props.locale ? systemLanguage(props.locale) : language()];
  return <p class="hint">
    <a class="link" data-privacy-policy href="#" onClick={event => {
      event.preventDefault();
      setFailed(false);
      void invoke<void>('privacy_policy_open').catch(() => setFailed(true));
    }}>{text().privacyPolicy}</a>
    <Show when={failed()}><span role="alert">{' '}{text().privacyPolicyOpenFailed}</span></Show>
  </p>;
}
