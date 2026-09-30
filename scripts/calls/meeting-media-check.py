"""Real WebRTC for a 3-way mesh meeting through the app's own meeting engine
(src/control/meeting.ts).

Three isolated Chromium pages (separate browser contexts) each run
createMeetingEngine with a synthetic microphone (WebAudio tone; headless
device capture on macOS waits on a privacy prompt). Their call signals are
relayed between the pages exactly as the nodes would forward them; payment is
not exercised here (see the genome regtest `real_ldk_regtest_meeting`). ICE is
host-only on 127.0.0.1 (`iceServers: []`): no STUN request leaves the machine.

A (host) invites B and C; B joins (answers A, rings C); C joins (answers A
and B): three legs, each page with two live peer connections and audio both
ways on each. C leaves (A-B stays up), then A leaves and B's meeting ends.

Usage: python3 scripts/calls/meeting-media-check.py [--chromium PATH] [--out DIR]
Exit 0 only if every check passes. Nothing is downloaded.
"""
import argparse
import glob
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parents[2]
A_ID, B_ID, C_ID = 'a' * 64, 'b' * 64, 'c' * 64
QUOTE = {'offer_msat': 10000, 'offer_max_routing_fee_msat': 5000, 'signal_msat': 1000,
         'signal_max_routing_fee_msat': 5000, 'call_total_msat': 21000}

