import { watchSystemLanguage } from './i18n';
import { render } from 'solid-js/web';
import App from './App';
import { appPlatform } from './platform';
import { applyResolvedTheme, resolveTheme, themePref, watchSystemTheme } from './control/prefs';
import { installKeyboardViewport } from './ios/keyboard';
import { installEdgeBack } from './ios/edgeBack';
import './styles.css';
import './assistant/endpoint.css';

document.documentElement.dataset.platform = appPlatform();
if (appPlatform() === 'ios') {
  const stopKeyboard = installKeyboardViewport();
  const stopBack = installEdgeBack();
  if (import.meta.hot) import.meta.hot.dispose(() => { stopKeyboard(); stopBack(); });
}
applyResolvedTheme(resolveTheme(themePref()));
watchSystemTheme();
watchSystemLanguage();

const root = document.getElementById('root');
if (root) render(() => <App />, root);
