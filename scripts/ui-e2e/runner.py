"""UI-E2E runner: the real app window against two throwaway mock nodes.

Started by scripts/ui-e2e-two-node.sh. Owns every process it starts and every
directory it creates, and removes them on exit (including on failure or
Ctrl-C). Nodes use loopback binds plus sampled lsof checks and a host-local sandbox with mock Lightning (a shared
mock ledger with recipient settlement checks), mock chain and fresh
identities. No seed, wallet, mainnet or funds.

Topology (setup follows bitsov-app PR #46, scripts/two-node-mock-harness.sh):
  node A  the owner's node, started BY THE APP through the #44 dev-node path
          (BITSOV_DEV_SIDECAR / BITSOV_DEV_DATA_DIR) on 127.0.0.1:3141, with
          --owner-control so the owner can grant a budget from A's terminal.
  node B  a stranger in price_open mode; A knows B's address, B knows nothing.

The steps live in tests/e2e/two_node_spec.py; this file is plumbing.
"""
import errno
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from two_node_evidence import Evidence, ConsoleCapture
from two_node_network import NodeSocketGuard

E = Path(sys.argv[1])            # evidence dir (fresh, private)
APP = Path(sys.argv[2])          # bitsov-app checkout under test
BIN = sys.argv[3]                # konsensus built from the integration genome
SANDBOX = E / 'loopback.sb'
ROOTS = {n: Path(BIN).parent / f'node-{n}' for n in ('a', 'b')}
A_API = 3141                     # fixed: the app's API_BASE
SHOTS = E / 'snapshots'

owned, procs, logs = [], {}, {}
ids, ports, secrets = {}, {}, {}
results = []                     # [{step, name, status, checks:[...], notes:[...]}]
bugs = []
snap_seq = 0
evidence = Evidence(E)
network_guard = NodeSocketGuard(evidence, interval=.25)
grants, pairing_codes = {}, []
capture_threads, capture_errors = [], []


class UiConsoleCapture(ConsoleCapture):
    def line(self, raw):
        for code in re.findall(r'bitsov pairing code for "[^"\r\n]+": ([A-Z0-9]{4}-[A-Z0-9]{4})', raw.decode(errors='replace')):
            evidence.remember(code)
            pairing_codes.append(code)
        super().line(raw)


class OwnedNode:
    # App-spawned PID; verify its start time before inspecting or signaling it.
    def __init__(self, pid):
        self.pid = pid
        self.identity = self.state()
        if not self.identity:
            raise RuntimeError('app node exited before PID registration')

    def state(self):
        result = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'lstart=', '-o', 'stat='],
                                capture_output=True, text=True, timeout=5)
        value = result.stdout.strip()
        if result.returncode or not value:
            try:
                os.kill(self.pid, 0)
            except ProcessLookupError:
                return None
            network_guard.fail('a', self.pid, 'PID inspection failed', 'ps could not inspect a live owned node')
            raise RuntimeError('ps could not inspect owned node A')
        return None if 'Z' in value.split()[-1] else value

    def poll(self):
        state = self.state()
        # The process state changes, but its start time must remain identical.
        return None if state and state.rsplit(None, 1)[0] == self.identity.rsplit(None, 1)[0] else 0


def register_a():
    if 'node-a' in procs:
        return True
    pid_file = ROOTS['a'] / 'node.pid'
    if not pid_file.exists():
        return False
    node = OwnedNode(int(pid_file.read_text()))
    procs['node-a'] = node
    evidence.write('processes.jsonl', {'phase': 'start', 'node': 'node-a', 'pid': node.pid}, append=True)
    network_guard.add('a', node)
    return True



# ---------- evidence -----------------------------------------------------------

def log(*parts):
    line = evidence.text(' '.join(str(p) for p in parts))
    print(line, flush=True)
    evidence.write('runner.log', line, append=True)


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
            evidence.write(f'step{self.row["step"]}-traceback.txt', ''.join(traceback.format_exception(kind, error, tb)))
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
    shown = dict(out)
    if op == 'snapshot' and out.get('ok'):
        shown['value'] = '<snapshot>'
    evidence.write('ui.jsonl', {'at': time.time(), 'op': op,
                   'args': {k: v for k, v in args.items() if k != 'data_b64'}, 'result': shown}, append=True)
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
    Evidence(SHOTS).write(f'{name}.html', evidence.text(shot['html']))
    Evidence(SHOTS).write(f'{name}.json', {k: shot[k] for k in ('width', 'height', 'scheme')})
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


