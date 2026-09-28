"""Regression probes for the UI runner; no production node or credentials."""
import ast
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def load_runner(root):
    path = SCRIPTS / 'ui-e2e/runner.py'
    tree = ast.parse(path.read_text())
    # Load plumbing without running the real window scenario.
    cut = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.FunctionDef) and n.name == 'interrupted')
    module = types.ModuleType('ui_runner_test')
    module.__file__ = str(path)
    with patch.object(sys, 'argv', [str(path), str(root), str(SCRIPTS.parent), '/fake/konsensus']):
        exec(compile(ast.Module(body=tree.body[:cut], type_ignores=[]), str(path), 'exec'), module.__dict__)
    return module


class UiHarnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.r = load_runner(self.root)

    def test_fixture_ceiling_covers_both_first_contact_charges(self):
        import tomllib
        self.r.ROOTS = {'a': self.root / 'a', 'b': self.root / 'b'}
        for root in self.r.ROOTS.values(): root.mkdir()
        self.r.ids = {'a': 'a' * 64, 'b': 'b' * 64}
        self.r.ports = {'a': [3141, 5001], 'b': [5002, 5003]}
        self.r.secrets = {'a': 'synthetic-a-secret', 'b': 'synthetic-b-secret'}
        self.r.config('a')
        self.r.config('b')
        a = tomllib.loads((self.r.ROOTS['a'] / 'konsensus.toml').read_text())
        b = tomllib.loads((self.r.ROOTS['b'] / 'konsensus.toml').read_text())
        # Current main uses A's own price as its unknown-peer aggregate ceiling.
        self.assertGreaterEqual(a['pricing']['chat_msat'], 2 * b['pricing']['chat_msat'])


    def test_pair_token_response_is_returned_but_never_persisted(self):
        token = 'synthetic-opaque-paired-token'
        class Connection:
            def __init__(self, *a, **kw): pass
            def request(self, *a): pass
            def getresponse(self): return types.SimpleNamespace(status=200, read=lambda: json.dumps({'token': token}).encode())
            def close(self): pass
        self.r.ports['a'] = [3141]
        with patch.object(http.client, 'HTTPConnection', Connection):
            self.assertEqual(self.r.api('a', 'POST', '/pair/token', anonymous=True)[1]['token'], token)
        self.assertNotIn(token, (self.root / 'node-http.jsonl').read_text())

    def test_split_console_grant_stays_in_memory_and_pair_code_is_redacted(self):
        code = 'ab' * 32
        phrase = 'GRANT spend TO op-test CODE ' + code
        source = 'import os,time; os.write(1,b"GRANT spend TO op-test CODE "); time.sleep(.05); os.write(1,' + repr((code + '\nbitsov pairing code for "test": ABCD-1234\n').encode()) + ')'
        proc = self.r.in_pty('app', [sys.executable, '-c', source], self.root, os.environ.copy())
        proc.wait(timeout=5)
        time.sleep(.2)
        self.assertEqual(self.r.node_a_owner_phrase('op-test', seconds=.2), phrase)
        output = (self.root / 'app.log').read_text()
        self.assertNotIn(code, output)
        self.assertNotIn('ABCD-1234', output)

    def test_ui_and_snapshot_are_sanitized(self):
        secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature'
        class Connection:
            def __init__(self, *a, **kw): pass
            def request(self, *a): pass
            def getresponse(self): return types.SimpleNamespace(read=lambda: json.dumps({'ok': True, 'value': {'html': '<p>' + secret + '</p>', 'width': 800, 'height': 600, 'scheme': 'dark'}}).encode())
            def close(self): pass
        self.r.SHOTS.mkdir()
        with patch.object(http.client, 'HTTPConnection', Connection):
            self.r.snapshot('test')
        self.assertNotIn(secret, ''.join(p.read_text() for p in self.root.rglob('*') if p.is_file()))

    def test_preflight_refusal_does_not_signal_any_process(self):
        tree = ast.parse((SCRIPTS / 'ui-e2e/runner.py').read_text())
        main_try = next((n for n in tree.body if isinstance(n, ast.Try)), None)
        calls = []
        self.r.ROOTS = {'a': self.root}
        self.r.__dict__['exit_code'] = 1
        self.r.__dict__['interrupted'] = lambda *a: None
        with patch.object(subprocess, 'run', side_effect=lambda argv, **kw: calls.append(argv)), patch.object(os, 'killpg', side_effect=lambda *a: calls.append(a)), patch.object(self.r.signal, 'signal'):
            if main_try:
                exec(compile(ast.Module(body=[main_try], type_ignores=[]), '<main>', 'exec'), self.r.__dict__)
            else:
                # Refactored main is import safe.
                ns = self.r.__dict__
                for n in tree.body:
                    if isinstance(n, ast.FunctionDef) and n.name in ('interrupted', 'main'):
                        exec(compile(ast.Module(body=[n], type_ignores=[]), '<main>', 'exec'), ns)
                self.r.main()
        self.assertEqual(calls, [])

    def test_stop_reaps_children_when_launcher_already_exited(self):
        import signal
        child_file = self.root / 'child.pid'
        source = ('import subprocess,signal; from pathlib import Path; '
                  'signal.signal(signal.SIGHUP, signal.SIG_IGN); '
                  'p=subprocess.Popen(["/bin/sleep","60"]); '
                  f'Path({str(child_file)!r}).write_text(str(p.pid))')
        proc = self.r.in_pty('app', [sys.executable, '-c', source], self.root, os.environ.copy())
        proc.wait(timeout=5)
        child = int(child_file.read_text())
        def running():
            state = subprocess.run(['/bin/ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True)
            return state.returncode == 0 and 'Z' not in state.stdout
        try:
            self.assertTrue(running())
            self.r.stop('app', grace=.2)
            self.assertFalse(running(), 'owned grandchild survived its launcher')
        finally:
            if running(): os.kill(child, signal.SIGKILL)

    def test_capture_write_failure_still_leaves_owned_child_stoppable(self):
        from unittest.mock import Mock
        self.r.evidence.write = Mock(side_effect=OSError('synthetic disk failure'))
        with self.assertRaises(OSError):
            self.r.in_pty('app', ['/bin/sleep', '60'], self.root, os.environ.copy())
        proc = self.r.procs['app']
        try:
            self.assertEqual(os.getpgid(proc.pid), proc.pid)
        finally:
            self.r.evidence.write = lambda *a, **kw: None
            self.r.stop('app', grace=.2)


    def test_sanitized_multiline_command_evidence_passes_final_scan(self):
        output = types.SimpleNamespace(returncode=0, stdout='Initialized\nMnemonic: /private/runtime/mnemonic.txt\nDone\n')
        with patch.object(subprocess, 'run', return_value=output):
            self.r.run('synthetic-init')
        self.assertTrue(self.r.evidence.scan())


    def test_failed_pid_inspection_of_live_node_latches_guard_failure(self):
        failed = types.SimpleNamespace(returncode=1, stdout='', stderr='inspection unavailable')
        with patch.object(subprocess, 'run', return_value=failed), patch.object(os, 'kill', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'inspect'):
                self.r.OwnedNode(123)
        self.assertTrue(self.r.network_guard.failures)

    def test_final_scan_rejects_unredacted_text_and_media_credentials(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ui_scan_test', SCRIPTS / 'ui-e2e/scan.py')
        scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scanner)
        (self.root / 'leaked.json').write_text(json.dumps({'token': 'synthetic-opaque-secret'}))
        (self.root / 'bad.png').write_bytes(b'\x89PNG\r\n\x1a\nBearer synthetic-secret')
        self.assertFalse(scanner.scan(self.root))
        self.assertFalse((self.root / 'leaked.json').exists())
        self.assertFalse((self.root / 'bad.png').exists())

    def test_final_scan_refuses_symlink_root_without_touching_target(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ui_scan_test', SCRIPTS / 'ui-e2e/scan.py')
        scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scanner)
        target = self.root / 'target'
        target.mkdir()
        media = target / 'keep.png'
        media.write_bytes(b'\x89PNG\r\n\x1a\n\x00\xff')
        link = self.root / 'link'
        link.symlink_to(target, target_is_directory=True)
        self.assertFalse(scanner.scan(link))
        self.assertTrue(media.exists())


    def test_final_scan_preserves_clean_offline_media_and_rejects_unknown_binary(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ui_scan_test', SCRIPTS / 'ui-e2e/scan.py')
        scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scanner)
        png = b'\x89PNG\r\n\x1a\n\x00\xff'
        (self.root / 'safe.png').write_bytes(png)
        self.assertTrue(scanner.scan(self.root))
        self.assertEqual((self.root / 'safe.png').read_bytes(), png)
        (self.root / 'unknown.bin').write_bytes(b'\xff\x00')
        self.assertFalse(scanner.scan(self.root))
        self.assertFalse((self.root / 'unknown.bin').exists())


    def test_mock_funding_accepts_explanation_without_a_qr(self):
        tree = ast.parse((SCRIPTS.parent / 'tests/e2e/two_node_spec.py').read_text())
        branch = next(n for n in ast.walk(tree) if isinstance(n, ast.If) and ast.unparse(n.test) == 'not qr and status != 200')
        self.r.ui_try = lambda *a, **kw: 'Funding address requires an embedded LDK backend'
        with self.r.Step(1, 'mock funding') as step:
            exec(compile(ast.Module(body=[branch], type_ignores=[]), '<funding>', 'exec'), {
                'r': self.r, 's': step, 'qr': False, 'status': 400,
                'mock_addr': {'error': 'Funding address requires an embedded LDK backend'},
                'shown': 'Funding address requires an embedded LDK backend'})
        self.assertEqual(step.row['status'], 'PASS')

    def test_node_b_launch_and_stop_are_observed_by_guard(self):
        from unittest.mock import Mock
        process = Mock(pid=123, poll=lambda: None)
        self.r.in_pty = lambda *a, **kw: process
        self.r.config = lambda *a: None
        self.r.api = lambda *a: (200, {})
        listing = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nkonsensus 123 u 1u IPv4 d 0t0 TCP 192.168.1.2:3141 (LISTEN)\n'
        with patch.object(subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=listing, stderr='')):
            with self.assertRaisesRegex(AssertionError, 'node socket guard'):
                self.r.start_b()
        self.r.network_guard.close()
        self.assertTrue(self.r.network_guard.failures)


if __name__ == '__main__': unittest.main()
