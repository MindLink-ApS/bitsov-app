import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// UI-E2E (scripts/ui-e2e-two-node.sh) only: inject tests/e2e/driver.js into
// the main page and relay one command at a time between it and the runner.
// Dev server only (`apply: 'serve'`) and only with BITSOV_UI_E2E=1, so neither
// `vite build` nor a normal `tauri dev` ever carries it.
export function uiE2eEnabled(command: string, env: Record<string, string | undefined>): boolean {
  return command === 'serve' && env.BITSOV_UI_E2E === '1';
}

function uiE2eDriver(): Plugin {
  type Waiter = (body: string) => void;
  const queue: { id: number; body: string }[] = [];
  const pollers: Waiter[] = [];
  const results = new Map<number, Waiter>();
  let next = 1;
  const read = (req: NodeJS.ReadableStream) =>
    new Promise<string>((ok) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => ok(data));
    });
  return {
    name: 'ui-e2e-driver',
    apply: (_config, { command }) => uiE2eEnabled(command, process.env),
    transformIndexHtml(html, ctx) {
      if (!(ctx.filename ?? '').endsWith('index.html')) return html;
      return html.replace('</body>', '    <script type="module" src="/tests/e2e/driver.js"></script>\n  </body>');
    },
    configureServer(server) {
      server.middlewares.use('/__e2e', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const reply = (status: number, body = '') => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(body);
        };
        if (req.method !== 'POST') return reply(405);
        if (url.pathname === '/cmd') {
          // Driver long-poll: hand over the next command, or 204 after 20 s.
          const item = queue.shift();
          if (item) return reply(200, item.body);
          const waiter: Waiter = (body) => reply(200, body);
          pollers.push(waiter);
          setTimeout(() => {
            const i = pollers.indexOf(waiter);
            if (i >= 0) { pollers.splice(i, 1); reply(204); }
          }, 20000);
          return;
        }
        if (url.pathname === '/result') {
          const body = await read(req);
          const id = JSON.parse(body).id as number;
          results.get(id)?.(body);
          results.delete(id);
          return reply(204);
        }
        if (url.pathname === '/run') {
          // Runner: one command in, the driver's result out (or 504).
          const cmd = JSON.parse(await read(req));
          const id = next++;
          const body = JSON.stringify({ ...cmd, id });
          const timeout = setTimeout(() => {
            results.delete(id);
            reply(504, JSON.stringify({ ok: false, error: 'driver did not answer' }));
          }, (cmd.args?.timeoutMs ?? 15000) + 10000);
          results.set(id, (out) => { clearTimeout(timeout); reply(200, out); });
          const poller = pollers.shift();
          if (poller) poller(body); else queue.push({ id, body });
          return;
        }
        reply(404);
      });
    },
  };
}

// The parent build process is shared with Cargo. Deliberately do not load this
// flag from Vite-only .env files, which the Rust host would not see.
export function starterBalanceFlag(env: Record<string, string | undefined>): '1' | '0' {
  return env.VITE_STARTER_BALANCE === '1' ? '1' : '0';
}

// M6 call media path (src/control/callFlags.ts): node-routed audio is the
// build default; only the exact value "webrtc" selects the pre-M6 lab path
// (scripts/calls/media-check.py). Same parent-process rule as the flag above.
export function callMediaFlag(env: Record<string, string | undefined>): 'node' | 'webrtc' {
  return env.VITE_CALL_MEDIA === 'webrtc' ? 'webrtc' : 'node';
}

// Node-routed call video stays off unless the exact value "node" is set.
// Same parent-process rule as the flags above.
export function callVideoFlag(env: Record<string, string | undefined>): 'node' | 'off' {
  return env.VITE_CALL_VIDEO === 'node' ? 'node' : 'off';
}

const root = dirname(fileURLToPath(import.meta.url));

// The app's build identity, shown and copied in the Node panel (M6 P2: freeze
// the exact app and node pair). CI's GITHUB_SHA wins; else the local checkout's
// HEAD, with "-dirty" when it has uncommitted changes (never on CI); else
// "unknown". Display only: nothing reads it to decide anything.
const COMMIT = /^[0-9a-f]{7,40}$/i;
export type Git = (args: string[]) => string;
const runGit: Git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
export function appCommit(env: Record<string, string | undefined>, git: Git = runGit): string {
  const ci = env.GITHUB_SHA?.trim() ?? '';
  if (COMMIT.test(ci)) return ci.slice(0, 12).toLowerCase();
  let commit: string;
  try { commit = git(['rev-parse', '--short=12', 'HEAD']).trim().toLowerCase(); } catch { return 'unknown'; }
  if (!COMMIT.test(commit)) return 'unknown';
  if (env.CI) return commit;
  try { if (git(['status', '--porcelain']).trim() !== '') commit += '-dirty'; } catch { /* the commit alone */ }
  return commit;
}
export function appVersion(): string {
  try { return String(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? 'unknown'); } catch { return 'unknown'; }
}

// Tauri CLI hooks always set TAURI_ENV_PLATFORM, and set TAURI_ENV_DEBUG=true
// only for a debug build; a release `tauri build` leaves it unset (never
// "false"). Under Tauri, include the assistant page only when debug, so a
// release bundle does not embed it (scripts/check-mac-bundle.sh verifies). A
// plain `npm run build` (the CI compile gate) runs outside Tauri and still
// builds the page.
export function assistantIncluded(env: Record<string, string | undefined>): boolean {
  if (env.TAURI_ENV_PLATFORM === undefined) return true;
  return env.TAURI_ENV_DEBUG === 'true';
}

const input: Record<string, string> = {
  main: resolve(root, 'index.html'),
};
if (assistantIncluded(process.env)) {
  input.assistant = resolve(root, 'assistant.html');
}

// The dev server port. 1420 matches tauri.conf.json devUrl. The real-window
// harness moves it with BITSOV_VITE_PORT (and a matching devUrl in its own
// --config) so a test run never collides with another dev server. Anything but
// a plain port number 1024-65535 keeps 1420.
export function devPort(env: Record<string, string | undefined>): number {
  const raw = env.BITSOV_VITE_PORT?.trim() ?? '';
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) return 1420;
  const port = Number(raw);
  return port >= 1024 && port <= 65535 ? port : 1420;
}

// Tauri desktop dev server. strictPort: a taken port fails instead of moving,
// so devUrl always matches.
// The assistant entry is not the window Tauri shows at startup.
export default defineConfig({
  define: {
    'import.meta.env.VITE_STARTER_BALANCE': JSON.stringify(starterBalanceFlag(process.env)),
    'import.meta.env.VITE_CALL_MEDIA': JSON.stringify(callMediaFlag(process.env)),
    'import.meta.env.VITE_CALL_VIDEO': JSON.stringify(callVideoFlag(process.env)),
    __APP_COMMIT__: JSON.stringify(appCommit(process.env)),
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  plugins: [solid(), assistantDevCsp(), uiE2eDriver()],
  clearScreen: false,
  server: { port: devPort(process.env), strictPort: true },
  build: {
    rollupOptions: { input },
  },
});
