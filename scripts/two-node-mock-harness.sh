#!/usr/bin/env bash
# T1: two real node processes, fake Lightning, loopback-only macOS sandbox.
# Prerequisites: macOS, git, Cargo, Python >=3.11 with cryptography installed.
# Usage: scripts/two-node-mock-harness.sh /absolute/path/to/genome [--allow-known-gaps]
# The genome checkout must be clean at the pinned SHA. Build uses Cargo --offline.
# Exit 0: checks pass and no strict gap (or --allow-known-gaps was explicit).
# Exit 2: checks pass, but stock cross-process mock settlement cannot prove strict E2E.
# Exit 1: failed prerequisite/assertion. Logs/HTTP transcripts stay in a new /tmp directory.
# This does NOT launch Tauri, a wallet, Docker, LND, LDK or any cloud infrastructure.
set -euo pipefail
umask 077
GENOME_SHA=f2f17695bc58c240178a172416e621451f0f5614
APP_CONTRACT_SHA=587d078bc93fb869c0f801f7bd02d91ec99f227f
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && $2 != --allow-known-gaps ) ]]; then
  echo "Usage: $0 /absolute/path/to/genome [--allow-known-gaps]" >&2
  exit 1
fi
[[ $(uname -s) == Darwin ]] || { echo 'Use a macOS machine/CI runner: sandbox-exec is required.' >&2; exit 1; }
GENOME=$(cd "$1" && pwd -P)
[[ $(git -C "$GENOME" rev-parse HEAD) == "$GENOME_SHA" ]] || { echo 'Wrong genome revision.' >&2; exit 1; }
[[ -z $(git -C "$GENOME" status --porcelain --untracked-files=normal) ]] || { echo 'Genome checkout must be clean.' >&2; exit 1; }
python3 -c 'import tomllib; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey'
command -v cargo >/dev/null
command -v sandbox-exec >/dev/null
EVIDENCE=$(mktemp -d /tmp/bitsov-t1-evidence.XXXXXX)
echo "Evidence: $EVIDENCE"
printf '%s\n' "$GENOME_SHA" > "$EVIDENCE/genome-sha.txt"
printf '%s\n' "$APP_CONTRACT_SHA" > "$EVIDENCE/app-contract-sha.txt"
# Use a dedicated cache; never execute a caller-supplied node binary.
CARGO_TARGET_DIR=/tmp/bitsov-t1-target cargo build --locked --offline \
  --manifest-path "$GENOME/Cargo.toml" -p konsensus-node --bin konsensus \
  > "$EVIDENCE/build.log" 2>&1
cat > "$EVIDENCE/loopback.sb" <<'SANDBOX'
(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network* (local unix-socket) (remote unix-socket))
SANDBOX
# The entire runtime (including children and HTTP probes) inherits this policy.
# No DNS or non-loopback socket is permitted, even for node background jobs.
cat > "$EVIDENCE/runner.py" <<'PY'
import base64
import errno
import hashlib
import hmac
import http.client
import http.server
import json
import os
import pty
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import tomllib
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

E = Path(sys.argv[1])
ALLOW_GAPS = len(sys.argv) > 2 and sys.argv[2] == '--allow-known-gaps'
BIN = '/tmp/bitsov-t1-target/debug/konsensus'
ROOTS = {n: Path('/tmp/bitsov-t1-' + n) for n in ('a', 'b')}
owned = []
nodes = {}
logs = []
readers = []
checks = []
seq = 0
phase = 'setup'
ports = {}
ids = {}
secrets = {}
admin = {}
clients = {}
keys = {}
tokens = {}
gaps = []
closed_mesh_e2e = False

def check(name, condition, detail=None):
    checks.append({'name': name, 'pass': bool(condition), 'detail': detail})
    print(('PASS ' if condition else 'FAIL ') + name, flush=True)
    if not condition:
        raise AssertionError(f'{name}: {detail}')

def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=60, check=True)
    with (E / 'commands.log').open('a') as f:
        f.write(json.dumps({'argv': args, 'output': result.stdout}) + '\n')
    return result.stdout