def owner_first_contact(command):
    """FIXTURE: node A operator runs the exact public command shown by the app.

    Only this separate operator process runs the CLI against node A's owner
    socket. The app sees only the public readiness receipt, never the socket.
    """
    env = os.environ.copy()
    env.pop('BITSOV_OWNER_TOKEN', None)
    env['PATH'] = str(Path(BIN).parent) + os.pathsep + env.get('PATH', '')
    result = subprocess.run(['sandbox-exec', '-f', str(SANDBOX), '/bin/sh', '-c', command],
                            cwd=ROOTS['a'], env=env, text=True, capture_output=True, timeout=30)
    evidence.write('owner-first-contact-fixture.json', {
        'label': 'FIXTURE: independent node A owner authority',
        'command': command, 'exit_code': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr,
    })
    if result.returncode:
        raise RuntimeError('Owner first-contact FIXTURE command failed; see sanitized evidence.')


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
    evidence.write('node-http.jsonl', {'at': time.time(), 'node': n, 'method': method, 'path': path, 'body': body, 'status': r.status, 'response': value}, append=True)
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
        network_guard.require_clean()
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
    evidence.write('commands.jsonl', {'argv': list(argv), 'exit': out.returncode, 'output': out.stdout}, append=True)
    if out.returncode != 0:
        raise RuntimeError(f'{argv[1] if len(argv) > 1 else argv[0]} exited {out.returncode}: {out.stdout[-400:]}')
    return out.stdout


def config(n, chat_msat=None):
    # Main's unknown-peer UI uses A's own price as the aggregate ceiling.
    # B charges 2,000 admission + 2,000 message; give A a 4,000 ceiling.
    if chat_msat is None:
        chat_msat = 4000 if n == 'a' else 2000
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
    evidence.remember(secrets[n])
    evidence.write(f'config-{n}.toml', text)


def in_pty(name, argv, cwd, env):
    """Start argv with a pty as its controlling terminal; tee it to <name>.log."""
    console = UiConsoleCapture(evidence, f'{name}.log', grants)
    logs[name] = E / f'{name}.log'
    master, slave = pty.openpty()
    launch = [sys.executable, '-c', 'import os,sys,fcntl,termios; fcntl.ioctl(int(sys.argv[1]), termios.TIOCSCTTY, 0); os.execvp(sys.argv[2], sys.argv[2:])', str(slave), *argv]
    proc = subprocess.Popen(launch, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, env=env, pass_fds=(slave,), start_new_session=True)
    procs[name] = proc
    os.close(slave)

    def pump():
        try:
            while True:
                data = os.read(master, 65536)
                if not data:
                    break
                console.feed(data)
        except OSError as error:
            if error.errno != errno.EIO:
                capture_errors.append(type(error).__name__)
        except Exception as error:
            capture_errors.append(type(error).__name__)
        finally:
            try:
                console.finish()
            except Exception as error:
                capture_errors.append(type(error).__name__)
            os.close(master)
    thread = threading.Thread(target=pump, daemon=True)
    capture_threads.append(thread)
    thread.start()
    evidence.write('processes.jsonl', {'phase': 'start', 'node': name, 'pid': proc.pid, 'pgid': proc.pid}, append=True)
    return proc


def group_alive(pgid):
    # Ignore zombies awaiting adoption/reaping. All members of this fresh session
    # descend from our launcher, even after that launcher has already exited.
    out = subprocess.run(['/bin/ps', '-axo', 'pgid=,stat='], capture_output=True, text=True, timeout=5)
    if out.returncode:
        raise RuntimeError('could not inspect owned process group')
    return any(len(parts := line.split()) == 2 and parts[0] == str(pgid) and 'Z' not in parts[1]
               for line in out.stdout.splitlines())


def stop(name, grace=20):
    proc = procs.get(name)
    if proc is None:
        return
    if name.startswith('node-'):
        try:
            network_guard.sample('before-stop')
        except Exception as error:
            network_guard.fail(name, proc.pid, 'final inspection failed', str(error))
    is_child = isinstance(proc, subprocess.Popen)
    # The group is created synchronously by Popen(start_new_session=True).
    # A launcher exit does not mean its descendants have stopped.
    alive = (lambda: group_alive(proc.pid)) if is_child else (lambda: proc.poll() is None)
    send = (lambda sig: os.killpg(proc.pid, sig)) if is_child else (lambda sig: os.kill(proc.pid, sig))
    if alive():
        try:
            send(signal.SIGINT if is_child else signal.SIGTERM)
            deadline = time.monotonic() + grace
            while alive() and time.monotonic() < deadline:
                time.sleep(.1)
            if alive():
                send(signal.SIGKILL)
                deadline = time.monotonic() + 5
                while alive() and time.monotonic() < deadline:
                    time.sleep(.1)
                if alive():
                    raise RuntimeError(f'owned process did not stop: {name}')
        except ProcessLookupError:
            pass
    if is_child:
        proc.wait(timeout=5)
    evidence.write('processes.jsonl', {'phase': 'stop', 'node': name, 'pid': proc.pid, 'exit': proc.poll()}, append=True)
    network_guard.remove(name.removeprefix('node-'))
    procs.pop(name, None)


