import { render } from 'solid-js/web';
import { AssistantSurface } from './Assistant';
import './assistant.css';

// Display surface only. This phase does not connect a model.
const root = document.getElementById('root');
if (root) render(() => <AssistantSurface text="" />, root);
