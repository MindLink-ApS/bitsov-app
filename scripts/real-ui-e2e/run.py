"""Real-node adapter for the existing real-window UI driver and evidence code."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback

app = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('real_ui_runner', app / 'scripts/ui-e2e/runner.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
root = Path(sys.argv[3]).parent
sequence = 0
started = time.monotonic()
bundle_id = 'tech.mindlink.bitsov.real-ui-e2e-' + root.name.rsplit('.',1)[-1].lower()
original_snapshot = r.snapshot


def snapshot(label):
    name = original_snapshot(label)
    helper = root/'window-id'
    if not helper.exists():
        result = subprocess.run(['swiftc','-module-cache-path',str(root/'swift-cache'),
            str(app/'scripts/real-ui-e2e/window-id.swift'),'-o',str(helper)],capture_output=True,text=True,timeout=60)
        r.evidence.write('screenshot-build.log',result.stdout+result.stderr)
    if helper.exists():
        processes = subprocess.run(['/bin/ps','-axo','pid=,ppid='],capture_output=True,text=True,timeout=5)
        tree = [tuple(map(int,line.split())) for line in processes.stdout.splitlines() if len(line.split())==2]
        owned = {r.procs['app'].pid}
        while True:
            expanded = owned | {pid for pid,parent in tree if parent in owned}
            if expanded==owned: break
            owned=expanded
        result = subprocess.run([str(helper),*map(str,owned)],capture_output=True,text=True,timeout=10)
        r.evidence.write('window-capture-probe.jsonl',{'owned_pids':sorted(owned),'exit':result.returncode,'detail':result.stderr},append=True)
        if result.returncode==0 and result.stdout.strip().isdigit():
            image = r.E/'screenshots'/f'{name}.png'
            image.parent.mkdir(exist_ok=True)
            shot = subprocess.run(['/usr/sbin/screencapture','-x','-l',result.stdout.strip(),str(image)],capture_output=True,text=True,timeout=10)
            r.evidence.write('screenshots.jsonl',{'name':name,'kind':'native-window','exit':shot.returncode,'error':shot.stderr},append=True)
            return name
    r.evidence.write('screenshots.jsonl',{'name':name,'kind':'native-window','error':'window capture unavailable; DOM snapshot retained'},append=True)
    return name


r.snapshot = snapshot


def fixture(op, **args):
    global sequence
    sequence += 1
    request = root / f'request-{sequence}.json'
    temporary = request.with_suffix('.tmp')
    temporary.write_text(json.dumps({'op': op, **args}))
    temporary.replace(request)
    response = root / f'response-{sequence}.json'
    if not r.wait_until(response.exists, 120, .1):
        raise RuntimeError(f'fixture command timed out: {op}')
    value = json.loads(response.read_text())
    r.evidence.write('fixture.jsonl', {'op': op, 'args': args, 'result': value}, append=True)
    return value


def configure(n, infra):
    # Preserve the production UI runner's pairing/storage/owner-control setup.
    r.config(n, 2001)
    path = r.ROOTS[n] / 'konsensus.toml'
    config = path.read_text()
    begin, end = config.index('[lightning]'), config.index('[pricing]')
    config = config[:begin] + f'''[lightning]
backend = "ldk"
network = "regtest"
esplora_url = "{infra['esplora']}"
listening_address = "127.0.0.1:{r.ports[n][2]}"
[chain]
backend = "esplora"
api_url = "{infra['chain_api']}"
''' + config[end:]
    path.write_text(config)
    r.evidence.write(f'config-{n}.toml', config)


def need(value, message):
    if not value:
        raise AssertionError(message)
    return value


def capacities():
    return {**{n: sum(ch['local_balance_msat'] for ch in r.get(n, '/payments/channels')) for n in ('a', 'b')},
            'c': fixture('snapshot')['capacity_msat']}


def watch_fixture():
    group = r.procs['fixture'].pid
    processes = subprocess.run(['/bin/ps','-axo','pid=,pgid='],capture_output=True,text=True,timeout=5)
    processes.check_returncode()
    owned = [int(line.split()[0]) for line in processes.stdout.splitlines()
             if len(line.split())==2 and line.split()[1]==str(group)]
    need(len(owned)>=3,'fixture, Bitcoin Core and electrs process ownership')
    for pid in owned:
        r.network_guard.add(f'fixture-{pid}',r.OwnedNode(pid))
    r.evidence.write('fixture-processes.json',{'pgid':group,'pids':owned})


def setup_channels(infra):
    for n in ('a', 'b'):
        need(r.wait_until(lambda: r.get(n, '/status').get('money_ready'), 180), f'{n}: money readiness')
    address = r.get('a', '/payments/funding-address')['address']
    need(address.startswith('bcrt1'), 'funding address is not regtest')
    fixture('fund', address=address)
    # A's independent LDK wallet synchronizes on its production schedule.
    need(r.wait_until(lambda: r.get('a', '/payments/balance')['balance_msat'] >= 3_000_000_000, 180), 'A funding sync')
    r.api('a', 'POST', '/payments/open-channel', {
        'peer_pubkey': infra['router_id'], 'peer_addr': infra['router_addr'],
        'amount_sats': 1_000_000, 'announce': False}, expect=200)
    need(r.wait_until(lambda: fixture('mempool'), 120), 'A-C funding in mempool')
    fixture('mine')
    need(r.wait_until(lambda: any(ch['active'] for ch in r.get('a', '/payments/channels')), 180), 'A-C usable')
    pubkey = r.get('b', '/status')['lightning_node_pubkey']
    fixture('open', pubkey=pubkey, address=f"127.0.0.1:{r.ports['b'][2]}")
    need(r.wait_until(lambda: fixture('mempool'), 120), 'C-B funding in mempool')
    fixture('mine')
    need(r.wait_until(lambda: any(ch['active'] for ch in r.get('b', '/payments/channels')), 180), 'C-B usable')
    channels = fixture('snapshot')['channels']
    need(len(channels) == 2 and all(ch['usable'] and ch['fee_base_msat'] == 1000 and ch['fee_ppm'] == 0 for ch in channels), 'router policy and usability')
    for n in ('a', 'b'):
        ch = r.get(n, '/payments/channels')
        need(len(ch) == 1 and ch[0]['peer_pubkey'] == infra['router_id'], f'{n} has only router channel')
    invoice = r.api('b', 'POST', '/payments/invoice', {'amount_msat': 50_000_000, 'description': 'regtest reply liquidity'}, expect=200)[1]
    need(invoice['bolt11'].startswith('lnbcrt'), 'invoice network')
    r.api('a', 'POST', '/payments/pay', {'bolt11': invoice['bolt11'], 'max_routing_fee_msat': 1000}, expect=200)
    need(r.wait_until(lambda: any(p['payment_hash'] == invoice['payment_hash'] and p['status'] == 'settled' and p['fee_msat'] == 1000 for p in r.get('a', '/payments')), 60), 'reply liquidity settled at 1000 msat fee')
    r.evidence.write('topology.json', {'infra':infra,'before':capacities(),'setup_seconds':time.monotonic()-started})


def main():
    code = 1
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, r.interrupted)
    try:
        r.SHOTS.mkdir()
        # Ephemeral app API and Vite ports (runner.A_API / UI_PORT), never 3141 or
        # 1420: a pilot node there is never contacted, probed or signalled.
        for port in (r.A_API, r.UI_PORT):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
        r.ports = {'a': [r.A_API, r.free_port(), r.free_port()], 'b': [r.free_port(), r.free_port(), r.free_port()]}
        r.in_pty('fixture', ['sandbox-exec', '-f', str(r.SANDBOX), str(root/'fixture'),
                 'regtest_e2e::real_ui_fixture', '--ignored', '--nocapture', '--test-threads=1'], root, os.environ.copy())
        need(r.wait_until((root/'fixture-ready.json').exists, 120), 'chain/router startup')
        infra = json.loads((root/'fixture-ready.json').read_text())
        watch_fixture()
        for n, directory in r.ROOTS.items():
            directory.mkdir(mode=0o700)
            r.owned.append(directory)
            r.run(r.BIN, 'init', '--dir', str(directory), '--non-interactive', '--tier', 'light')
            r.ids[n] = r.run(r.BIN, 'node-id', '--config', str(directory/'konsensus.toml')).strip().splitlines()[-1]
            r.secrets[n] = os.urandom(32).hex()
        for n in ('a', 'b'):
            configure(n, infra)
        r.evidence.write('runtime.json', {'ports':r.ports,'vite_port':r.UI_PORT,'ids':r.ids,'network':'regtest'})
        proc = r.in_pty('node-b', ['sandbox-exec', '-f', str(r.SANDBOX), r.BIN, 'start', '--config', str(r.ROOTS['b']/'konsensus.toml')], r.ROOTS['b'], {**os.environ, 'RUST_LOG':'info'})
        r.network_guard.add('b', proc)
        need(r.wait_until(lambda: r.api('b', 'GET', '/health')[0] == 200, 90), 'node B startup')
        wrapper = r.ROOTS['a']/'konsensus-dev-sidecar'
        wrapper.write_text(f'#!/bin/sh\nif [ "$1" = start ]; then echo $$ > "{r.ROOTS["a"]}/node.pid"; fi\nexec sandbox-exec -f "{r.SANDBOX}" "{r.BIN}" "$@"\n')
        wrapper.chmod(0o700)
        r.SAVE_DIR.mkdir(mode=0o700, exist_ok=True)
        env = r.app_env({'BITSOV_DEV_SIDECAR':str(wrapper), 'BITSOV_DEV_DATA_DIR':str(r.ROOTS['a'])})
        local_config = r.tauri_config(root/'tauri.local.json', bundle_id)
        r.in_pty('app', ['scripts/dev-node-from-main.sh', '--no-watch', '--config',str(local_config)], app, env)
        need(r.wait_until(r.register_a, 600, .5), 'app starts node A')
        need(r.wait_until(lambda: r.ui('ping'), 120, 1), 'real window driver')
        r.evidence.write('window.json', r.ui('ping'))
        from evidence import install
        install(r)
        r.snapshot('window-started')
        r.run(r.BIN,'pair-window','--config',str(r.ROOTS['a']/'konsensus.toml'),'--seconds','60')
        for n in ('a', 'b'): r.pair_reader(n)
        setup_channels(infra)
        # Step 10 restarts node A the way the app does: the same app command,
        # which starts its sidecar node again on the same data directory.
        r.relaunch_app = lambda: r.in_pty('app', ['scripts/dev-node-from-main.sh', '--no-watch', '--config',str(local_config)], app, env)
        from scenario import run
        run(r, fixture, capacities)
        code = 0 if r.results and all(x['status'] == 'PASS' for x in r.results) else 2
    except BaseException:
        r.evidence.write('fatal.txt', traceback.format_exc())
        r.log(traceback.format_exc())
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(sig, signal.SIG_IGN)
        for name in ('app', 'node-a', 'node-b'):
            try: r.stop(name, grace=20)
            except Exception as e: r.log('cleanup', name, str(e)); code=1
        if (root/'fixture-ready.json').exists() and 'fixture' in r.procs and r.procs['fixture'].poll() is None:
            try: fixture('finish')
            except Exception as e: r.log('fixture finish', str(e)); code=1
        try: r.stop('fixture', grace=5)
        except Exception as e: r.log('fixture cleanup', str(e)); code=1
        r.network_guard.close()
        for thread in r.capture_threads: thread.join(5)
        for directory in r.owned: shutil.rmtree(directory)
        for category in ('Caches','WebKit','Application Support','Saved Application State'):
            cache = Path.home()/'Library'/category/(bundle_id+'.savedState' if category=='Saved Application State' else bundle_id)
            if cache.exists(): shutil.rmtree(cache)
        scan = r.evidence.scan()
        if not scan or r.network_guard.failures or r.capture_errors: code=1
        captures = list((r.E/'screenshots').glob('*.png'))
        requested = {p.stem for p in r.SHOTS.glob('*.html')}
        captured = {p.stem for p in captures}
        missing_captures = sorted(requested-captured)
        if not captures or missing_captures: code=1
        r.evidence.write('summary.json', {'exit_code':code,'steps':r.results,'elapsed_seconds':time.monotonic()-started,
            'network_guard':r.network_guard.report(),'evidence_scan_passed':scan,
            'native_screenshot_count':len(captures),
            'missing_native_screenshots':missing_captures,
            'cleanup_complete':not r.procs and all(not p.exists() for p in r.owned)})
    return code


if __name__ == '__main__': sys.exit(main())
