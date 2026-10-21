import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const android = join(__dirname, '../src-tauri/gen/android/app/src/main');
const xml = (path: string) => new DOMParser().parseFromString(readFileSync(join(android, path), 'utf8'), 'text/xml');

it('excludes install-bound identity, pairing and intent receipts from every backup and transfer domain', () => {
  const app = xml('AndroidManifest.xml').querySelector('application')!;
  expect(app.getAttribute('android:allowBackup')).toBe('false');
  for (const [attribute, sections] of [
    ['android:fullBackupContent', ['full-backup-content']],
    ['android:dataExtractionRules', ['cloud-backup', 'device-transfer']],
  ] as const) {
    const resource = app.getAttribute(attribute);
    expect(resource).toMatch(/^@xml\/[a-z_]+$/);
    const rules = xml(`res/xml/${resource!.slice(5)}.xml`);
    for (const section of sections) {
      const policy = rules.querySelector(section)!;
      expect(policy, section).not.toBeNull();
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external',
        'device_root', 'device_file', 'device_database', 'device_sharedpref']) {
        expect(policy.querySelector(`exclude[domain="${domain}"][path="."]`), `${section}: ${domain}`).not.toBeNull();
      }
    }
  }
});
