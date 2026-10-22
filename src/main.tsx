import { watchSystemLanguage } from './i18n';
import { render } from 'solid-js/web';
import App from './App';
import { appPlatform } from './platform';
import { applyResolvedTheme, resolveTheme, themePref, watchSystemTheme } from './control/prefs';
import './styles.css';
import './assistant/endpoint.css';

document.documentElement.dataset.platform = appPlatform();
applyResolvedTheme(resolveTheme(themePref()));
watchSystemTheme();
watchSystemLanguage();

const root = document.getElementById('root');
if (root) render(() => <App />, root);
