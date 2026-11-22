import type { JSX } from 'solid-js';
import { t as tr } from '../i18n';

/**
 * For whoever set up the box: the node's exact words or line, closed by
 * default under Details. The default screen around it says what is needed in
 * plain words and never names a command, a terminal or a file path.
 */
export function OperatorDetails(props: { children: JSX.Element }) {
  return <details class="quiet-detail" data-approval-operator>
    <summary>{tr('uiDetails')}</summary>
    {props.children}
  </details>;
}
