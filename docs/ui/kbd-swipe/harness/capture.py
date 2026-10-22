import subprocess,time,pathlib,json,sys
node='71E314A6-5C92-4507-994B-7F7E67DE9495'
out=pathlib.Path('docs/ui/kbd-swipe')
def sim(*args,check=True): return subprocess.run(['xcrun','simctl',*args],check=check,capture_output=True,text=True)
sim('install',node,'.cache/kbd/KeyboardPreview.app')
for size in ['default','large']:
 sim('ui',node,'content_size','large' if size=='default' else 'accessibility-extra-extra-extra-large')
 for lang in ['en','da']:
  for scene in ['composer','first-spend','pairing']:
   name=f'ios-{lang}-{scene}-{size}'
   if len(sys.argv)>1 and name not in sys.argv[1:]: continue
   sim('terminate',node,'tech.mindlink.keyboardpreview',check=False)
   sim('launch',node,'tech.mindlink.keyboardpreview','--'+scene,*(['--da'] if lang=='da' else []))
   with open('.cache/kbd/'+name+'.log','w') as log:
    result=subprocess.run(['xcodebuild','test-without-building','-only-testing:KeyboardEvidence/KeyboardEvidence/testKeyboard','-project','.cache/kbd/KeyboardEvidence.xcodeproj','-scheme','KeyboardEvidence','-destination','platform=iOS Simulator,id='+node,'-derivedDataPath','.cache/kbd/build','CODE_SIGNING_ALLOWED=NO'],stdout=log,stderr=subprocess.STDOUT)
   if result.returncode: raise RuntimeError(name+' native keyboard test failed')
   data=sim('get_app_container',node,'tech.mindlink.keyboardpreview','data').stdout.strip()
   geometry=json.loads(pathlib.Path(data,'Documents/geometry.json').read_text())
   assert geometry['keyboard']=='true', (name,geometry['viewport'])
   assert geometry['viewport']['scale']==1
   sim('io',node,'screenshot',str(out/(name+'.png')))
   (out/(name+'.json')).write_text(json.dumps(geometry,indent=2)+'\n')
   print('Captured '+name,flush=True)
sim('ui',node,'content_size','large')