def req(n, method, path, body=None, token=None, expect=None, drop=False):
    global seq
    seq += 1
    raw = None if body is None else json.dumps(body, separators=(',', ':'))
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    record = {'seq': seq, 'phase': phase, 'node': n, 'method': method,
              'url': f'http://127.0.0.1:{ports[n][0]}/api/v1{path}',
              'request_headers': headers, 'request_body': body}
    conn = http.client.HTTPConnection('127.0.0.1', ports[n][0], timeout=40)
    try:
        conn.request(method, '/api/v1' + path, raw, headers)
        response = conn.getresponse()
        data = response.read().decode()
        record.update(status=response.status, response_headers=list(response.getheaders()),
                      response_body=data)
        # Fault injection boundary: the recorder receives the upstream response,
        # but the simulated caller sees none of it. Do NOT claim a backend timeout.
        if drop:
            record['caller_observation'] = 'response deliberately withheld; outcome unknown'
        try:
            value = json.loads(data) if data else None
        except json.JSONDecodeError:
            value = data  # Scope extractors return plain-text 403 responses.
    except Exception as error:
        record['transport_error'] = str(error)
        raise
    finally:
        conn.close()
        with (E / 'http.jsonl').open('a') as f:
            f.write(json.dumps(record) + '\n')
    if expect is not None:
        check(f'{method} {n}{path}: HTTP {expect}', response.status == expect, record)
    return response.status, value

def get(n, path, owner=False):
    return req(n, 'GET', path, token=admin[n] if owner else tokens[n], expect=200)[1]

def post(n, path, body, owner=False, expect=200):
    return req(n, 'POST', path, body, admin[n] if owner else tokens[n], expect)[1]

def jwt(n):
    # Operator-only fixture authority, using a fresh throwaway config secret.
    # Never used as the paired application's credential or as evidence of pairing.
    enc = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=')
    now = int(time.time())
    head = enc({'alg': 'HS256', 'typ': 'JWT'})
    payload = enc({'sub': ids[n], 'iat': now, 'exp': now + 3600,
                   'scp': ['read', 'receive', 'spend', 'admin']})
    unsigned = head + b'.' + payload
    sig = base64.urlsafe_b64encode(hmac.new(secrets[n].encode(), unsigned, hashlib.sha256).digest()).rstrip(b'=')
    return (unsigned + b'.' + sig).decode()

