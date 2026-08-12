import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

// CS-1 identity screen. The Rust host bundles + supervises the node binary, mints a
// loopback JWT via /auth/local, reads /identity, and exposes the result through the
// `node_status` command. The UI only reflects that state — it never talks to the node
// directly, never handles keys, and never touches a non-loopback host (Gate G2).
type Status = { ready: boolean; node_id: string | null; error: string | null };

export default function App() {
  const [status, setStatus] = createSignal<Status>({ ready: false, node_id: null, error: null });

  let timer: number | undefined;
  const poll = async () => {
    try {
      setStatus(await invoke<Status>('node_status'));
    } catch (e) {
      setStatus({ ready: false, node_id: null, error: String(e) });
    }
  };

  onMount(() => {
    void poll();
    timer = window.setInterval(() => void poll(), 1500);
  });
  onCleanup(() => {
    if (timer) window.clearInterval(timer);
  });

  const short = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

  return (
    <main class="shell">
      <div class="mark">
        Bit<span>Sov</span>
      </div>

      <Show
        when={status().ready}
        fallback={
          <Show
            when={status().error}
            fallback={
              <div class="state">
                <div class="spinner" />
                Starting your node…
              </div>
            }
          >
            <div class="state error">
              <div>Your node didn’t start.</div>
              <code>{status().error}</code>
              <p class="hint">
                Check that the node binary is in <code>src-tauri/bin/</code> — see{' '}
                <code>bin/README.md</code>.
              </p>
            </div>
          </Show>
        }
      >
        <div class="state ready">
          <div class="dot" />
          <div>Your node is running.</div>
          <div class="node-id" title={status().node_id ?? ''}>
            {short(status().node_id ?? '')}
          </div>
          <p class="hint">
            CS-1 reached the identity screen. Funding &amp; conversation are next (M1 / M2).
          </p>
        </div>
      </Show>
    </main>
  );
}
