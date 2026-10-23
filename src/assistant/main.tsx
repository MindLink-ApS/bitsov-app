import { watchSystemLanguage } from '../i18n';
import { render } from 'solid-js/web';
import { AssistantPage } from './Page';
import { readView } from './source';
import './assistant.css';
import './endpoint.css';

// Display surface only. This phase does not connect a model. The host hands
// over the rows and their source (live node or mock) via the window's
// initialization script; the page cannot choose or change either.
const root = document.getElementById('root');
if (root) {
  watchSystemLanguage();
  const view = readView();
  render(() => <AssistantPage view={view} />, root);
}