def config(n, strict, empty=False):
    root = ROOTS[n]
    other = 'b' if n == 'a' else 'a'
    # Strict B receives A as a stranger; A knows B's endpoint. Closed phase uses
    # mutual operator-configured peers. Neither phase changes genome source.
    peer = '' if strict and n == 'b' else f'''
[[peers]]
node_id = "{ids[other]}"
addr = "127.0.0.1:{ports[other][1]}"
auto_connect = {'true' if n == 'a' else 'false'}
'''
    text = f'''tier = "light"
admission_mode = "{'price_open' if strict else 'whitelist'}"
[identity]
mnemonic_file = "{root}/mnemonic.txt"
passphrase = ""
[network]
listen_addr = "127.0.0.1:{ports[n][1]}"
tier = "T1"
[lightning]
backend = "mock"
initial_balance_msat = {0 if empty else 1000000}
[chain]
backend = "mock"
[pricing]
mode = "static"
chat_msat = 2000
file_ref_msat = 3000
control_msat = 1000
[payment_gate]
verify_lightning_settlement = {'true' if strict else 'false'}
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
    check(f'{n} config: only mock backends', parsed['lightning']['backend'] == 'mock' and parsed['chain']['backend'] == 'mock')
    check(f'{n} config: loopback listeners', all(parsed[x]['listen_addr'].startswith('127.0.0.1:') for x in ('api', 'network')))
    (root / 'konsensus.toml').write_text(text)
    # No private keys copied into evidence. This config's JWT secret is disposable.
    (E / f'{phase}-{n}.toml').write_text(text)

def start(n):
    logfile = (E / f'{phase}-{n}.log').open('wb')
    logs.append(logfile)
    master, slave = pty.openpty()
    def capture():
        try:
            while True:
                data = os.read(master, 65536)
                if not data:
                    break
                logfile.write(data)
                logfile.flush()
        except OSError:
            pass  # PTY reports EIO when the child closes its terminal.
        finally:
            os.close(master)
    # Owner grant deliberately writes to /dev/tty, not redirected stdout.
    # Give each disposable node its own controlling terminal and capture it.
    # A tiny exec wrapper acquires its terminal without Python preexec_fn in a
    # multithreaded parent. exec preserves the PID we later stop and reap.
    launch = [sys.executable, '-c', 'import os,sys; os.login_tty(int(sys.argv[1])); os.execv(sys.argv[2],sys.argv[2:])',
              str(slave), BIN, 'start', '--config', str(ROOTS[n] / 'konsensus.toml'), '--owner-control']
    nodes[n] = subprocess.Popen(launch,
                               cwd=ROOTS[n], stdin=slave, stdout=slave, stderr=slave,
                               env={**os.environ, 'RUST_LOG': 'info'}, pass_fds=(slave,))
    os.close(slave)
    reader = threading.Thread(target=capture, daemon=True)
    reader.start()
    readers.append(reader)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if nodes[n].poll() is not None:
            raise RuntimeError(f'{n} exited; see {logfile.name}')
        try:
            if req(n, 'GET', '/health')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(.25)
    raise TimeoutError(f'{n} did not start')

def stop():
    for process in nodes.values():
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
    for n, process in nodes.items():
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        with (E / 'processes.jsonl').open('a') as f:
            f.write(json.dumps({'phase': phase, 'node': n, 'pid': process.pid, 'exit': process.returncode}) + '\n')
    nodes.clear()
    for reader in readers:
        reader.join(timeout=3)
    readers.clear()

def refresh(n):
    challenge = req(n, 'GET', '/pair/challenge?client_id=' + clients[n], expect=200)[1]['challenge']
    check('token challenge domain', challenge.startswith('bitsov-pair-token-v1:'))
    result = req(n, 'POST', '/pair/token', {'client_id': clients[n], 'challenge': challenge,
                 'signature': keys[n].sign(challenge.encode()).hex()}, expect=200)[1]
    tokens[n] = result['token']
    return result

def pair(n):
    keys[n] = Ed25519PrivateKey.generate()
    pub = keys[n].public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    reply = req(n, 'POST', '/pair/request', {'client_name': 'T1 disposable client', 'client_pubkey': pub}, expect=200)[1]
    challenge = Path(reply['challenge_path'])
    check('pairing challenge confined to throwaway node', challenge.parent.resolve() == (ROOTS[n] / 'pairing').resolve())
    check('pairing challenge private mode', challenge.stat().st_mode & 0o777 == 0o600)
    proof = reply['pair_id'].encode() + pub.encode() + challenge.read_bytes()
    reply = req(n, 'POST', '/pair/confirm', {'pair_id': reply['pair_id'], 'signature': keys[n].sign(proof).hex()}, expect=200)[1]
    clients[n] = reply['client_id']
    check('pairing starts read+receive', set(reply['scopes']) == {'read', 'receive'})
    refresh(n)

def elevate(n):
    op = post(n, '/pair/elevation-request', {'scopes': ['spend']})['op_id']
    logfile = E / f'{phase}-{n}.log'
    deadline = time.monotonic() + 3
    phrase = None
    while time.monotonic() < deadline:
        match = re.search(r'GRANT spend TO ' + re.escape(op) + r' CODE [0-9a-f]{64}', logfile.read_text())
        if match:
            phrase = match.group(0)
            break
        time.sleep(.05)
    check('owner console provides operation-bound grant', phrase is not None)
    run(BIN, 'grant', '--config', str(ROOTS[n] / 'konsensus.toml'), '--op', op, input=phrase + '\n')
    get(n, '/pair/elevation/' + op)
    check('fresh paired token has spend', 'spend' in refresh(n)['scopes'])

def wait_for(n, path, predicate, seconds=35):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = get(n, path)
        if predicate(value):
            return value
        time.sleep(.3)
    raise AssertionError(f'timeout: {n}{path}')

def balance(n='a'):
    return get(n, '/payments/balance')['balance_msat']

def messages(n='b'):
    return get(n, '/messages?limit=100')

def assert_received(reply, text, room=None):
    path = '/messages?limit=100' + ('&peer=' + room if room else '')
    rows = wait_for('b', path, lambda rows: any(r['id'] == reply['message_id'] for r in rows))
    row = next(r for r in rows if r['id'] == reply['message_id'])
    check('receiver decrypted exact plaintext', row.get('plaintext') == text, row)
    check('wire payload is encrypted', row['ciphertext'] != text.encode().hex())

def lost_response(body):
    observed = []
    failures = []
    class DropReply(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            try:
                observed.append(req('a', 'POST', '/messages/compose', data, tokens['a'], expect=200, drop=True)[1])
            except Exception as error:
                failures.append(str(error))
            # Close the caller's real socket without sending a status line.
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
    with http.server.HTTPServer(('127.0.0.1', 0), DropReply) as proxy:
        proxy.timeout = 10
        worker = threading.Thread(target=proxy.handle_request, daemon=True)
        worker.start()
        client = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=40)
        record = {'method': 'POST', 'url': f'http://127.0.0.1:{proxy.server_port}/api/v1/messages/compose',
                  'request_body': body, 'response': None}
        try:
            client.request('POST', '/api/v1/messages/compose', json.dumps(body), {'Content-Type': 'application/json'})
            client.getresponse()
            raise AssertionError('fault proxy unexpectedly returned a response')
        except http.client.RemoteDisconnected as error:
            record['transport_error'] = str(error)
        finally:
            client.close()
            worker.join(timeout=45)
            (E / 'lost-response-client.json').write_text(json.dumps(record, indent=2))
        check('caller lost reply after exactly one upstream dispatch', len(observed) == 1 and not failures and not worker.is_alive(), failures)
    return observed[0]  # Observer evidence only; the caller received no receipt.

def interrupted(signum, frame):
    raise KeyboardInterrupt(f'signal {signum}')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGHUP, interrupted)
exit_code = 1
try:
    # Verify the OS policy itself BEFORE any node starts. This connect is denied
    # locally by sandbox-exec; no packet to the documentation-only address is sent.
    with socket.socket() as s:
        s.settimeout(.2)
        denied = s.connect_ex(('192.0.2.1', 443))
    check('OS denies non-loopback egress', denied in (errno.EPERM, errno.EACCES), denied)
    # Never delete/adopt pre-existing dirs, including symlinks. mkdir is atomic.
    for root in ROOTS.values():
        check('data directory absent: ' + str(root), not os.path.lexists(root))
    # Hold ports until all four have been allocated (no duplicates).
    reservations = [socket.socket() for _ in range(4)]
    for s in reservations:
        s.bind(('127.0.0.1', 0))
    chosen = [s.getsockname()[1] for s in reservations]
    ports = {'a': chosen[:2], 'b': chosen[2:]}
    for n, root in ROOTS.items():
        root.mkdir(mode=0o700)
        owned.append(root)
        run(BIN, 'init', '--dir', str(root), '--non-interactive', '--tier', 'light')
        ids[n] = run(BIN, 'node-id', '--config', str(root / 'konsensus.toml')).strip().splitlines()[-1]
        check('fresh node identity syntax', re.fullmatch('[0-9a-f]{64}', ids[n]) is not None)
        secrets[n] = os.urandom(32).hex()
        admin[n] = jwt(n)
    check('independent identities', ids['a'] != ids['b'])
    (E / 'runtime.json').write_text(json.dumps({'ports': ports, 'node_ids': ids}, indent=2))
    phase = 'strict-price-open'
    for n in ROOTS:
        config(n, True)
    for s in reservations:
        s.close()
    start('b')
    start('a')
    pair('a')
    pair('b')
    compose = {'recipient': ids['b'], 'is_room': False, 'kind': 0,
               'plaintext': 'T1 strict capped first contact', 'max_total_msat': 2000}
    req('a', 'POST', '/messages/compose', compose, tokens['a'], expect=403)
    elevate('a')
    wait_for('a', '/peers/connected', lambda peers: ids['b'] in peers)
    check('advertises #80 cap contract', 'paid_send_caps_v1' in get('a', '/status')['api_capabilities'])
    get('b', '/pricing')
    before = balance()
    refusal = post('a', '/messages/compose', compose, expect=409)
    check('first contact cap refusal is explicit', refusal.get('code') == 'price_cap_exceeded', refusal)
    check('first contact refusal spends nothing', balance() == before)
    # Cross-instance settlement diagnostic: deliberately separate from app sends.
    inv = post('b', '/payments/invoice', {'amount_msat': 1000, 'description': 'T1 mock cross-process probe'})
    paid = post('a', '/payments/pay', {'bolt11': inv['bolt11']})
    check('payer returns same invoice hash', paid['payment_hash'] == inv['payment_hash'])
    recipient = get('b', '/payments/' + inv['payment_hash'])
    check('stock recipient mock remains pending', recipient['status'].lower() == 'pending', recipient)
    check('strict recipient received no message', messages() == [])
    gaps.append('Strict price_open admission/E2E blocked: separate mock ledgers do not propagate settlement; capped first contact refuses unquoted admission.')
    stop()

    phase = 'closed-mesh-mock'
    for n in ROOTS:
        config(n, False)
    start('b')
    start('a')
    refresh('a')
    refresh('b')
    wait_for('a', '/sessions/' + ids['b'], lambda s: s['active'])
    wait_for('b', '/sessions/' + ids['a'], lambda s: s['active'])
    get('a', '/pricing/peers/' + ids['b'])
    get('b', '/pricing')
    before = balance()
    compose['plaintext'] = 'T1 peer compose exact plaintext'
    reply = post('a', '/messages/compose', compose)
    check('peer principal within cap', reply['amount_msat'] == 2000 and before - balance() == 2000)
    assert_received(reply, compose['plaintext'])
    before = balance()
    refusal = post('a', '/messages/compose', {**compose, 'max_total_msat': 1999}, expect=409)
    check('over-cap refusal code and no debit', refusal.get('code') == 'price_cap_exceeded' and balance() == before)

    # Rooms are owner setup. The app's paired read+receive+spend token has no admin.
    room = post('a', '/rooms', {'name': 'T1 A+B'}, owner=True)['id']
    for member in (ids['a'], ids['b']):
        post('a', '/rooms/' + room + '/members', {'node_id': member}, owner=True)
    check('room has exactly A and B', set(get('a', '/rooms/' + room + '/members')) == set(ids.values()))
    room_body = {'recipient': room, 'is_room': True, 'kind': 0,
                 'plaintext': 'T1 room A+B plaintext', 'max_total_msat': 2000,
                 'max_recipient_msat': {ids['b']: 2000}}
    before = balance()
    reply = post('a', '/messages/compose', room_body)
    rows = reply['member_outcomes']
    check('room one non-self member terminal settlement', len(rows) == 1 and rows[0]['recipient'] == ids['b'] and rows[0]['status'] == 'settled', reply)
    check('room aggregate principal exact', reply['amount_msat'] == 2000 and rows[0]['amount_msat'] == 2000 and before - balance() == 2000)
    assert_received(reply, room_body['plaintext'], room)
    before = balance()
    post('a', '/messages/compose', {**room_body, 'max_total_msat': 1999}, expect=409)
    post('a', '/messages/compose', {**room_body, 'max_recipient_msat': {}}, expect=409)
    check('room refusals have no debit', balance() == before)

    payload = b'T1 throwaway file bytes\n'
    upload = {'filename': 't1.txt', 'mime_type': 'text/plain', 'data_b64': base64.b64encode(payload).decode()}
    req('a', 'POST', '/files', upload, tokens['a'], expect=403)
    gaps.append('App-shaped paired file upload is HTTP 403: /files upload needs admin, but owner elevation grants only spend. Owner fixture upload is needed to test file send.')
    file = post('a', '/files', upload, owner=True)
    before = balance()
    post('a', '/files/' + file['file_id'] + '/send', {'recipient': ids['b'], 'max_total_msat': 2999}, expect=409)
    check('file over-cap refusal has no debit', balance() == before)
    reply = post('a', '/files/' + file['file_id'] + '/send', {'recipient': ids['b'], 'max_total_msat': 3000})
    check('file send principal within cap', reply['amount_msat'] == 3000 and before - balance() == 3000)
    files = wait_for('b', '/files', lambda rows: any(r.get('message_id') == reply['message_id'] for r in rows))
    received = next(r for r in files if r.get('message_id') == reply['message_id'])
    data = get('b', '/files/' + received['id'])
    check('receiver file bytes/hash identical', base64.b64decode(data['data_b64']) == payload and data['blake3_hash'] == file['blake3_hash'])

    # Lose a real HTTP reply after upstream completion. Actual app fence behavior
    # is covered separately by host/UI regressions; this is not the Tauri host.
    before = balance()
    body = {**compose, 'plaintext': 'T1 withheld response, never auto-retry'}
    reply = lost_response(body)
    assert_received(reply, body['plaintext'])
    check('withheld response still debited once', before - balance() == 2000)
    get('a', '/payments')
    closed_mesh_e2e = True
    stop()
    phase = 'backend-error-unknown'
    # Stock mock exposes no runtime lost-HTLC knob. Empty its NEW in-memory
    # balance to exercise the real generic backend-error classification instead.
    for n in ROOTS:
        config(n, False, empty=n == 'a')
    start('b')
    start('a')
    refresh('a')
    refresh('b')
    wait_for('a', '/sessions/' + ids['b'], lambda s: s['active'])
    wait_for('b', '/sessions/' + ids['a'], lambda s: s['active'])
    check('unknown-case starts with zero simulated balance', balance() == 0)
    recipient_payments_before = get('b', '/payments')
    unknown = post('a', '/messages/compose', room_body)
    check('room generic backend error reserves full principal',
          unknown['amount_msat'] == 2000 and unknown['message_id'] == '' and not unknown['delivered']
          and len(unknown['member_outcomes']) == 1
          and unknown['member_outcomes'][0]['status'] == 'unknown'
          and unknown['member_outcomes'][0]['amount_msat'] == 2000, unknown)
    failure = post('a', '/messages/compose', compose, expect=502)
    check('peer generic backend error is explicitly unknown', 'unknown' in failure['error'] and 'not retrying' in failure['error'], failure)
    check('no successful payment or fallback after backend error', balance() == 0 and get('a', '/payments') == [])
    check('recipient issued no fallback invoice', get('b', '/payments') == recipient_payments_before)
    gaps.append('Real HTTP reply loss and stock generic backend-error classification are covered; unknown HTLC settlement and the Tauri fence against these live nodes are not.')
    gaps.append('A+B room has two members but only one remote paid recipient; two-remote-member fan-out needs a third node.')
    gaps.append('Closed-mesh phase disables settlement lookup on the mock only; it proves encrypted transport and API caps, not settled recipient-bound payment.')
    exit_code = 0 if ALLOW_GAPS else 2
finally:
    # A second interrupt must not interrupt teardown of detached node sessions.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    stop()
    for logfile in logs:
        logfile.close()
    recovery = [p.name for p in E.glob('*-*.log')
                if 'decryption failed, removing stale session' in p.read_text()]
    if recovery:
        gaps.append('Startup traffic triggered ratchet-session removal and automatic renegotiation; see startup_recovery_logs. Harness allows 35 seconds for recovery, not a first-attempt readiness guarantee.')
    # Only remove dirs this process created, never a caller-selected path.
    for root in owned:
        if root.is_symlink():
            raise RuntimeError('Refusing cleanup of replaced data-dir symlink: ' + str(root))
        shutil.rmtree(root)
    cleanup = all(not os.path.lexists(root) for root in owned)
    summary = {'exit_code': exit_code, 'checks': checks, 'gaps': gaps,
               'strict_price_open_e2e': False, 'cleanup_complete': cleanup,
               'closed_mesh_e2e': closed_mesh_e2e, 'startup_recovery_logs': recovery,
               'app_contract': '587d078bc93fb869c0f801f7bd02d91ec99f227f',
               'genome': 'f2f17695bc58c240178a172416e621451f0f5614'}
    (E / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(f'Cleanup complete: {cleanup}; evidence: {E}', flush=True)
if gaps:
    print('STRICT E2E NOT PROVEN. See summary.json gaps. Exit 2 unless --allow-known-gaps.', flush=True)
sys.exit(exit_code)
PY
exec sandbox-exec -f "$EVIDENCE/loopback.sb" python3 "$EVIDENCE/runner.py" "$EVIDENCE" "${2:-}"
