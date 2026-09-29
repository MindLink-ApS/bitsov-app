"""Real WebRTC media through the app's own call engine (src/control/call.ts).

Two isolated Chromium pages (separate browser contexts) each run
createCallEngine, with a synthetic microphone and camera (WebAudio tone and
canvas video; headless device capture on macOS waits on a privacy prompt). Their call signals (400/401/403) are
relayed between the pages exactly as the node would forward them; payment is
not exercised here (see the genome regtest `real_ldk_regtest_calls`). ICE is
host-only on 127.0.0.1 (`iceServers: []`): no STUN request leaves the machine.

Usage: python3 scripts/calls/media-check.py [--chromium PATH] [--out DIR]
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
A_ID, B_ID = 'a' * 64, 'b' * 64
QUOTE = {'offer_msat': 10000, 'offer_max_routing_fee_msat': 5000, 'signal_msat': 1000,
         'signal_max_routing_fee_msat': 5000, 'call_total_msat': 21000}

PAGE = """<!doctype html><meta charset=utf-8><title>call check</title>
<script src="call.js"></script>
<script>
const QUOTE = __QUOTE__;
window.view = { phase: 'idle' };
// A synthetic source (WebAudio tone, canvas video) stands in for the
// microphone and camera: headless capture on macOS waits on a privacy prompt
// that cannot appear. The stream still goes through a real RTCPeerConnection.
function synthetic(c) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  osc.connect(dst);
  osc.start();
  const tracks = [...dst.stream.getAudioTracks()];
  if (c.video) {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const g = cv.getContext('2d');
    let n = 0;
    setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360},80%,50%)`; g.fillRect(0, 0, 320, 240); }, 33);
    tracks.push(...cv.captureStream(30).getVideoTracks());
  }
  return new MediaStream(tracks);
}
async function capture(c) {
  window.captureSource = 'synthetic';
  return synthetic(c);
}
window.engine = Calls.createCallEngine({
  quote: async () => ({ ok: true, value: QUOTE }),
  signal: async (peer, kind, plaintext, max) => {
    await window.relay(JSON.stringify({ peer, kind, plaintext, max }));
    const principal = kind === 400 ? 10000 : 1000;
    return { ok: true, value: { message_id: 'sig-' + kind, kind, amount_msat: principal, total_msat: principal + 5000,
      max_routing_fee_msat: 5000, delivered: true, accepted: true, sent_at_ms: Date.now() } };
  },
  getUserMedia: (c) => capture(c),
  peerConnection: (cfg) => (window.pc = new RTCPeerConnection(cfg)),
  now: () => Date.now(),
  onView: (v) => { window.view = v; },
  onStreams: (local, remote) => { window.local = local; window.remote = remote; },
  iceServers: () => [],
});
window.stats = async () => {
  const out = { audioIn: 0, videoIn: 0, audioOut: 0, audioLevel: null, candidate: null };
  if (!window.pc) return out;
  for (const r of (await window.pc.getStats()).values()) {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.audioIn = r.packetsReceived; out.audioLevel = r.audioLevel ?? null; }
    if (r.type === 'inbound-rtp' && r.kind === 'video') out.videoIn = r.framesDecoded ?? 0;
    if (r.type === 'outbound-rtp' && r.kind === 'audio') out.audioOut = r.packetsSent;
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) out.candidate = r.localCandidateId;
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
    root = Path(tempfile.mkdtemp(prefix='calls-media-'))
    out = Path(args.out) if args.out else root
    out.mkdir(parents=True, exist_ok=True)
    esbuild = APP / 'node_modules/.bin/esbuild'
    subprocess.run([str(esbuild), str(APP / 'src/control/call.ts'), '--bundle', '--format=iife',
                    '--global-name=Calls', f'--outfile={root / "call.js"}', '--log-level=warning'], check=True)
    (root / 'index.html').write_text(PAGE.replace('__QUOTE__', json.dumps(QUOTE)))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/index.html'

    results, relayed, queue = [], [], []
    T0 = [time.time()]

    def check(name, ok, detail=''):
        results.append({'check': name, 'pass': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + name + (f': {detail}' if detail else ''), flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chromium, args=[
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            '--force-webrtc-ip-handling-policy=default', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'])
        pages = {}
        for me, other in ((A_ID, B_ID), (B_ID, A_ID)):
            page = browser.new_context(permissions=['microphone', 'camera']).new_page()

            def relay(raw, me=me, other=other):
                s = json.loads(raw)
                relayed.append({'from': me[:4], 'kind': s['kind'], 'max_msat': s['max'], 't': round(time.time() - T0[0], 2)})
                queue.append((other, {'id': f'm{len(relayed)}', 'kind': s['kind'], 'sender': me, 'recipient': other,
                                      'timestamp': int(time.time() * 1000), 'plaintext': s['plaintext'],
                                      'payment_amount_msat': 1000}))

            page.expose_function('relay', relay)
            page.on('pageerror', lambda e, me=me: print(f'page {me[:4]} error: {e}', flush=True))
            page.goto(url)
            pages[me] = page
        a, b = pages[A_ID], pages[B_ID]

        def pump(until, timeout=20.0):
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

        for media in ('audio', 'video'):
            relayed.clear()
            t0 = time.time()
            T0[0] = t0
            a.evaluate('([peer, media, q]) => { window.placing = window.engine.place(peer, media, q); }', [B_ID, media, QUOTE])
            rang = pump(lambda: phase(b) == 'incoming')
            check(f'{media}: B rings', rang, f'{time.time() - t0:.2f}s' if rang else json.dumps(a.evaluate("({view: window.view, local: !!window.local, pc: window.pc && [window.pc.iceGatheringState, window.pc.signalingState], relayed: %d})" % len(relayed))))
            b.evaluate('() => { window.accepting = window.engine.accept(); }')
            live = pump(lambda: phase(a) == 'live' and phase(b) == 'live')
            check(f'{media}: both sides live (P2P connected)', live, f'{time.time() - t0:.2f}s from ring; capture: ' + str(a.evaluate('window.captureSource')))
            a.wait_for_timeout(2500)
            sa, sb = a.evaluate('window.stats()'), b.evaluate('window.stats()')
            check(f'{media}: audio RTP flows both ways', sa['audioIn'] > 0 and sb['audioIn'] > 0,
                  f"A received {sa['audioIn']} pkts, B received {sb['audioIn']} pkts")
            if media == 'video':
                check('video: frames decoded both ways', sa['videoIn'] > 0 and sb['videoIn'] > 0,
                      f"A decoded {sa['videoIn']}, B decoded {sb['videoIn']}")
                off = a.evaluate("""async () => {
                  const cam = window.local.getVideoTracks()[0];
                  await window.engine.toggleCamera();
                  const sender = window.pc.getSenders().find((x) => x.track === null || x.track.kind === 'video');
                  return cam.readyState === 'ended' && window.local.getVideoTracks().length === 0
                    && sender && sender.track === null && window.view.camera === false;
                }""")
                check('video: camera off stops the capture track (light off) and sends no video', off)
                before = b.evaluate('window.stats()')['videoIn']
                a.evaluate('window.engine.toggleCamera()')
                a.wait_for_timeout(1500)
                after = b.evaluate('window.stats()')['videoIn']
                back = a.evaluate("window.view.camera === true && window.local.getVideoTracks()[0].readyState === 'live'")
                check('video: camera on re-acquires and frames resume', back and after > before, f'B decoded {before} -> {after}')
            a.evaluate('window.engine.toggleMute()')
            muted = a.evaluate("window.local.getAudioTracks().every(t => !t.enabled) && window.view.muted === true")
            # Headless has no playout device, so B's audioLevel is not a measure of silence.
            check(f'{media}: mute disables the local mic track', muted, 'track-level check only')
            a.evaluate('() => { window.hanging = window.engine.hangup(); }')
            check(f'{media}: hangup ends both sides', pump(lambda: phase(a) == 'ended' and phase(b) == 'ended'))
            kinds = [r['kind'] for r in relayed]
            check(f'{media}: signals were exactly offer, answer, hangup', kinds == [400, 401, 403], json.dumps(relayed))
            paid = [a.evaluate('window.view.paidMsat'), b.evaluate('window.view.paidMsat')]
            check(f'{media}: engine totals (as reported by call_signal)', paid == [21000, 6000], f'A {paid[0]} msat, B {paid[1]} msat')
            for page in (a, b):
                page.evaluate('window.engine.dismiss()')
        browser.close()
    server.shutdown()
    (out / 'media-check.json').write_text(json.dumps({'chromium': args.chromium, 'results': results}, indent=2))
    failed = [r for r in results if not r['pass']]
    print(f"{'PASS' if not failed else 'FAIL'} media-check: {len(results) - len(failed)}/{len(results)}; evidence {out / 'media-check.json'}")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
