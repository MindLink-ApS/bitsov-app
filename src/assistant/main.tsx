import { render } from 'solid-js/web';
import { AssistantSurface } from './Assistant';
import { SitRows } from './SitRows';
import { NO_ROWS_TEXT, readRows } from './rows';
import './assistant.css';

// Display surface only. This phase does not connect a model. Rows come from the
// in-process mock broker via the window's initialization script.
const root = document.getElementById('root');
if (root) {
  const rows = readRows();
  render(
    () => (rows.length > 0 ? <SitRows rows={rows} /> : <AssistantSurface text={NO_ROWS_TEXT} />),
    root,
  );
}
