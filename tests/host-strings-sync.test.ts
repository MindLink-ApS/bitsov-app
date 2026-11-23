import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FIRST_RUN_PHONE_MESSAGE } from '../src/onboarding/pairing';

// Host refusals the UI reads by text must say the same thing on both sides, and call the home node "box".
const rust = (file: string) => readFileSync(`src-tauri/src/${file}`, 'utf8');
const constant = (source: string, name: string) => source.match(new RegExp(`pub const ${name}: &str = "([^"]*)";`))?.[1];

it('keeps the unclaimed-box status identical on the host and the phone', () => {
  expect(rust('remote_access.rs')).toContain(`Self::Unclaimed => f.write_str(${JSON.stringify(FIRST_RUN_PHONE_MESSAGE)})`);
});

it('keeps the not-stored refusals matchable and the same as the sample source', () => {
  const act = rust('act.rs');
  const sample = readFileSync('src/control/sample.ts', 'utf8');
  for (const name of ['VOICE_NOT_STORED', 'FILE_NOT_STORED']) {
    const text = constant(act, name)!;
    // Shell.tsx recognises a missing file by this substring.
    expect(text).toContain('not stored');
    expect(sample).toContain(`'${text}'`);
  }
});

it('says box, not node, in the money and approval refusals', () => {
  const act = rust('act.rs');
  for (const name of ['MONEY_NOT_READY', 'READMISSION_CAPPED', 'READMISSION_CAPPED_RETRY', 'OPERATION_MISMATCH', 'PAYMENT_UNKNOWN', 'FAILED_PAID', 'VOICE_NOT_STORED', 'FILE_NOT_STORED']) {
    expect(constant(act, name), name).toBeTruthy();
    expect(constant(act, name), name).not.toMatch(/\bnode\b/i);
  }
  expect(rust('app.rs')).not.toMatch(/Approve at the node instead/);
  expect(rust('device.rs')).not.toMatch(/approvals are off on your node/);
});
