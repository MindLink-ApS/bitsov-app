import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';

// Vite dev injects CSS as inline style tags. Relax style-src only while the
// dev server is serving assistant.html. `vite build` leaves the strict policy
// in the file.
function assistantDevCsp(): Plugin {
  return {
    name: 'assistant-dev-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.filename ?? '';
        if (!file.endsWith('assistant.html')) return html;
        if (!ctx.server) return html;
        return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
      },
    },
  };
}

const root = dirname(fileURLToPath(import.meta.url));

// `tauri build` sets TAURI_ENV_DEBUG=false for a release bundle. Omit the
// assistant page then so it is not embedded. A plain `npm run build` (the CI
// compile gate) leaves the variable unset and still builds the page.
const includeAssistant = process.env.TAURI_ENV_DEBUG !== 'false';
const input: Record<string, string> = {
  main: resolve(root, 'index.html'),
};
if (includeAssistant) {
  input.assistant = resolve(root, 'assistant.html');
}

// Tauri desktop dev server. Fixed port so tauri.conf.json devUrl matches.
// The assistant entry is not the window Tauri shows at startup.
export default defineConfig({
  plugins: [solid(), assistantDevCsp()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: { input },
  },
});
