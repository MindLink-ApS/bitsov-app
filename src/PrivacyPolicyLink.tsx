import { invoke, isTauri } from '@tauri-apps/api/core';
import { createSignal, Show } from 'solid-js';
import { language, systemLanguage, copy } from './i18n';
import policy from './privacyPolicy.json';

// TODO(website): host the Danish and English policy at /bitsov/privacy on mindlink.tech.
// This JSON is also read by the native opener; keep the URL in that one place.
export const PRIVACY_POLICY_URL = policy.url;

export function PrivacyPolicyLink(props: { locale?: string }) {
  const [failed, setFailed] = createSignal(false);
  const text = () => copy[props.locale ? systemLanguage(props.locale) : language()];
  return <p class="hint">
    <a class="link" data-privacy-policy href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (!isTauri()) return;
      event.preventDefault();
      setFailed(false);
      void invoke<void>('privacy_policy_open').catch(() => setFailed(true));
    }}>{text().privacyPolicy}</a>
    <Show when={failed()}><span role="alert">{' '}{text().privacyPolicyOpenFailed}</span></Show>
  </p>;
}
