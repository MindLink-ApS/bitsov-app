"""Real keyboard evidence. XCTest types a draft, with no newline or Send press."""
import subprocess, pathlib, time, json, os
DEVICE = os.environ.get('DEVICE', '71E314A6-5C92-4507-994B-7F7E67DE9495')
BUNDLE = 'tech.mindlink.phoneshellpreview'
def sim(*args, check=True):
    return subprocess.run(['xcrun','simctl',*args],check=check,capture_output=True,text=True)
try:
    for size,category in [('default','large'),('ax5','accessibility-extra-extra-extra-large')]:
        sim('ui',DEVICE,'content_size',category)
        for lang in ['en','da']:
            sim('terminate',DEVICE,BUNDLE,check=False)
            data=sim('get_app_container',DEVICE,BUNDLE,'data').stdout.strip()
            path=pathlib.Path(data,'Documents/geometry.json');path.unlink(missing_ok=True)
            started=time.time()*1000
            sim('launch',DEVICE,BUNDLE,'--scene=keyboard',*(['--da'] if lang=='da' else []))
            time.sleep(3)
            name=f'ios-{lang}-keyboard-{size}'
            with open('.cache/u5/'+name+'.log','w') as log:
                subprocess.run(['xcodebuild','test-without-building','-only-testing:PhoneShellEvidence/PhoneShellEvidence/testKeyboard','-project','.cache/u5/PhoneShellEvidence.xcodeproj','-scheme','PhoneShellEvidence','-destination','platform=iOS Simulator,id='+DEVICE,'-derivedDataPath','.cache/u5/build','CODE_SIGNING_ALLOWED=NO'],stdout=log,stderr=subprocess.STDOUT,check=True)
            result=json.loads(path.read_text())
            assert result['generatedAt']>started and result['ready'] and result['lang']==lang
            assert result['keyboard']=='true' and result['tabDisplay']=='none',result
            assert result['rootFont']==('53px' if size=='ax5' else '17px')
            result['contentSize']=sim('ui',DEVICE,'content_size').stdout.strip();result['device']=DEVICE
            out=pathlib.Path('docs/ui/u5-phone-shell')
            sim('io',DEVICE,'screenshot',str(out/(name+'.png')))
            (out/(name+'.json')).write_text(json.dumps(result,indent=2)+'\n')
            print(name,'keyboard',result['keyboard'],'tabs',result['tabDisplay'],flush=True)
finally: sim('ui',DEVICE,'content_size','large')
