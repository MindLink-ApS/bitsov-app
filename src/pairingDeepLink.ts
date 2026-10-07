import { invoke } from '@tauri-apps/api/core';

/** Poll a private, take-once native inbox; never put tickets on the event bus,
 * in browser history, persistent storage, or diagnostic output. */
export function watchPairingLinks(onLink: (link: string) => void): () => void {
  let stopped = false;
  let reading = false;
  const read = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const link = await invoke<string | null>('pairing_link_take');
      if (!stopped && typeof link === 'string') onLink(link);
    } catch { /* Retry after native startup; never log a link or native error. */ }
    finally { reading = false; }
  };
  void read();
  const timer = window.setInterval(() => void read(), 750);
  return () => { stopped = true; window.clearInterval(timer); };
}
