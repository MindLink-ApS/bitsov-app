import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Phone alerts are local: the app posts them itself while it runs. No push service (Apple's
// APNs, Google's FCM, or a third party) is set up, so no outside service learns when a message
// or call arrives, from whom, or even that the app has activity. A push path would be a privacy
// and product decision of its own (an owner decision with its own review), never a side effect
// of adding a dependency. These checks fail the moment any piece of one appears.

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

it('iOS: no push entitlement and no remote-notification or VoIP background mode', () => {
  for (const path of ['src-tauri/Entitlements.plist', 'src-tauri/gen/apple/bitsov-app_iOS/bitsov-app_iOS.entitlements', 'src-tauri/gen/apple/project.yml']) {
    expect(read(path), path).not.toMatch(/aps-environment/);
  }
  for (const path of ['src-tauri/Info.ios.plist', 'src-tauri/gen/apple/bitsov-app_iOS/Info.plist', 'src-tauri/gen/apple/project.yml']) {
    const text = read(path);
    expect(text, path).not.toMatch(/remote-notification/);
    expect(text, path).not.toMatch(/<string>voip<\/string>|-\s*voip\b/);
  }
});

it('Android: no Firebase or Google push in the manifest, the build or the project files', () => {
  const android = 'src-tauri/gen/android';
  const manifest = read(`${android}/app/src/main/AndroidManifest.xml`);
  for (const marker of [/firebase/i, /c2dm/i, /\bMESSAGING_EVENT\b/, /com\.google\.android\.gms/]) {
    expect(manifest, 'AndroidManifest.xml').not.toMatch(marker);
  }
  for (const path of [`${android}/build.gradle.kts`, `${android}/app/build.gradle.kts`, `${android}/buildSrc/build.gradle.kts`]) {
    const text = read(path);
    // Push-specific only: the barcode scanner's ML Kit model (play-services-mlkit-…) is not push.
    expect(text, path).not.toMatch(/firebase|google-services|play-services-(gcm|iid|cloud-messaging)|com\.google\.gms\.google-services/i);
  }
  expect(existsSync(join(root, `${android}/app/google-services.json`))).toBe(false);
});

const PUSH_PACKAGE = /firebase|onesignal|pusher|web-push|expo-notifications|push-notifications|@capacitor\/push|\bapns\b|\bfcm\b/i;

it('no push library in the JavaScript dependencies', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string> | undefined>;
  const names = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
  expect(names.filter((name) => PUSH_PACKAGE.test(name))).toEqual([]);
});

it('no push crate in the Rust manifests or the lockfile', () => {
  const crates = /^(a2|apns[\w-]*|fcm[\w-]*|firebase[\w-]*|web-push|onesignal[\w-]*|tauri-plugin-push[\w-]*|tauri-plugin-remote-push[\w-]*)$/;
  for (const path of ['src-tauri/Cargo.toml', 'src-tauri/ffi/Cargo.toml']) {
    const deps = [...read(path).matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
    expect(deps.filter((name) => crates.test(name)), path).toEqual([]);
  }
  const locked = [...read('src-tauri/Cargo.lock').matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1]);
  expect(locked.filter((name) => crates.test(name))).toEqual([]);
});

it('the native code never registers for remote notifications or VoIP push', () => {
  const dir = join(root, 'src-tauri/native');
  const swift = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.swift'));
  expect(swift.length).toBeGreaterThan(0);
  for (const file of swift) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(text, file).not.toMatch(/registerForRemoteNotifications|PKPushRegistry|PushKit|didRegisterForRemoteNotifications/);
  }
});
