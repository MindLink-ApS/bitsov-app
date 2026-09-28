"""Observe native node sockets; this is detection, not network prevention.

Seatbelt's localhost rule also allows this Mac's LAN addresses. Nodes bind to
127.0.0.1, and lsof snapshots check both endpoints while they run and before
shutdown. A socket that opens and closes between samples can escape observation.
"""
import ipaddress
import subprocess
import threading


def loopback_endpoint(endpoint):
    try:
        host, port = endpoint.rsplit(':', 1)
        if not port.isdecimal():
            return False
        address = ipaddress.ip_address(host.strip('[]').split('%', 1)[0])
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_loopback
    except ValueError:
        return False


def internet_socket_lines(output):
    return [line for line in output.splitlines()
            if len(line.split()) >= 5 and line.split()[4] in ('IPv4', 'IPv6')]


def offending_socket_lines(output):
    bad = []
    for line in internet_socket_lines(output):
        fields = line.split(None, 8)
        if (len(fields) != 9 or fields[7] not in ('TCP', 'UDP')
                or not all(loopback_endpoint(endpoint)
                           for endpoint in fields[8].split()[0].split('->'))):
            bad.append(line)
    return bad


class NodeSocketGuard:
    """Latch violations so cleanup or a later clean snapshot cannot hide them."""

    def __init__(self, evidence, interval=.25):
        self.evidence = evidence
        self.interval = interval
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.thread = None
        self.processes = {}
        self.failures = []
        self.samples = self.periodic_samples = self.before_stop_samples = 0
        self.socket_lines = 0

    def fail(self, node, pid, reason, line):
        failure = self.evidence.clean({'node': node, 'pid': pid,
                                       'reason': reason, 'line': line})
        if failure not in self.failures:
            self.failures.append(failure)
            print('FAIL node socket guard: ' + failure['line'], flush=True)
        self.stopped.set()

    def add(self, node, process):
        with self.lock:
            self.processes[node] = process
            self.sample('start')
            if self.thread is None and not self.stopped.is_set():
                self.thread = threading.Thread(target=self.watch, daemon=True)
                self.thread.start()

    def remove(self, node):
        with self.lock:
            self.processes.pop(node, None)

    def sample(self, stage):
        with self.lock:
            for node, process in self.processes.items():
                if process.poll() is not None:
                    continue
                try:
                    result = subprocess.run(
                        ['/usr/sbin/lsof', '-nP', '-p', str(process.pid)],
                        capture_output=True, text=True, timeout=5)
                except (OSError, subprocess.TimeoutExpired) as error:
                    self.fail(node, process.pid, 'inspection failed', str(error))
                    continue
                # Preserve every observed violation even if the child exited
                # during inspection. Disappearance only excuses lookup errors.
                lines = internet_socket_lines(result.stdout)
                bad = offending_socket_lines(result.stdout)
                for line in bad:
                    self.fail(node, process.pid, 'non-loopback or unreadable endpoint', line)
                if process.poll() is None and (
                        result.returncode or result.stderr or not result.stdout.startswith('COMMAND')):
                    self.fail(node, process.pid, 'inspection failed',
                              f'lsof exit {result.returncode}: {result.stderr or "missing process listing"}')
                if not result.stdout.startswith('COMMAND'):
                    continue
                self.samples += 1
                self.periodic_samples += stage == 'periodic'
                self.before_stop_samples += stage == 'before-stop'
                self.socket_lines += len(lines)
                self.evidence.write('node-sockets.jsonl', {
                    'stage': stage, 'node': node, 'pid': process.pid,
                    'command': ['lsof', '-nP', '-p', str(process.pid)],
                    'socket_lines': lines, 'offending_lines': bad}, append=True)

    def watch(self):
        while not self.stopped.wait(self.interval):
            try:
                self.sample('periodic')
            except Exception as error:
                with self.lock:
                    self.fail('monitor', None, 'monitor failed', str(error))

    def require_clean(self):
        with self.lock:
            if self.failures:
                raise AssertionError('node socket guard: ' + self.failures[0]['line'])

    def close(self):
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=10)
            if self.thread.is_alive():
                with self.lock:
                    self.fail('monitor', None, 'monitor failed', 'lsof monitor did not stop')

    def report(self):
        with self.lock:
            return {
                'policy': 'Node listeners bind 127.0.0.1; sampled lsof endpoints must be loopback. Seatbelt is best-effort host-local defense, not loopback-only enforcement.',
                'limitation': 'Sampling can miss short-lived sockets between observations; this guard detects observed violations, it does not prevent traffic.',
                'interval_seconds': self.interval, 'samples': self.samples,
                'periodic_samples': self.periodic_samples,
                'before_stop_samples': self.before_stop_samples,
                'socket_lines': self.socket_lines, 'failures': list(self.failures),
            }
