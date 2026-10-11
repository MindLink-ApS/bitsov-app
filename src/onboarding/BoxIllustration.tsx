/** Shared, decorative hardware drawing. The surrounding text names its state. */
export function BoxIllustration(props: { offline?: boolean; paired?: boolean }) {
  return <svg class="box-illustration" classList={{ offline: props.offline, paired: props.paired }}
    data-box-illustration viewBox="0 0 160 112" width="160" height="112" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path class="box-case" d="m20 40 60-24 60 24v42l-60 24-60-24Z" />
    <path d="m20 40 60 24 60-24M80 64v42" />
    <path d="m38 72 20 8m-20-1 20 8m44-8 16-6v9l-16 6Z" />
    <path class="box-sticker" d="m59 35 22-9 23 9-22 9Z" />
    <circle class="box-light" cx="128" cy="65" r="3" fill="currentColor" stroke="none" />
  </svg>;
}
