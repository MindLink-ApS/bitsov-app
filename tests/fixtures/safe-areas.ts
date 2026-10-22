import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { LockedNode, RememberUnlock } from '../../src/onboarding/LockedNode';
import '../../src/styles.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.platform = params.get('platform') ?? 'ios';
document.documentElement.dataset.theme = 'light';
if (params.get('surface') === 'meeting') {
  const panel = document.querySelector('.call-panel')!;
  panel.classList.add('meeting-panel');
  panel.removeAttribute('data-call-panel');
  panel.setAttribute('data-meeting-panel', 'planning');
  panel.innerHTML = `<header><strong>Static meeting preview</strong></header><ul class="meeting-legs">${Array.from({ length: 12 }, (_, i) => `<li><label><input type="checkbox">Sample contact ${i + 1}</label></li>`).join('')}</ul><p>Preview only · no meeting started</p>`;
}

const surface = params.get('surface');
if (surface === 'locked' || surface === 'remember') {
  const root = document.getElementById('root')!;
  root.replaceChildren();
  root.inert = true;
  // Real gate markup with inert controls and no host/API callbacks.
  render(() => surface === 'locked'
    ? createComponent(LockedNode, { mobile: true, platform: 'ios', onUnlock: async () => {} })
    : createComponent(RememberUnlock, { mobile: true, platform: 'ios', onChoose: async () => {}, onDone: () => {} }), root);
}
if (surface === 'banner' || surface === 'reviewing') {
  document.getElementById('root')!.innerHTML = `<div class="pairing-link-layer ${surface === 'reviewing' ? 'reviewing' : ''}" inert>
    <aside class="panel pairing-link-banner"><h2>Static incoming link preview</h2><button>Dismiss</button></aside>
    ${surface === 'reviewing' ? '<div class="pairing-link-overlay"><p data-preview-content>Static endpoint review</p><button>Close pairing</button></div>' : ''}
  </div>`;
}
