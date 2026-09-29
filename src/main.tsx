import { render } from 'solid-js/web';
import App from './App';
import { applyResolvedTheme, resolveTheme, themePref, watchSystemTheme } from './control/prefs';
import './styles.css';
import './assistant/endpoint.css';

applyResolvedTheme(resolveTheme(themePref()));
watchSystemTheme();

const root = document.getElementById('root');
if (root) render(() => <App />, root);
