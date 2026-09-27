"""Socket-guard regressions; live tests use disposable sockets, never nodes."""
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
from two_node_evidence import Evidence
from two_node_network import NodeSocketGuard, offending_socket_lines


def row(name, family='IPv4', protocol='TCP'):
    return f'konsensus 123 user 7u {family} 0x123 0t0 {protocol} {name}'


class SocketParsingTests(unittest.TestCase):
    def test_loopback_both_endpoints_and_unix_are_allowed(self):
        output = '\n'.join([
            'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
            row('127.0.0.1:1234 (LISTEN)'),
            row('127.0.0.1:1234->127.0.0.1:5678 (ESTABLISHED)'),
            row('[::1]:1234->[::1]:5678 (ESTABLISHED)', 'IPv6'),
            row('[::ffff:127.0.0.1]:1234', 'IPv6', 'UDP'),
            'konsensus 123 user 8u unix 0x123 0t0 /tmp/private.sock',
        ])
        self.assertEqual(offending_socket_lines(output), [])

    def test_lan_remote_local_wildcard_and_unparseable_fail_with_original_line(self):
        names = [
            ('192.168.0.4:1234 (LISTEN)', 'IPv4'),
            ('127.0.0.1:1234->192.168.0.4:5678 (ESTABLISHED)', 'IPv4'),
            ('192.168.0.4:1234->127.0.0.1:5678 (ESTABLISHED)', 'IPv4'),
            ('*:1234 (LISTEN)', 'IPv4'),
            ('[::]:1234 (LISTEN)', 'IPv6'),
            ('[::1]:1234->[fe80::123%en0]:5678 (ESTABLISHED)', 'IPv6'),
            ('[::ffff:192.168.0.4]:1234', 'IPv6'),
            ('unreadable endpoint', 'IPv4'),
        ]
        for name, family in names:
            with self.subTest(name=name):
                line = row(name, family)
                self.assertEqual(offending_socket_lines(line), [line])

    def test_inspection_failure_is_latched(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            guard = NodeSocketGuard(Evidence(tmp))
            process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
            try:
                with patch('two_node_network.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'permission denied')):
                    guard.add('fixture', process)
                self.assertTrue(guard.report()['failures'])
                with self.assertRaisesRegex(AssertionError, 'socket guard'):
                    guard.require_clean()
            finally:
                process.terminate(); process.wait(timeout=5)
                guard.close()

    def test_captured_violation_is_not_lost_when_process_exits_during_lsof(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            guard = NodeSocketGuard(Evidence(tmp))
            process = Mock(pid=123)
            process.poll.side_effect = [None, 0]
            line = row('192.168.0.4:1234 (LISTEN)')
            output = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n' + line
            guard.processes['fixture'] = process
            with patch('two_node_network.subprocess.run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                guard.sample('before-stop')
            self.assertTrue(guard.report()['failures'])
            self.assertIn(line, (Path(tmp)/'node-sockets.jsonl').read_text())


@unittest.skipUnless(sys.platform == 'darwin', 'native macOS lsof integration')
class LiveSocketGuardTests(unittest.TestCase):
    def spawn(self, host):
        code = '''import socket,sys,time
s=socket.socket();s.bind((sys.argv[1],0));s.listen()
print(s.getsockname()[1],flush=True)
time.sleep(30)
'''
        process = subprocess.Popen([sys.executable, '-c', code, host], stdout=subprocess.PIPE, text=True)
        self.addCleanup(process.stdout.close)
        self.addCleanup(lambda: process.poll() is None and (process.terminate(), process.wait(timeout=5)))
        self.assertTrue(process.stdout.readline().strip())
        return process

    def test_live_loopback_samples_during_and_before_shutdown(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            guard = NodeSocketGuard(Evidence(tmp), interval=.05)
            try:
                process = self.spawn('127.0.0.1')
                guard.add('fixture', process)
                deadline = time.monotonic() + 5
                while guard.report()['periodic_samples'] == 0 and time.monotonic() < deadline:
                    time.sleep(.05)
                guard.sample('before-stop')
                guard.require_clean()
                report = guard.report()
                self.assertGreater(report['periodic_samples'], 0)
                self.assertGreater(report['before_stop_samples'], 0)
                self.assertGreater(report['socket_lines'], 0)
                self.assertFalse(report['failures'])
            finally:
                guard.close()

    def test_live_wildcard_listener_fails_with_offending_line(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            guard = NodeSocketGuard(Evidence(tmp))
            try:
                process = self.spawn('0.0.0.0')
                guard.add('fixture', process)
                with self.assertRaisesRegex(AssertionError, 'socket guard'):
                    guard.require_clean()
                self.assertIn('*:', json.dumps(guard.report()['failures']))
                self.assertIn('(LISTEN)', (Path(tmp)/'node-sockets.jsonl').read_text())
            finally:
                guard.close()

    def test_live_lan_remote_detected_after_clean_start(self):
        interfaces = subprocess.check_output(['/sbin/ifconfig', '-a'], text=True)
        addresses = re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)', interfaces)
        host = next((address for address in addresses if not address.startswith('127.')), None)
        if host is None:
            self.skipTest('no active non-loopback IPv4 interface')
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp, socket.socket() as listener:
            listener.bind((host, 0)); listener.listen()
            code = '''import socket,sys,time
s=socket.socket();s.bind(('127.0.0.1',0))
print('ready',flush=True);sys.stdin.readline()
s.connect((sys.argv[1],int(sys.argv[2])))
print('connected',flush=True);sys.stdin.readline()
s.close();print('closed',flush=True);time.sleep(30)
'''
            process = subprocess.Popen([sys.executable, '-c', code, host, str(listener.getsockname()[1])],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            guard = NodeSocketGuard(Evidence(tmp), interval=.05)
            try:
                self.assertEqual(process.stdout.readline().strip(), 'ready')
                guard.add('fixture', process)
                guard.require_clean()
                process.stdin.write('\n'); process.stdin.flush()
                self.assertEqual(process.stdout.readline().strip(), 'connected')
                deadline = time.monotonic() + 5
                while not guard.report()['failures'] and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertIn('->' + host + ':', json.dumps(guard.report()['failures']))
                process.stdin.write('\n'); process.stdin.flush()
                self.assertEqual(process.stdout.readline().strip(), 'closed')
                guard.sample('before-stop')
                with self.assertRaisesRegex(AssertionError, 'socket guard'):
                    guard.require_clean()  # A later clean snapshot must not clear failure.
            finally:
                guard.close()
                process.terminate(); process.wait(timeout=5)
                process.stdin.close(); process.stdout.close()

    def test_original_runner_final_check_sets_exit_one_and_cleans_up(self):
        import ast
        source = (Path(__file__).parent/'two-node-mock-harness.sh').read_text()
        runner = source.split("<<'PY'\n", 1)[1].rsplit('\nPY\n', 1)[0]
        tree = ast.parse(runner)
        lifecycle = next(node for node in tree.body if isinstance(node, ast.Try))
        # Execute the real finalization and stop() against a synthetic sleeper.
        # It creates its wildcard socket only immediately before finalization.
        setup = '''
network_guard.interval = 60
fixture = "import socket,sys,time; print('ready',flush=True); sys.stdin.readline(); s=socket.socket(); s.bind(('0.0.0.0',0)); s.listen(); print('bound',flush=True); time.sleep(30)"
nodes['fixture'] = subprocess.Popen([sys.executable, '-c', fixture], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
process = nodes['fixture']
assert process.stdout.readline().strip() == 'ready'
network_guard.add('fixture', process)
network_guard.require_clean()
process.stdin.write('\\n'); process.stdin.flush()
assert process.stdout.readline().strip() == 'bound'
exit_code = 0
'''
        lifecycle.body = ast.parse(setup).body
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            path = Path(tmp)/'runner.py'
            path.write_text(ast.unparse(tree))
            import os
            result = subprocess.run([sys.executable, str(path), tmp, tmp, 'genome-test', 'app-test'],
                                    env={**os.environ, 'PYTHONPATH': str(Path(__file__).parent.resolve())},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            summary = json.loads((Path(tmp)/'summary.json').read_text())
            self.assertEqual(summary['exit_code'], 1)
            self.assertTrue(summary['cleanup_complete'])
            self.assertIn('*:', result.stdout)
            self.assertTrue(summary['network_observation']['failures'])
            self.assertEqual(len((Path(tmp)/'processes.jsonl').read_text().splitlines()), 1)


if __name__ == '__main__':
    unittest.main()
