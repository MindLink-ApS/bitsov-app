import { render } from 'solid-js/web';
import { AssistantSurface } from './Assistant';
import { SitRows } from './SitRows';
import { SourceLabel } from './SourceLabel';
import { NO_ROWS_TEXT } from './rows';
import { readView } from './source';
import './assistant.css';

// Display surface only. This phase does not connect a model. The host hands
// over the rows and their source (live node or mock) via the window's
// initialization script; the page cannot choose or change either.
const root = document.getElementById('root');
if (root) {
  const view = readView();
  render(
    () => (
      <div class="assistant-page">
        <SourceLabel source={view.source} freshness={view.freshness} />
        {view.rows.length > 0 ? (
          <SitRows rows={view.rows} />
        ) : (
          <AssistantSurface text={NO_ROWS_TEXT} />
        )}
      </div>
    ),
    root,
  );
}