PAGE = """<!doctype html><meta charset=utf-8><title>meeting check</title>
<script src="meeting.js"></script>
<script>
const QUOTE = __QUOTE__;
const OWN = new URLSearchParams(location.search).get('own');
window.view = { phase: 'idle', legs: [] };
window.pcs = [];
function synthetic() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  osc.connect(dst);
  osc.start();
  return new MediaStream(dst.stream.getAudioTracks());
}
window.engine = Meeting.createMeetingEngine({
  quote: async () => ({ ok: true, value: QUOTE }),
  signal: async (peer, kind, plaintext, max) => {
    await window.relay(JSON.stringify({ peer, kind, plaintext, max }));
    const principal = kind === 400 ? 10000 : 1000;
    return { ok: true, value: { message_id: 'sig-' + kind, kind, amount_msat: principal, total_msat: principal + 5000,
      max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() } };
  },
  getUserMedia: async () => synthetic(),
  peerConnection: (cfg) => { const pc = new RTCPeerConnection(cfg); window.pcs.push(pc); return pc; },
  ownId: () => OWN,
  onView: (v) => { window.view = v; },
  onStreams: () => {},
  iceServers: () => [],
});
// What the owner was shown: every other participant at the same quote.
window.shown = () => Object.fromEntries(['a', 'b', 'c'].map((x) => [x.repeat(64), QUOTE]));
window.states = () => Object.fromEntries(window.view.legs.map((l) => [l.peer.slice(0, 1), l.state]));
window.audioIn = async () => {
  const out = [];
  for (const pc of window.pcs.filter((p) => p.connectionState === 'connected')) {
    let n = 0;
    for (const r of (await pc.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.packetsReceived;
    out.push(n);
  }
  return out;
};
</script>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chromium', default=next(iter(sorted(glob.glob(os.path.expanduser(
        '~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*')), reverse=True)), None))
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    root = Path(tempfile.mkdtemp(prefix='meeting-media-'))
    out = Path(args.out) if args.out else root
    out.mkdir(parents=True, exist_ok=True)
    esbuild = APP / 'node_modules/.bin/esbuild'
    subprocess.run([str(esbuild), str(APP / 'src/control/meeting.ts'), '--bundle', '--format=iife',
                    '--global-name=Meeting', f'--outfile={root / "meeting.js"}', '--log-level=warning'], check=True)
    (root / 'index.html').write_text(PAGE.replace('__QUOTE__', json.dumps(QUOTE)))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}/index.html'

    results, relayed, queue = [], [], []

    def check(name, ok, detail=''):
        results.append({'check': name, 'pass': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + name + (f': {detail}' if detail else ''), flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chromium, args=[
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            '--force-webrtc-ip-handling-policy=default', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'])
        pages = {}
        for me in (A_ID, B_ID, C_ID):
            page = browser.new_context(permissions=['microphone']).new_page()

            def relay(raw, me=me):
                s = json.loads(raw)
                relayed.append({'from': me[:1], 'to': s['peer'][:1], 'kind': s['kind'], 'max_msat': s['max']})
                queue.append((s['peer'], {'id': f'm{len(relayed)}', 'kind': s['kind'], 'sender': me, 'recipient': s['peer'],
                                          'timestamp': int(time.time() * 1000), 'plaintext': s['plaintext'],
                                          'payment_amount_msat': 1000}))

            page.expose_function('relay', relay)
            page.on('pageerror', lambda e, me=me: print(f'page {me[:1]} error: {e}', flush=True))
            page.goto(f'{base}?own={me}')
            pages[me] = page
        a, b, c = pages[A_ID], pages[B_ID], pages[C_ID]

        def pump(until, timeout=30.0):
            end = time.time() + timeout
            while time.time() < end:
                while queue:
                    to, message = queue.pop(0)
                    pages[to].evaluate('([m, own]) => window.engine.receive(m, own)', [message, to])
                if until():
                    return True
                a.wait_for_timeout(50)
            return False

        phase = lambda page: page.evaluate('window.view.phase')
        states = lambda page: page.evaluate('window.states()')

        t0 = time.time()
        a.evaluate('([peers]) => { window.inviting = window.engine.invite(peers, "audio", window.shown()); }', [[B_ID, C_ID]])
        check('host rings B and C', pump(lambda: phase(b) == 'invited' and phase(c) == 'invited'), f'{time.time() - t0:.2f}s')
        check('invites carry the roster [A, B, C]', a.evaluate('window.view.roster.map((x) => x[0]).join("")') == 'abc'
              and b.evaluate('window.view.roster.map((x) => x[0]).join("")') == 'abc')
        b.evaluate('() => { window.joining = window.engine.join(window.shown()); }')
        check('B joins: A-B live, C rung by B', pump(lambda: states(a).get('b') == 'live' and states(c).get('b') == 'incoming'),
              json.dumps({'a': states(a), 'b': states(b), 'c': states(c)}))
        c.evaluate('() => { window.joining = window.engine.join(window.shown()); }')
        full = pump(lambda: all(v == 'live' for pg in (a, b, c) for v in states(pg).values()))
        check('C joins: full mesh, every leg live on every side', full, json.dumps({'a': states(a), 'b': states(b), 'c': states(c)}))
        a.wait_for_timeout(2500)
        audio = {k: pg.evaluate('window.audioIn()') for k, pg in (('a', a), ('b', b), ('c', c))}
        check('audio RTP flows on all six directions', all(len(v) == 2 and all(n > 0 for n in v) for v in audio.values()), json.dumps(audio))
        kinds = sorted((r['from'], r['to'], r['kind']) for r in relayed)
        check('each leg: exactly one offer by the earlier participant and one answer',
              kinds == sorted([('a', 'b', 400), ('a', 'c', 400), ('b', 'c', 400), ('b', 'a', 401), ('c', 'a', 401), ('c', 'b', 401)]), json.dumps(relayed))

        relayed.clear()
        c.evaluate('() => { window.leaving = window.engine.leave(); }')
        stays = pump(lambda: phase(c) == 'ended' and states(a).get('c') == 'ended' and states(b).get('c') == 'ended')
        check('C leaves: its legs end, A-B stays live', stays and states(a).get('b') == 'live' and phase(a) == 'active',
              json.dumps({'a': states(a), 'b': states(b)}))
        check('C paid one hangup per live leg', sorted((r['to'], r['kind']) for r in relayed) == [('a', 403), ('b', 403)], json.dumps(relayed))
        a.evaluate('() => { window.leaving = window.engine.leave(); }')
        check('A leaves: the last leg ends and B\'s meeting ends', pump(lambda: phase(a) == 'ended' and phase(b) == 'ended'))
        paid = {k: pg.evaluate('window.view.paidMsat') for k, pg in (('a', a), ('b', b), ('c', c))}
        # Engine totals as call_signal reports them (principal + 5000 fee ceiling):
        # A 2 offers + 1 hangup; B 1 answer + 1 offer; C 2 answers + 2 hangups.
        check('engine totals per participant', paid == {'a': 36000, 'b': 21000, 'c': 24000}, json.dumps(paid))
        closed = all(pg.evaluate("window.pcs.every((p) => p.connectionState === 'closed')") for pg in (a, b, c))
        check('every peer connection is closed afterwards', closed)
        browser.close()
    server.shutdown()
    (out / 'meeting-media-check.json').write_text(json.dumps({'chromium': args.chromium, 'results': results}, indent=2))
    failed = [r for r in results if not r['pass']]
    print(f"{'PASS' if not failed else 'FAIL'} meeting-media-check: {len(results) - len(failed)}/{len(results)}; evidence {out / 'meeting-media-check.json'}")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
