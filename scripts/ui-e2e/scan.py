"""Final text/credential scan plus validation of offline-rendered media.

Images/video derive exclusively from already-scanned, redacted DOM snapshots.
Scan their bytes for credential patterns too; this is not OCR or a universal
secret detector. Unknown binary artifacts fail closed in Evidence.scan().
"""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from two_node_evidence import Evidence


def scan(root):
    evidence = Evidence(root)
    if evidence.root.is_symlink() or not evidence.root.is_dir():
        return False
    media = []
    passed = True
    # Hide only validated media from the UTF-8 text scanner, in private memory.
    for path in evidence.root.rglob('*'):
        if path.is_symlink() or not path.is_file() or path.suffix not in ('.png', '.webm'):
            continue
        data = path.read_bytes()
        magic = b'\x89PNG\r\n\x1a\n' if path.suffix == '.png' else b'\x1aE\xdf\xa3'
        text = data.decode('latin1')
        if data.startswith(magic) and evidence.text(text) == text:
            media.append((path, data))
        else:
            passed = False
        path.unlink()
    passed = evidence.scan() and passed
    if passed:
        for path, data in media:
            path.write_bytes(data)
    summary_path = evidence.root / 'summary.json'
    if summary_path.is_file() and not summary_path.is_symlink():
        summary = json.loads(summary_path.read_text())
        summary['final_scan_passed'] = passed
        if not passed:
            summary['exit_code'] = 1
        evidence.write('summary.json', summary)
    return passed


if __name__ == '__main__':
    sys.exit(0 if scan(sys.argv[1]) else 1)
