"""UI-E2E runner: the real app window against two throwaway mock nodes.

Started by scripts/ui-e2e-two-node.sh. Owns every process it starts and every
directory it creates, and removes them on exit (including on failure or
Ctrl-C). Nodes run under a loopback-only sandbox with mock Lightning (a shared
mock ledger with recipient settlement checks), mock chain and fresh
identities. No seed, wallet, mainnet or funds.

Topology (setup follows bitsov-app PR #46, scripts/two-node-mock-harness.sh):
  node A  the owner's node, started BY THE APP through the #44 dev-node path
          (BITSOV_DEV_SIDECAR / BITSOV_DEV_DATA_DIR) on 127.0.0.1:3141, with
          --owner-control so the owner can grant a budget from A's terminal.
  node B  a stranger in price_open mode; A knows B's address, B knows nothing.

The steps live in tests/e2e/two_node_spec.py; this file is plumbing.
"""
import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
import pty
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import tomllib
import traceback
from pathlib import Path

E = Path(sys.argv[1])            # evidence dir (fresh, private)
APP = Path(sys.argv[2])          # bitsov-app checkout under test
BIN = sys.argv[3]                # konsensus built from the integration genome
SANDBOX = E / 'loopback.sb'
ROOTS = {n: Path(f'/tmp/uie2e-node-{n}') for n in ('a', 'b')}
A_API = 3141                     # fixed: the app's API_BASE
SHOTS = E / 'snapshots'

owned, procs, logs = [], {}, {}
ids, ports, secrets = {}, {}, {}
results = []                     # [{step, name, status, checks:[...], notes:[...]}]
bugs = []
snap_seq = 0


# ---------- evidence -----------------------------------------------------------

def log(*parts):
    line = ' '.join(str(p) for p in parts)
    print(line, flush=True)
    with (E / 'runner.log').open('a') as f:
        f.write(line + '\n')


class Step:
    """One ticket step. Checks inside record PASS/FAIL; a hard failure stops the step."""

    def __init__(self, number, name):
        self.row = {'step': number, 'name': name, 'status': 'PASS', 'checks': [], 'notes': [], 'snapshots': []}

    def __enter__(self):
        results.append(self.row)
        log(f'\n=== Step {self.row["step"]}: {self.row["name"]}')
        return self

    def __exit__(self, kind, error, tb):
        if error is not None and not isinstance(error, KeyboardInterrupt):
            self.row['status'] = 'FAIL'
            self.row['notes'].append(f'stopped: {error}')
            log('  step stopped:', error)
            (E / f'step{self.row["step"]}-traceback.txt').write_text(''.join(traceback.format_exception(kind, error, tb)))
            try:
                self.snap('stopped')
            except Exception:
                pass
            return True
        log(f'=== Step {self.row["step"]}: {self.row["status"]}')
        return False

    def check(self, name, ok, detail=None):
        self.row['checks'].append({'name': name, 'pass': bool(ok), 'detail': detail})
        log(('  PASS ' if ok else '  FAIL ') + name + ('' if ok or detail is None else f'  -- {str(detail)[:400]}'))
        if not ok:
            self.row['status'] = 'FAIL'
        return bool(ok)

    def need(self, name, ok, detail=None):
        if not self.check(name, ok, detail):
            raise AssertionError(name)

    def note(self, text):
        self.row['notes'].append(text)
        log('  note:', text)

    def snap(self, label):
        name = snapshot(f's{self.row["step"]}-{label}')
        self.row['snapshots'].append(name)
        return name


def bug(title, detail, where):
    bugs.append({'title': title, 'detail': detail, 'where': where})
    log('  BUG:', title)


# ---------- the driver (tests/e2e/driver.js inside the real window) ---------------

def ui(op, **args):
    body = json.dumps({'op': op, 'args': args})
    conn = http.client.HTTPConnection('localhost', 1420, timeout=(args.get('timeoutMs', 15000) / 1000) + 20)
    try:
        conn.request('POST', '/__e2e/run', body, {'Content-Type': 'application/json'})
        out = json.loads(conn.getresponse().read() or b'{}')
    finally:
        conn.close()
    with (E / 'ui.jsonl').open('a') as f:
        shown = dict(out)
        if op == 'snapshot' and out.get('ok'):
            shown['value'] = '<snapshot>'
        f.write(json.dumps({'at': time.time(), 'op': op, 'args': {k: v for k, v in args.items() if k != 'data_b64'}, 'result': shown}) + '\n')
    if not out.get('ok'):
        raise RuntimeError(f'ui {op} {args.get("selector") or args.get("text") or ""}: {out.get("error")}')
    return out.get('value')