def start_b(chat_msat=2000):
    config('b', chat_msat)
    proc = in_pty('node-b', ['sandbox-exec', '-f', str(SANDBOX), BIN, 'start', '--config', str(ROOTS['b'] / 'konsensus.toml')],
           ROOTS['b'], {**os.environ, 'RUST_LOG': 'info'})
    network_guard.add('b', proc)
    if not wait_until(lambda: api('b', 'GET', '/health')[0] == 200, 30, 0.25):
        raise RuntimeError('node B did not start')
    network_guard.sample('ready')
    network_guard.require_clean()


def restart_b(chat_msat):
    stop('node-b')
    start_b(chat_msat)


def node_a_owner_phrase(op, seconds=10):
    """The confirmation code node A printed on its own terminal (the app's pty)."""
    return wait_until(lambda: grants.get(op), seconds, .2)


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


def main():
    global exit_code, ports
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
        evidence.write('runtime.json', {'ports': ports, 'node_ids': ids})
        start_b()
        try:
            pair_reader('b')
        except Exception as error:  # evidence only; the steps say what they could not read
            log('note: no paired evidence reader on node B:', error)

        # Node A is started by the app (the #44 dev path, which starts it with
        # --owner-control). The wrapper only adds the loopback sandbox.
        wrapper = ROOTS['a'] / 'konsensus-dev-sidecar'
        wrapper.write_text(f'''#!/bin/sh
    if [ "$1" = start ]; then
      echo $$ > "{ROOTS['a']}/node.pid"
    fi
    exec sandbox-exec -f "{SANDBOX}" "{BIN}" "$@"
    ''')
        wrapper.chmod(0o700)
        env = {**os.environ,
               'BITSOV_DEV_SIDECAR': str(wrapper), 'BITSOV_DEV_DATA_DIR': str(ROOTS['a']),
               'BITSOV_UI_E2E': '1', 'RUST_LOG': 'info',
               'CARGO_TARGET_DIR': os.environ.get('APP_CARGO_TARGET_DIR', '/tmp/bitsov-target-app')}
        in_pty('app', ['scripts/dev-node-from-main.sh'], APP, env)
        if not wait_until(register_a, 600, .25):
            raise RuntimeError('app never started node A')
        if not wait_until(lambda: ui('ping'), 120, 1):
            raise RuntimeError('the app window never loaded the driver (see app.log)')
        network_guard.sample('ready')
        network_guard.require_clean()
        log('app window up:', ui('ping'))

        spec_path = APP / 'tests' / 'e2e' / 'two_node_spec.py'
        spec = importlib.util.spec_from_file_location('two_node_spec', spec_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.run(sys.modules[__name__])
        exit_code = 0 if results and all(r['status'] == 'PASS' for r in results) else 2
    except BaseException as error:  # noqa: BLE001 - always clean up and report
        log('runner stopped:', repr(error))
        evidence.write('runner-traceback.txt', traceback.format_exc())
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        # Capture late startup too; only our private wrapper can create this PID file.
        if 'app' in procs and 'node-a' not in procs:
            try:
                register_a()
            except Exception as error:
                log('late node registration failed:', error)
                exit_code = 1
        try:
            network_guard.sample('before-stop')
        except Exception as error:
            network_guard.fail('monitor', None, 'final inspection failed', str(error))
        app_owned = 'app' in procs
        for name in ('app', 'node-a', 'node-b'):
            try:
                if name == 'node-a' and app_owned and name not in procs:
                    # The app group is now quiescent; no further A can launch.
                    pid_file = ROOTS['a'] / 'node.pid'
                    if pid_file.exists():
                        try:
                            register_a()
                        except RuntimeError as error:
                            if str(error) != 'app node exited before PID registration':
                                raise
                stop(name, grace=45 if name == 'app' else 20)
            except Exception as error:
                log('cleanup failed:', name, error)
                exit_code = 1
        network_guard.close()
        for thread in capture_threads:
            thread.join(timeout=5)
            if thread.is_alive(): capture_errors.append('capture thread did not stop')
        if network_guard.failures or capture_errors:
            exit_code = 1
        time.sleep(1)
        for root in owned:
            if root.is_symlink():
                raise RuntimeError(f'refusing cleanup of a replaced data-dir symlink: {root}')
            shutil.rmtree(root, ignore_errors=True)
        cleanup = all(not os.path.lexists(r) for r in owned)
        if not cleanup:
            exit_code = 1
        scan_passed = evidence.scan()
        if not scan_passed:
            exit_code = 1
        summary = {'evidence_scan_passed': scan_passed, 'network_guard': network_guard.report(), 'capture_errors': capture_errors, 'exit_code': exit_code, 'steps': results, 'bugs': bugs, 'cleanup_complete': cleanup, 'node_ids': ids}
        evidence.write('summary.json', summary)
        log(f'\ncleanup complete: {cleanup}; evidence: {E}')
        for r in results:
            log(f'  step {r["step"]}: {r["status"]}  {r["name"]}')
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
