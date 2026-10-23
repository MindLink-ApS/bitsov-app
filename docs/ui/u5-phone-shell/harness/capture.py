"""Read-only WKWebView matrix; never presses a transaction or approval button."""
import subprocess, time, pathlib, json, os, sys
DEVICE = os.environ.get('DEVICE', '71E314A6-5C92-4507-994B-7F7E67DE9495')
BUNDLE = 'tech.mindlink.phoneshellpreview'
OUT = pathlib.Path('docs/ui/u5-phone-shell')
def sim(*args, check=True):
    return subprocess.run(['xcrun', 'simctl', *args], check=check, capture_output=True, text=True)
def capture(size, lang, scene):
    sim('terminate', DEVICE, BUNDLE, check=False)
    data = sim('get_app_container', DEVICE, BUNDLE, 'data').stdout.strip()
    path = pathlib.Path(data, 'Documents/geometry.json'); path.unlink(missing_ok=True)
    started = time.time() * 1000
    sim('launch', DEVICE, BUNDLE, '--scene='+scene, *(['--da'] if lang == 'da' else []))
    for attempt in range(80):
        time.sleep(.25)
        try:
            result = json.loads(path.read_text())
            if (result['generatedAt'] > started + 2500 and result['ready'] and result['scene'] == scene
                and result['lang'] == lang and result['rootFont'] == ('53px' if size == 'ax5' else '17px')): break
        except (OSError, ValueError, KeyError): pass
    else: raise RuntimeError(f'No fresh geometry: {scene}/{lang}/{size}')
    result['contentSize'] = sim('ui', DEVICE, 'content_size').stdout.strip(); result['device'] = DEVICE
    name = f'ios-{lang}-{scene}-{size}'
    sim('io', DEVICE, 'screenshot', str(OUT/(name+'.png')))
    (OUT/(name+'.json')).write_text(json.dumps(result, indent=2)+'\n')
    print(name, 'root', result['rootFont'], 'failures', len(result['failures']), flush=True)
    return result
sim('install', DEVICE, '.cache/u5/PhoneShellPreview.app')
results = []
try:
    for size, category in [('default','large'), ('ax5','accessibility-extra-extra-extra-large')]:
        sim('ui', DEVICE, 'content_size', category)
        for lang in ['en','da']:
            for scene in ['list','chat','wallet','you','first-spend','offline','repair','contacts-error']:
                if len(sys.argv) > 1 and scene not in sys.argv[1:]: continue
                results.append(capture(size, lang, scene))
finally: sim('ui', DEVICE, 'content_size', 'large')
for result in results:
    assert result['viewport']['scale'] == 1
    assert result['elements'] and not result['failures'], (result['scene'], result['lang'], result['failures'])
    assert result['tabDisplay'] != 'none'
    assert abs(result['tabBar']['bottom'] - result['viewport']['height']) <= 1
print('Native phone shell matrix passed')
