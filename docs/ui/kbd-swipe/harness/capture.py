import subprocess,time,pathlib,json,sys
node='71E314A6-5C92-4507-994B-7F7E67DE9495'
out=pathlib.Path('docs/ui/kbd-swipe')
def sim(*args,check=True): return subprocess.run(['xcrun','simctl',*args],check=check,capture_output=True,text=True)
sim('install',node,'.cache/kbd/KeyboardPreview.app')
for size in ['default']:
 sim('ui',node,'content_size','large')
 for lang in ['en','da']:
  for scene in ['composer','first-spend','first-spend-starts-now','first-spend-may-start-now','pairing']:
   name=f'ios-{lang}-{scene}-{size}'
   if len(sys.argv)>1 and name not in sys.argv[1:]: continue
   sim('terminate',node,'tech.mindlink.keyboardpreview',check=False)
   mode = scene.removeprefix('first-spend-') if scene.startswith('first-spend-') else None
   args = ['--first-spend', '--'+mode] if mode else ['--'+scene]
   data=sim('get_app_container',node,'tech.mindlink.keyboardpreview','data').stdout.strip()
   pathlib.Path(data,'Documents/geometry.json').unlink(missing_ok=True)
   started=time.time()*1000
   sim('launch',node,'tech.mindlink.keyboardpreview',*args,*(['--da'] if lang=='da' else []))
   with open('.cache/kbd/'+name+'.log','w') as log:
    result=subprocess.run(['xcodebuild','test-without-building','-only-testing:KeyboardEvidence/KeyboardEvidence/testKeyboard','-project','.cache/kbd/KeyboardEvidence.xcodeproj','-scheme','KeyboardEvidence','-destination','platform=iOS Simulator,id='+node,'-derivedDataPath','.cache/kbd/build','CODE_SIGNING_ALLOWED=NO'],stdout=log,stderr=subprocess.STDOUT)
   if result.returncode: raise RuntimeError(name+' native keyboard test failed')
   data=sim('get_app_container',node,'tech.mindlink.keyboardpreview','data').stdout.strip()
   geometry=json.loads(pathlib.Path(data,'Documents/geometry.json').read_text())
   assert geometry['generatedAt'] > started, (name, 'stale geometry')
   assert geometry['rootFont'] == '17px' and geometry['bodyFont'] == '17px', (name, 'incorrect default sizes')
   geometry['contentSize'] = sim('ui',node,'content_size').stdout.strip()
   assert geometry['keyboard']=='true', (name,geometry['viewport'])
   assert geometry['viewport']['scale']==1
   if scene.startswith('first-spend'):
    samples = geometry['typing']
    assert samples[0]['value'] == '' and samples[-1]['value'] == '1250', samples
    assert samples[0]['allowDisabled'] and not samples[-1]['allowDisabled'], samples
    assert '1 250' in samples[-1]['daily'].replace('\u202f', ' ') and 'sats' in samples[-1]['daily'], samples[-1]
    fractional = next(sample for sample in samples if sample['value'] == '1250.5')
    assert not fractional['allowDisabled'] and '1 250 500 msat' in fractional['daily'].replace('\u202f', ' '), fractional
    for sample in samples:
     for el in sample['elements']:
      # This WKWebView reports client rects relative to the visible viewport during focus pan.
      assert el['width'] > 0 and el['height'] > 0, (name, 'hidden element', el)
      assert el['top'] >= 0 and el['bottom'] <= sample['viewportHeight'], (name, el)
     for el in sample['elements'][-2:]:
      original = next(x for x in samples[0]['elements'] if x['selector'] == el['selector'])
      assert abs(el['top'] - original['top']) < 1, (name, 'button moved while typing', original, el)
     assert sample['scrollTop'] == samples[0]['scrollTop'], (name, 'scrolled while typing', samples)
   sim('io',node,'screenshot',str(out/(name+'.png')))
   (out/(name+'.json')).write_text(json.dumps(geometry,indent=2)+'\n')
   print('Captured '+name,flush=True)
sim('ui',node,'content_size','large')