def ui_try(op, **args):
    try:
        return ui(op, **args)
    except RuntimeError:
        return None


def text(selector=None):
    return ui('text', within={'selector': selector} if selector else None) or ''


def snapshot(label):
    global snap_seq
    snap_seq += 1
    shot = ui('snapshot')
    name = f'{snap_seq:02d}-{label}'
    (SHOTS / f'{name}.html').write_text(shot['html'])
    (SHOTS / f'{name}.json').write_text(json.dumps({k: shot[k] for k in ('width', 'height', 'scheme')}))
    return name


# ---------- node HTTP (owner/operator fixture reads) -----------------------------

def jwt(n):
    # Operator fixture token from the throwaway config secret (as PR #46). Used
    # only for evidence reads and owner-only setup the app has no UI for.
    enc = lambda v: base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
    now = int(time.time())
    unsigned = enc({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + enc(
        {'sub': ids[n], 'iat': now, 'exp': now + 3600, 'scp': ['read', 'receive', 'spend', 'admin']})
    sig = base64.urlsafe_b64encode(hmac.new(secrets[n].encode(), unsigned, hashlib.sha256).digest()).rstrip(b'=')
    return (unsigned + b'.' + sig).decode()


def api(n, method, path, body=None, expect=None, token=None, anonymous=False):
    conn = http.client.HTTPConnection('127.0.0.1', ports[n][0], timeout=40)
    raw = None if body is None else json.dumps(body)
    headers = {'Content-Type': 'application/json'}
    if not anonymous:
        headers['Authorization'] = 'Bearer ' + (token or jwt(n))
    try:
        conn.request(method, '/api/v1' + path, raw, headers)
        r = conn.getresponse()
        data = r.read().decode()
    finally:
        conn.close()
    try:
        value = json.loads(data) if data else None
    except json.JSONDecodeError:
        value = data
    with (E / 'node-http.jsonl').open('a') as f:
        f.write(json.dumps({'at': time.time(), 'node': n, 'method': method, 'path': path, 'body': body, 'status': r.status, 'response': value}) + '\n')
    if expect is not None and r.status != expect:
        raise RuntimeError(f'{method} {n}{path}: HTTP {r.status} {data[:300]}')
    return r.status, value


def get(n, path):
    return api(n, 'GET', path, expect=200)[1]


readers = {}  # node -> (key, client_id, token)


def pair_reader(n):
    """A read-only paired client on node n, for evidence reads that genome #82
    restricts to a local paired read (/energy, /membrane). The same pairing
    ceremony as PR #46; the app never sees or uses this client."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    reply = api(n, 'POST', '/pair/request', {'client_name': 'UI-E2E evidence reader', 'client_pubkey': pub},
                expect=200, anonymous=True)[1]
    challenge = Path(reply['challenge_path']).read_bytes()
    proof = reply['pair_id'].encode() + pub.encode() + challenge
    reply = api(n, 'POST', '/pair/confirm', {'pair_id': reply['pair_id'], 'signature': key.sign(proof).hex()},
                expect=200, anonymous=True)[1]
    readers[n] = (key, reply['client_id'], None)
    return refresh_reader(n)


def refresh_reader(n):
    key, client, _ = readers[n]
    challenge = api(n, 'GET', '/pair/challenge?client_id=' + client, expect=200, anonymous=True)[1]['challenge']
    token = api(n, 'POST', '/pair/token', {'client_id': client, 'challenge': challenge,
                                           'signature': key.sign(challenge.encode()).hex()},
                expect=200, anonymous=True)[1]['token']
    readers[n] = (key, client, token)
    return token


def read(n, path):
    """GET with node n's paired evidence reader (re-issuing its token once)."""
    if n not in readers:
        pair_reader(n)
    status, value = api(n, 'GET', path, token=readers[n][2])
    if status == 401:
        status, value = api(n, 'GET', path, token=refresh_reader(n))
    if status != 200:
        raise RuntimeError(f'GET {n}{path} (paired reader): HTTP {status} {str(value)[:200]}')
    return value


def wait_until(fn, seconds=30, every=0.5):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as error:  # keep polling; record the last error
            last = error
        time.sleep(every)
    return None


# ---------- processes ------------------------------------------------------------

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run(*argv, input=None, timeout=60):
    out = subprocess.run(argv, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    with (E / 'commands.log').open('a') as f:
        f.write(json.dumps({'argv': list(argv), 'exit': out.returncode, 'output': out.stdout}) + '\n')
    if out.returncode != 0:
        raise RuntimeError(f'{argv[1] if len(argv) > 1 else argv[0]} exited {out.returncode}: {out.stdout[-400:]}')
    return out.stdout


def config(n, chat_msat=2000):
    root = ROOTS[n]
    peer = '' if n == 'b' else f'''
[[peers]]
node_id = "{ids['b']}"
addr = "127.0.0.1:{ports['b'][1]}"
auto_connect = true
'''
    text = f'''tier = "light"
admission_mode = "{'price_open' if n == 'b' else 'whitelist'}"
[identity]
mnemonic_file = "{root}/mnemonic.txt"
passphrase = ""
[network]
listen_addr = "127.0.0.1:{ports[n][1]}"
tier = "T1"
[lightning]
backend = "shared_mock"
ledger_path = "{ROOTS['a']}/mock-ledger.sqlite"
initial_balance_msat = 1000000
[chain]
backend = "mock"
[pricing]
mode = "static"
chat_msat = {chat_msat}
file_ref_msat = 3000
control_msat = 1000
[payment_gate]
verify_lightning_settlement = true
min_admission_cost_msat = 0
[storage]
backend = "sqlite"
path = "{root}/data.db"
encrypted = true
[backup]
scb_dir = "{root}/backups"
[api]
listen_addr = "127.0.0.1:{ports[n][0]}"
jwt_secret = "{secrets[n]}"
audit_log_path = "{root}/audit.jsonl"
rate_limit_rps = 100
operator_probes_enabled = false
[web]
enabled = false
content_dir = "{root}/pages"
{peer}'''
    parsed = tomllib.loads(text)
    assert parsed['lightning']['backend'] == 'shared_mock' and parsed['chain']['backend'] == 'mock'
    assert all(parsed[x]['listen_addr'].startswith('127.0.0.1:') for x in ('api', 'network'))
    (root / 'konsensus.toml').write_text(text)
    (E / f'config-{n}.toml').write_text(text.replace(secrets[n], '<throwaway>'))


def in_pty(name, argv, cwd, env):
    """Start argv with a pty as its controlling terminal; tee it to <name>.log."""
    logfile = (E / f'{name}.log').open('ab')  # append: a restarted node keeps its history
    logs[name] = E / f'{name}.log'
    master, slave = pty.openpty()
    launch = [sys.executable, '-c', 'import os,sys; os.login_tty(int(sys.argv[1])); os.execvp(sys.argv[2], sys.argv[2:])', str(slave), *argv]
    proc = subprocess.Popen(launch, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, env=env, pass_fds=(slave,))
    os.close(slave)

    def pump():
        try:
            while True:
                data = os.read(master, 65536)
                if not data:
                    break
                logfile.write(data)
                logfile.flush()
        except OSError:
            pass
        finally:
            os.close(master)
            logfile.close()
    threading.Thread(target=pump, daemon=True).start()
    procs[name] = proc
    return proc


def stop(name, grace=20):
    proc = procs.pop(name, None)
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)


def start_b(chat_msat=2000):
    config('b', chat_msat)
    in_pty('node-b', ['sandbox-exec', '-f', str(SANDBOX), BIN, 'start', '--config', str(ROOTS['b'] / 'konsensus.toml')],
           ROOTS['b'], {**os.environ, 'RUST_LOG': 'info'})
    if not wait_until(lambda: api('b', 'GET', '/health')[0] == 200, 30, 0.25):
        raise RuntimeError('node B did not start')


def restart_b(chat_msat):
    stop('node-b')
    start_b(chat_msat)


def node_a_owner_phrase(op, seconds=10):
    """The confirmation code node A printed on its own terminal (the app's pty)."""
    pattern = re.compile(r'GRANT spend TO ' + re.escape(op) + r' CODE [0-9a-f]{64}')
    found = wait_until(lambda: pattern.search(logs['app'].read_text(errors='replace')), seconds, 0.2)
    return found.group(0) if found else None


def owner_grant(op, *flags):
    """What the owner types at node A's terminal: konsensus grant --op <id> ... --yes."""
    phrase = node_a_owner_phrase(op)
    if not phrase:
        raise RuntimeError(f'node A printed no grant code for {op}')
    return run('sandbox-exec', '-f', str(SANDBOX), BIN, 'grant', '--config', str(ROOTS['a'] / 'konsensus.toml'),
               '--op', op, *flags, '--yes', input=phrase + '\n')


# ---------- main -----------------------------------------------------------------

def interrupted(signum, frame):
    raise KeyboardInterrupt(f'signal {signum}')


for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, interrupted)

exit_code = 1
try:
    SHOTS.mkdir()
    for root in ROOTS.values():
        if os.path.lexists(root):
            raise RuntimeError(f'refusing to reuse existing {root}')
    for host, port in (('127.0.0.1', A_API), ('127.0.0.1', 1420), ('::1', 1420)):
        with socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET) as s:
            if s.connect_ex((host, port)) == 0:
                raise RuntimeError(f'{host}:{port} is already in use; stop that process first')
    probe = subprocess.run(['sandbox-exec', '-f', str(SANDBOX), sys.executable, '-c',
                            'import socket,errno;s=socket.socket();s.settimeout(.2);print(s.connect_ex(("192.0.2.1",443)))'],
                           text=True, capture_output=True)
    if probe.stdout.strip() not in ('1', '13'):
        raise RuntimeError(f'sandbox does not deny non-loopback egress: {probe.stdout!r} {probe.stderr!r}')
    ports = {'a': [A_API, free_port()], 'b': [free_port(), free_port()]}
    for n, root in ROOTS.items():
        root.mkdir(mode=0o700)
        owned.append(root)
        run(BIN, 'init', '--dir', str(root), '--non-interactive', '--tier', 'light')
        ids[n] = run(BIN, 'node-id', '--config', str(root / 'konsensus.toml')).strip().splitlines()[-1]
        secrets[n] = os.urandom(32).hex()
    config('a')
    (E / 'runtime.json').write_text(json.dumps({'ports': ports, 'node_ids': ids}, indent=2))
    start_b()
    try:
        pair_reader('b')
    except Exception as error:  # evidence only; the steps say what they could not read
        log('note: no paired evidence reader on node B:', error)

    # Node A is started by the app (the #44 dev path, which starts it with
    # --owner-control). The wrapper only adds the loopback sandbox.
    wrapper = E / 'konsensus-dev-sidecar'
    wrapper.write_text(f'''#!/bin/sh
exec sandbox-exec -f "{SANDBOX}" "{BIN}" "$@"
''')
    wrapper.chmod(0o700)
    env = {**os.environ,
           'BITSOV_DEV_SIDECAR': str(wrapper), 'BITSOV_DEV_DATA_DIR': str(ROOTS['a']),
           'BITSOV_UI_E2E': '1', 'RUST_LOG': 'info'}
    in_pty('app', ['scripts/dev-node-from-main.sh'], APP, env)
    if not wait_until(lambda: ui('ping'), 600, 1):
        raise RuntimeError('the app window never loaded the driver (see app.log)')
    log('app window up:', ui('ping'))

    spec_path = APP / 'tests' / 'e2e' / 'two_node_spec.py'
    spec = importlib.util.spec_from_file_location('two_node_spec', spec_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.run(sys.modules[__name__])
    exit_code = 0 if all(r['status'] == 'PASS' for r in results) else 2
except BaseException as error:  # noqa: BLE001 - always clean up and report
    log('runner stopped:', repr(error))
    (E / 'runner-traceback.txt').write_text(traceback.format_exc())
finally:
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    # The app stops node A itself on quit (SIGTERM, then SIGKILL after 30 s).
    stop('app', grace=45)
    stop('node-b')
    for pattern in ('konsensus start --config /tmp/uie2e-node-',):
        subprocess.run(['pkill', '-f', pattern])
    time.sleep(1)
    for root in owned:
        if root.is_symlink():
            raise RuntimeError(f'refusing cleanup of a replaced data-dir symlink: {root}')
        shutil.rmtree(root, ignore_errors=True)
    cleanup = all(not os.path.lexists(r) for r in owned)
    summary = {'exit_code': exit_code, 'steps': results, 'bugs': bugs, 'cleanup_complete': cleanup, 'node_ids': ids}
    (E / 'summary.json').write_text(json.dumps(summary, indent=2))
    log(f'\ncleanup complete: {cleanup}; evidence: {E}')
    for r in results:
        log(f'  step {r["step"]}: {r["status"]}  {r["name"]}')
sys.exit(exit_code)
