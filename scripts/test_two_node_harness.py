"""Regression tests: evidence must not retain runtime credentials or hide failures."""
import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent


def runner_namespace(directory):
    source = (SCRIPTS / 'two-node-mock-harness.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY\n', 1)[0]
    tree = ast.parse(source)
    # Load definitions/setup only; never execute the node lifecycle.
    body = []
    for node in tree.body:
        if isinstance(node, ast.Try):
            break
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef, ast.Assign)):
            body.append(node)
    with patch.object(sys, 'argv', ['runner', str(directory), str(directory), 'genome-test', 'app-test']):
        ns = {}
        exec(compile(ast.Module(body=body, type_ignores=[]), '<harness>', 'exec'), ns)
    return ns


class HarnessEvidenceTests(unittest.TestCase):
    def test_config_and_http_never_persist_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ns = runner_namespace(root)
            roots = {n: root / n for n in ('a', 'b')}
            for path in roots.values(): path.mkdir()
            ns.update(ROOTS=roots, ids={'a': 'a'*64, 'b': 'b'*64},
                      ports={'a': [12340, 12341], 'b': [12342, 12343]},
                      secrets={'a': 'fixture-signing-secret', 'b': 'other-secret'}, phase='strict-price-open')
            ns['config']('a', True)
            runtime = (roots['a'] / 'konsensus.toml').read_text()
            self.assertIn('fixture-signing-secret', runtime)
            self.assertNotIn('fixture-signing-secret', (root / 'strict-price-open-a.toml').read_text())
            class Response:
                status = 200
                def read(self): return b'{"token":"response-token-secret","preimage":"payment-preimage-secret","amount_msat":2000}'
                def getheaders(self): return [('Set-Cookie', 'session-secret')]
            class Connection:
                def __init__(self, *args, **kwargs): pass
                def request(self, method, path, raw, headers):
                    self.headers = headers
                    assert headers['Authorization'] == 'Bearer request-token-secret'
                def getresponse(self): return Response()
                def close(self): pass
            with patch.object(ns['http'].client, 'HTTPConnection', Connection):
                status, response = ns['req']('a', 'POST', '/pair/token', token='request-token-secret', expect=200)
            self.assertEqual(response['token'], 'response-token-secret')
            evidence = (root / 'http.jsonl').read_text() + json.dumps(ns['checks'])
            for secret in ('request-token-secret', 'response-token-secret', 'payment-preimage-secret', 'session-secret'):
                self.assertNotIn(secret, evidence)
            self.assertIn('2000', evidence)

    def test_evidence_scan_rejects_injected_secrets(self):
        module_path = SCRIPTS / 'two_node_evidence.py'
        self.assertTrue(module_path.exists(), 'post-run evidence scanner is required')
        spec = importlib.util.spec_from_file_location('two_node_evidence', module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cases = ['Authorization: Bearer abcdefgh', 'jwt_secret = "signing-secret"',
                 '{"token":"opaque-secret"}', '{"payment_preimage":"' + 'a'*64 + '"}',
                 'macaroon = "AgEEbG5k-secret"', 'mnemonic = "abandon '*12 + '"',
                 '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
                 'GRANT spend TO abc CODE ' + 'b'*64,
                 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.abcdefghijk',
                 json.dumps({'response_body': json.dumps({'token': 'opaque-secret'})})]
        for secret in cases:
            with self.subTest(secret_type=secret.split()[0]), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)
                (path / 'injected.log').write_text(secret)
                evidence = module.Evidence(path)
                self.assertFalse(evidence.scan(), 'secret must fail scan')
                self.assertFalse((path / 'injected.log').exists(), 'unsafe artifact must be removed')

    def test_redactor_handles_nested_json_and_split_console_codes(self):
        module_path = SCRIPTS / 'two_node_evidence.py'
        self.assertTrue(module_path.exists(), 'central redactor is required')
        spec = importlib.util.spec_from_file_location('two_node_evidence', module_path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            evidence = module.Evidence(Path(temp))
            evidence.remember('abandon '*11 + 'about')
            evidence.write('nested.json', {'response_body': json.dumps({'nested': {'admin_token': 'admin-secret', 'macaroon': 'macaroon-secret'}}), 'mnemonic': 'abandon '*11 + 'about'})
            phrase = 'GRANT spend TO op-id CODE ' + 'a'*64
            grants = {}
            capture = module.ConsoleCapture(evidence, 'node.log', grants)
            for piece in (phrase[:30], phrase[30:70], phrase[70:]+'\nordinary startup\n'):
                capture.feed(piece.encode())
            capture.finish()
            self.assertEqual(grants['op-id'], phrase)
            persisted = ''.join(p.read_text() for p in Path(temp).iterdir())
            for secret in ('admin-secret', 'macaroon-secret', 'a'*64, 'abandon abandon'):
                self.assertNotIn(secret, persisted)
            self.assertIn('ordinary startup', persisted)
            self.assertTrue(evidence.scan())

    def test_receiver_waits_for_plaintext_cache_after_envelope_arrives(self):
        with tempfile.TemporaryDirectory() as temp:
            ns = runner_namespace(Path(temp))
            early = [{'id': 'message', 'ciphertext': 'encrypted'}]
            ready = [{'id': 'message', 'ciphertext': 'encrypted', 'plaintext': 'hello'}]
            def wait_for(node, path, predicate):
                for rows in (early, ready):
                    if predicate(rows): return rows
                raise AssertionError('no receiver-ready state')
            ns['wait_for'] = wait_for
            ns['assert_received']({'message_id': 'message'}, 'hello')

    def test_pairing_console_code_is_secret(self):
        import two_node_evidence as module
        with tempfile.TemporaryDirectory() as temp:
            evidence = module.Evidence(Path(temp))
            capture = module.ConsoleCapture(evidence, 'node.log', {})
            capture.feed(b'bitsov pairing code for "pair-id": ABCD-EF12\n')
            capture.finish()
            self.assertNotIn('ABCD-EF12', (Path(temp)/'node.log').read_text())
            (Path(temp)/'injected.log').write_text('bitsov pairing code for "id": UVWX-YZ12')
            self.assertFalse(evidence.scan())

    def test_unquoted_secret_values_leave_no_fragments(self):
        import two_node_evidence as module
        with tempfile.TemporaryDirectory() as temp:
            evidence = module.Evidence(Path(temp))
            cases = [('mnemonic = abandon ability able about above absent', 'ability'),
                     ('payment_preimage = [10, 11, 12, 13]', '11'),
                     ('Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'),
                     ('private-key: abcsecret', 'abcsecret')]
            for index, (raw, fragment) in enumerate(cases):
                evidence.write(str(index)+'.log', raw)
                self.assertNotIn(fragment, (Path(temp)/(str(index)+'.log')).read_text())
            self.assertTrue(evidence.scan())

    def test_scanner_refuses_missing_or_symlink_root(self):
        import two_node_evidence as module
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertFalse(module.Evidence(root/'missing').scan())
            (root/'link').symlink_to(root)
            self.assertFalse(module.Evidence(root/'link').scan())

    def test_private_key_console_block_is_never_written_even_before_scan(self):
        import two_node_evidence as module
        with tempfile.TemporaryDirectory() as temp:
            evidence = module.Evidence(Path(temp))
            capture = module.ConsoleCapture(evidence, 'node.log', {})
            capture.feed(b'-----BEGIN PRIVATE KEY-----\n')
            capture.feed(b'synthetic-private-key-payload\n')
            before = ''.join(p.read_text() for p in Path(temp).iterdir())
            self.assertNotIn('synthetic-private-key-payload', before)
            capture.feed(b'-----END PRIVATE KEY-----\nnormal log\n')
            capture.finish()
            after = ''.join(p.read_text() for p in Path(temp).iterdir())
            self.assertNotIn('PRIVATE KEY', after)
            self.assertIn('normal log', after)

    def test_evidence_remains_valid_json_with_nested_token_bodies(self):
        import two_node_evidence as module
        with tempfile.TemporaryDirectory() as temp:
            evidence = module.Evidence(Path(temp))
            body = {'response_body': json.dumps({'token': 'fixture-secret', 'scopes': ['read'], 'challenge': 'bitsov-pair-token-v1:fixture'}),
                    'request_headers': {'Authorization': 'Bearer fixture-bearer'}, 'amount_msat': 2000}
            evidence.write('summary.json', {'checks': [body]})
            parsed = json.loads((Path(temp)/'summary.json').read_text())
            self.assertEqual(json.loads(parsed['checks'][0]['response_body'])['scopes'], ['read'])
            self.assertEqual(parsed['checks'][0]['amount_msat'], 2000)
            self.assertTrue(evidence.scan())
            (Path(temp)/'broken.json').write_text('{bad json}')
            self.assertFalse(evidence.scan(), 'invalid structured evidence must fail closed')

    def test_shell_cancellation_waits_for_runner_cleanup(self):
        import os
        import signal
        import time
        source = (SCRIPTS/'two-node-mock-harness.sh').read_text()
        supervision = source[source.index('known_gaps=0'):source.index('# These named capabilities')]
        with tempfile.TemporaryDirectory(dir='/tmp') as temp:
            root = Path(temp); work = root/'runtime'; work.mkdir(); evidence = root/'evidence'; evidence.mkdir()
            child = root/'child.py'
            child.write_text("import os,signal,sys,time\nfrom pathlib import Path\nroot=Path(sys.argv[1])\ndef stop(*args):\n time.sleep(.1)\n (root/'cleaned').touch()\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\n(root/'ready').write_text(str(os.getpid()))\nwhile True: time.sleep(.1)\n")
            wrapper = root/'wrapper.sh'
            import shlex
            wrapper.write_text('set -euo pipefail\nWORK='+shlex.quote(str(work))+'\nEVIDENCE='+shlex.quote(str(evidence))+'\nSCRIPT_DIR='+shlex.quote(str(SCRIPTS))+'\n'+supervision+'\n'+shlex.quote(sys.executable)+' '+shlex.quote(str(child))+' '+shlex.quote(temp)+' &\nrunner_pid=$!\nwait "$runner_pid"\nrunner_pid=\'\'\n')
            process = subprocess.Popen(['bash', str(wrapper)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            pid = None
            try:
                deadline = time.monotonic()+5
                while not (root/'ready').exists() and time.monotonic()<deadline: time.sleep(.02)
                self.assertTrue((root/'ready').exists())
                pid = int((root/'ready').read_text())
                process.send_signal(signal.SIGTERM)
                _, errors = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 1, errors)
                self.assertTrue((root/'cleaned').exists(), 'runner must finish before runtime removal')
                self.assertFalse(work.exists())
                with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            finally:
                if process.poll() is None: process.kill(); process.wait()
                if pid:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_unexpected_tool_failure_is_one_and_removes_build_root(self):
        import os
        import shutil
        with tempfile.TemporaryDirectory(dir='/tmp') as temp:
            root = Path(temp); genome = root/'genome'; genome.mkdir()
            for path in ('crates/konsensus-lightning/src/shared_mock.rs', 'crates/konsensus-core/src/admission_quote.rs', 'crates/konsensus-api/src/file_staging.rs'):
                file = genome/path; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
            subprocess.run(['git', 'init', '-q', str(genome)], check=True)
            subprocess.run(['git', '-C', str(genome), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(genome), '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'capabilities fixture'], check=True)
            fake_bin = root/'bin'; fake_bin.mkdir()
            cargo = fake_bin/'cargo'
            cargo.write_text('#!/bin/sh\necho "token = compiler-secret"\nexit 101\n'); cargo.chmod(0o700)
            result = subprocess.run(['bash', str(SCRIPTS/'two-node-mock-harness.sh'), str(genome)],
                                    env={**os.environ, 'PATH':str(fake_bin)+os.pathsep+os.environ['PATH']}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            evidence = Path(result.stdout.strip().split('Evidence: ')[-1])
            self.assertNotIn('compiler-secret', (evidence/'build.log').read_text())
            self.assertFalse(Path((evidence/'runtime-root.txt').read_text().strip()).exists())
            self.assertEqual(evidence.stat().st_mode & 0o777, 0o700)
            shutil.rmtree(evidence)
            result = subprocess.run(['bash', str(SCRIPTS/'two-node-mock-harness.sh'), str(root/'absent')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)

    def test_plain_main_known_gaps_and_dirty_checkout_exit_status(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temp:
            root = Path(temp)
            subprocess.run(['git', 'init', '-q', temp], check=True)
            subprocess.run(['git', '-C', temp, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-qm', 'plain main fixture'], check=True)
            command = ['bash', str(SCRIPTS / 'two-node-mock-harness.sh'), temp]
            for flags in ([], ['--allow-known-gaps']):
                result = subprocess.run(command + flags, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('Known genome gaps', result.stderr)
                # Remove only the fresh evidence directory returned by this run.
                evidence = Path(result.stdout.strip().split('Evidence: ')[-1])
                self.assertTrue(str(evidence).startswith('/tmp/bitsov-t1-evidence.'))
                import shutil
                shutil.rmtree(evidence)
            (root / 'dirty').write_text('untracked')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('must be clean', result.stderr)


if __name__ == '__main__':
    unittest.main()
