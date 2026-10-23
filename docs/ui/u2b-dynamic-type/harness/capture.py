"""Native WKWebView evidence and overflow regression check; no transaction buttons."""
import subprocess, time, pathlib, json, sys, os
DEVICE = os.environ.get('DEVICE', '71E314A6-5C92-4507-994B-7F7E67DE9495')
BUNDLE = 'tech.mindlink.dynamictypepreview'
out = pathlib.Path('docs/ui/u2b-dynamic-type')

def sim(*args, check=True):
    return subprocess.run(['xcrun', 'simctl', *args], check=check, capture_output=True, text=True)

def capture(size, lang, scene):
    name = f'ios-{lang}-{scene}-{size}'
    sim('terminate', DEVICE, BUNDLE, check=False)
    data = sim('get_app_container', DEVICE, BUNDLE, 'data').stdout.strip()
    geometry_file = pathlib.Path(data, 'Documents/geometry.json')
    geometry_file.unlink(missing_ok=True)
    started = time.time() * 1000
    sim('launch', DEVICE, BUNDLE, '--scene='+scene, *(['--da'] if lang == 'da' else []))
    time.sleep(4)
    if scene == 'first-spend':
        with open('.cache/u2b/'+name+'.log', 'w') as log:
            subprocess.run(['xcodebuild', 'test-without-building', '-only-testing:DynamicTypeEvidence/DynamicTypeEvidence/testKeyboard', '-project', '.cache/u2b/DynamicTypeEvidence.xcodeproj', '-scheme', 'DynamicTypeEvidence', '-destination', 'platform=iOS Simulator,id='+DEVICE, '-derivedDataPath', '.cache/u2b/build', 'CODE_SIGNING_ALLOWED=NO'], stdout=log, stderr=subprocess.STDOUT, check=True)
    data = sim('get_app_container', DEVICE, BUNDLE, 'data').stdout.strip()
    # Reject stale or incompletely mounted pages, including the same scene/language
    # left by an earlier capture. No preview edits while this matrix is running.
    for attempt in range(60):
        try:
            result = json.loads(geometry_file.read_text())
            if (result['generatedAt'] > started and result['ready'] and result['scene'] == scene
                and result['lang'] == lang and result['rootFont'] == ('53px' if size == 'ax5' else '17px')):
                break
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(.5)
    else:
        raise RuntimeError(f'{name}: fresh, ready WKWebView geometry not received')
    result['contentSize'] = sim('ui', DEVICE, 'content_size').stdout.strip()
    result['device'] = DEVICE
    assert result['scene'] == scene and result['lang'] == lang, result
    sim('io', DEVICE, 'screenshot', str(out/(name+'.png')))
    (out/(name+'.json')).write_text(json.dumps(result, indent=2)+'\n')
    print(name, 'root', result['rootFont'], 'body', result['bodyFont'], 'failures', len(result['failures']), flush=True)
    return result

sim('install', DEVICE, '.cache/u2b/DynamicTypePreview.app')
results = []
try:
    for size, category in [('default', 'large'), ('ax5', 'accessibility-extra-extra-extra-large')]:
        sim('ui', DEVICE, 'content_size', category)
        for lang in ['en', 'da']:
            for scene in ['chat', 'wallet', 'first-spend', 'settings', 'approval']:
                if len(sys.argv) > 1 and scene not in sys.argv[1:]: continue
                results.append(capture(size, lang, scene))
finally:
    sim('ui', DEVICE, 'content_size', 'large')
for result in results:
    assert result['viewport']['scale'] == 1, result
    assert result['elements'], 'vacuous geometry check'
    assert not result['failures'], (result['scene'], result['lang'], result['failures'])
    assert all(float(m['font'][:-2]) >= 15 for m in result['minimums']), result['minimums']
    if result['scene'] == 'first-spend': assert result['keyboard'] == 'true', result
for default, ax in zip(results[:len(results)//2], results[len(results)//2:]):
    assert float(ax['rootFont'][:-2]) > float(default['rootFont'][:-2]), 'OS size did not reach WKWebView'
    assert float(ax['bodyFont'][:-2]) > float(default['bodyFont'][:-2]), 'body did not scale'
    if default['scene'] in ['chat', 'first-spend']:
        assert float(ax['space'][:-2]) > float(default['space'][:-2]), 'spacing did not scale'
print('Native Dynamic Type and overflow checks passed')
