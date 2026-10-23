import { language, systemLanguage } from '../i18n';
import { createSignal, createUniqueId, onMount, Show } from 'solid-js';
import { usePairingActivity } from '../pairingActivity';
import { PrimaryAction } from './PrimaryAction';

/** G6 remains an explicit acknowledgement after enrollment, before the shell. */
export function PhoneTrust(props: { onContinue: () => Promise<void>; locale?: string }) {
  const da = () => (props.locale ? systemLanguage(props.locale) : language()) === 'da';
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const lineId = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  usePairingActivity(saving);
  onMount(() => heading?.focus());
  return <main class="phone-onboarding" data-phone-trust>
    <section data-phone-face data-gate="g6-remote-trust">
      <h1 ref={heading} tabindex="-1" aria-describedby={lineId}>{da() ? 'Stoler du på boksens vært?' : 'Do you trust the host of this box?'}</h1>
      <p id={lineId} class="phone-line">{da() ? 'Værten kan bruge dine indskud.' : 'The host can spend your deposits.'}</p>
      <PrimaryAction disabledReason={saving() ? (da() ? 'Vent et øjeblik…' : 'Please wait…') : undefined} onClick={() => {
        if (saving()) return;
        setSaving(true); setFailed(false);
        void props.onContinue().catch(() => setFailed(true)).finally(() => setSaving(false));
      }}>{da() ? 'Jeg forstår — fortsæt' : 'I understand — continue'}</PrimaryAction>
      <Show when={failed()}><p role="alert">{da() ? 'Kunne ikke gemme. Prøv igen.' : 'Could not save. Try again.'}</p></Show>
    </section>
    <details class="phone-options"><summary>{da() ? 'Andre muligheder' : 'Other options'}</summary>
      <h2>{da() ? 'Tillid til værten' : 'Remote trust'}</h2>
      <p>{da()
        ? 'Nøglerne ligger på den anden maskine. Alle, der kan logge ind på den, kan bruge dine indskud. Indsæt kun penge, hvis du stoler på værten.'
        : 'This node’s keys live on the remote machine. Anyone with access — whoever can log in to that computer — can spend what you deposit. Only fund a node whose host you trust.'}</p>
      <p>{da()
        ? 'Nøglerne bliver i boksen. BitSov viser aldrig din gendannelsessætning og kopierer den aldrig.'
        : 'Your keys stay in the node. BitSov never shows you your recovery phrase and never copies it anywhere.'}</p>
    </details>
  </main>;
}
