"""Use the existing media-aware scanner with this run's known credentials."""
import copy
import importlib.util


def install(r):
    if getattr(r.evidence,'media_aware',False): return
    spec = importlib.util.spec_from_file_location('real_ui_media_scan',r.APP/'scripts/ui-e2e/scan.py')
    scanner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scanner)
    # Copy before replacing the method; share the lock and known-secret set.
    original = copy.copy(r.evidence)
    r.evidence.scan = lambda: scanner.scan(r.E,evidence=original)
    r.evidence.media_aware = True
