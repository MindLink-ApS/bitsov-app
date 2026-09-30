"""Redact before persistence; fail closed on evidence that bypasses the writer.

Runtime values stay in memory/private node data. The scanner recognizes secret
fields, credential encodings and every secret registered during this run; it is
not a general-purpose detector for arbitrary, unlabeled unknown random bytes.
"""
import json
from pathlib import Path
import re
import threading

REDACTED = '<redacted>'
SECRET_KEY = re.compile(r'(?:authorization|cookie|token|secret|password|passphrase|mnemonic|seed|preimage|macaroon|private[_.-]?key|grant_phrase)', re.I)
JWT = re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b')
BEARER = re.compile(r'(?i)\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+')
# Owner console codes for a spend grant or a front-door grant (genome front_door scope).
GRANT = re.compile(r'GRANT (?:spend|front_door) TO ([\w-]+) CODE ([0-9a-f]{64})')
PEM = re.compile(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)', re.S)
# Handles TOML, JSON and common log key=value/key: value representations.
FIELD = re.compile(r'''(?ix)(["']?\b[\w-]*(?:authorization|cookie|token|secret|password|passphrase|mnemonic|seed|preimage|macaroon|private[_.-]?key)[\w-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\r\n]+)''')
PAIR_CODE = re.compile(r'bitsov pairing code for [^\r\n]*?:\s*[A-Z0-9]{4}-[A-Z0-9]{4}', re.I)
PATTERNS = (JWT, BEARER, GRANT, PEM, PAIR_CODE)


class Evidence:
    def __init__(self, root):
        self.root = Path(root)
        self.known = set()
        self.lock = threading.RLock()

    def remember(self, value):
        if isinstance(value, str) and value and value != REDACTED:
            with self.lock:
                self.known.add(value)

    def text(self, value):
        with self.lock:
            for secret in sorted(self.known, key=len, reverse=True):
                value = value.replace(secret, REDACTED)
            for pattern in PATTERNS:
                value = pattern.sub(REDACTED, value)
            value = FIELD.sub(lambda m: m[1] + json.dumps(REDACTED), value)
            return value

    def clean(self, value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                safe_key = self.text(str(key))
                if SECRET_KEY.search(str(key)):
                    if isinstance(item, str): self.remember(item)
                    result[safe_key] = REDACTED
                else:
                    result[safe_key] = self.clean(item)
            return result
        if isinstance(value, (tuple, list)):
            # HTTP header pairs need the same treatment as object fields.
            if len(value) == 2 and isinstance(value[0], str) and SECRET_KEY.search(value[0]):
                self.remember(value[1])
                return [value[0], REDACTED]
            return [self.clean(item) for item in value]
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                return self.text(value)
            if isinstance(parsed, (dict, list)):
                return json.dumps(self.clean(parsed))
            return self.text(value)
        return value

    def write(self, name, value, append=False):
        # No caller-provided subpaths or existing symlinks may become sinks.
        path = self.root / name
        if Path(name).name != name or path.is_symlink():
            raise ValueError('unsafe evidence path')
        with self.lock:
            cleaned = self.clean(value)
            # A later field may register a value seen earlier in this record.
            # Re-clean the object before serialization: text substitution on
            # serialized JSON could insert unescaped quotes and corrupt it.
            cleaned = self.clean(cleaned)
            data = cleaned if isinstance(cleaned, str) else json.dumps(cleaned, indent=None if append else 2)
            with path.open('a' if append else 'w') as stream:
                stream.write(data + ('\n' if not data.endswith('\n') else ''))

    def scan(self):
        """Return False and remove unsafe artifacts, without reporting their data."""
        if self.root.is_symlink() or not self.root.is_dir():
            return False
        passed = True
        for path in self.root.rglob('*'):
            if path.is_symlink():
                path.unlink()
                passed = False
                continue
            if not path.is_file():
                continue
            try:
                data = path.read_text()
                if path.suffix in ('.json', '.jsonl'):
                    documents = [data] if path.suffix == '.json' else data.splitlines()
                    unsafe = False
                    for document in documents:
                        parsed = json.loads(document)
                        if self.clean(parsed) != parsed:
                            unsafe = True
                else:
                    unsafe = self.text(data) != data
                    # Free-text logs may contain embedded escaped JSON too.
                    for document in [data, *data.splitlines()]:
                        try:
                            parsed = json.loads(document)
                        except ValueError:
                            continue
                        if isinstance(parsed, (dict, list)) and self.clean(parsed) != parsed:
                            unsafe = True
                unsafe |= bool(re.search(r'(?:mnemonic|macaroon|private[_.-]?key|seed)\.(?:txt|bin|pem|key)$', path.name, re.I))
            except (ValueError, OSError):
                unsafe = True
            if unsafe:
                path.unlink()
                passed = False
        return passed


class ConsoleCapture:
    """Buffer complete lines so split PTY reads cannot leak grant codes."""
    def __init__(self, evidence, name, grants):
        self.evidence, self.name, self.grants = evidence, name, grants
        self.pending = b''
        self.discarding = False
        self.private_block = False

    def line(self, raw):
        text = raw.decode('utf-8', errors='replace')
        if re.search(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----', text):
            self.private_block = True
            self.evidence.write(self.name, REDACTED, append=True)
        if self.private_block:
            if re.search(r'-----END (?:[A-Z]+ )?PRIVATE KEY-----', text):
                self.private_block = False
            return
        for match in GRANT.finditer(text):
            self.grants[match[1]] = match[0]
            self.evidence.remember(match[2])
        self.evidence.write(self.name, text, append=True)

    def feed(self, data):
        self.pending += data
        while b'\n' in self.pending:
            line, self.pending = self.pending.split(b'\n', 1)
            if not self.discarding: self.line(line)
            self.discarding = False
        if len(self.pending) > 1024 * 1024:
            # Never flush partial credentials just to enforce a buffer limit.
            self.pending = b''
            self.discarding = True

    def finish(self):
        if self.pending and not self.discarding: self.line(self.pending)
        self.pending = b''


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--scan':
        sys.exit(0 if Evidence(sys.argv[2]).scan() else 1)
    # Cargo output is line-buffered and sanitized before entering evidence.
    if len(sys.argv) == 3 and sys.argv[1] == '--build-log':
        evidence = Evidence(Path(sys.argv[2]).parent)
        capture = ConsoleCapture(evidence, Path(sys.argv[2]).name, {})
        while chunk := sys.stdin.buffer.read1(65536): capture.feed(chunk)
        capture.finish()
    else:
        sys.exit('Usage: two_node_evidence.py --scan DIR | --build-log FILE')
