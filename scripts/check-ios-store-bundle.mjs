import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Run after the iOS release frontend build. Check the emitted artifact so
// dormant starter UI cannot survive behind a permanently false render gate.
const assets = join(process.argv[2] ?? 'dist', 'assets');
const files = (await readdir(assets)).filter(file => file.endsWith('.js'));
assert(files.length > 0, 'No built JavaScript assets found.');
const bundle = (await Promise.all(files.map(file => readFile(join(assets, file), 'utf8')))).join('\n');
for (const marker of [
  'starter_current', 'starter_request', 'data-hub-channel-confirm',
]) {
  assert(!bundle.includes(marker), `Dormant purchase path in iOS store bundle: ${marker}`);
}
// Navigation guards may still name the inert selector. Only rendered starter
// templates represent dormant UI, so distinguish markup from those selectors.
assert(!/<[^<>]*\bdata-starter-(?:balance|entry)(?:[\s=>])/.test(bundle),
  'Dormant starter UI template in iOS store bundle.');
console.log('iOS store bundle: dormant purchase paths absent.');
