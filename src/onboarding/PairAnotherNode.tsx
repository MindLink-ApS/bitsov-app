import { createSignal, onCleanup, Show } from 'solid-js';
import { Onboarding } from './Onboarding';
import { INITIAL_PAIRING } from './pairing';
import type { RemoteImportView, RemotePreviewView } from '../control/source';
import { shortId } from '../control/format';

/** Settings → Node, remote only: replace this app's node with another one.
 *  Like first-run import it changes only the next start, after an explicit confirmation. */
export function PairAnotherNode(props: {
  currentNodeId: () => string | null | undefined;
  currentHostedBy?: () => string | null | undefined;
  onPreview: (link: string) => Promise<RemotePreviewView>;
  onReplace: (link: string) => Promise<RemoteImportView>;
  onScan?: () => Promise<string>;
  mobile?: boolean;
  phone?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal<RemoteImportView | null>(null);
  const [pending, setPending] = createSignal<{ view: RemotePreviewView; answer: (ok: boolean) => void } | null>(null);
  const answer = (ok: boolean) => {
    const asked = pending();
    if (!asked) return;
    setPending(null);
    asked.answer(ok);
  };
  onCleanup(() => answer(false));
  const confirm = (view: RemotePreviewView) => new Promise<boolean>(resolve => {
    answer(false);
    setPending({ view, answer: resolve });
  });
  // An open question is not work in flight: closing answers it with Cancel.
  const close = () => {
    if (busy() && pending() === null) return;
    answer(false);
    setBusy(false);
    setOpen(false);
  };
  const currentLabel = () => {
    const id = props.currentNodeId();
    const host = props.currentHostedBy?.();
    const name = id ? `Node ${shortId(id)}` : 'Your current node';
    return host ? `${name} (hosted by ${host})` : name;
  };

  return <div class="pair-another-node" data-pair-another>
    <Show when={open()} fallback={<>
      <button type="button" class="quiet" data-pair-another-open disabled={saved() !== null} onClick={() => setOpen(true)}>Pair another node</button>
      <Show when={saved()} fallback={<p class="hint">Switch this app to a different node with a pairing ticket from it.</p>}>
        <p class="hint" role="status" data-pair-another-saved>New node saved. Restart BitSov to connect to it.</p>
      </Show>
    </>}>
      <Onboarding
        status={() => ({ ready: false, node_id: null, error: null })}
        pairing={() => INITIAL_PAIRING}
        trustAck={() => false}
        onRetry={() => {}}
        selectedTarget="network"
        formOnly
        pairingInputId="pair-another-link"
        onPreviewRemote={link => props.onPreview(link)}
        confirmImport={confirm}
        onImportRemote={async link => {
          const result = await props.onReplace(link);
          setSaved(result);
          return result;
        }}
        onBusyChange={setBusy}
        onScanRemote={props.onScan}
        mobile={props.mobile}
        phone={props.phone}
      />
      <Show when={pending()}>{asked => (
        <div class="panel pairing" role="alertdialog" aria-labelledby="pair-another-title" data-pair-another-confirm>
          <h2 id="pair-another-title">Replace this app’s node?</h2>
          <p><bdi data-pair-another-current>{currentLabel()}</bdi> will no longer be this app’s node.</p>
          <p>New node: <bdi>{asked().view.endpoint}</bdi>, fingerprint <bdi>{asked().view.node_id_fingerprint}</bdi>.</p>
          <p>Funds and contacts stay on the old node. You can pair back later with a new ticket from that node.</p>
          <p class="hint">Nothing changes until you confirm. The switch happens when you restart BitSov.</p>
          <div class="form-actions">
            <button type="button" class="primary" data-pair-another-confirm-yes onClick={() => answer(true)}>Replace node</button>
            <button type="button" class="quiet" data-pair-another-confirm-no onClick={() => answer(false)}>Cancel</button>
          </div>
        </div>
      )}</Show>
      <button type="button" class="quiet" data-pair-another-close disabled={busy() && pending() === null} onClick={close}>Close</button>
    </Show>
  </div>;
}
