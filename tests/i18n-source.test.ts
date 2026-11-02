import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { SAMPLE_ROOMS, SAMPLE_ROOM_ID } from '../src/control/sample';

// Onboarding and App remain covered by onboarding-copy.test.ts.
const roots = ['src/control', 'src/assistant'];
const names = new Set(['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'label', 'stays', 'alt', 'summary', 'detailNote', 'note', 'fallback', 'source', 'after']);
// Brands, units and protocol examples do not change with the app language.
const exact = new Set(['Bit', 'Sov', 'BS', 'BTC', 'Mac', 'Touch ID', 'STUN', 'API', 'Dansk', 'English', 'Ollama', 'bytes', '{0} bytes', 'srflx(STUN)', 'stun:host:3478', 'bitsov://front-door#…', 'bitsov://sponsor-request#…', 'bitsov://introduce#…', 'bitsov://invite/…', 'example.com']);
// These are mirrored in the host's signed/biometric consent prompt, not app copy.
const consentScopes = new Set(['sats', 'span', 'approvalDate', 'termLines', 'approvalReason', 'TRIP_TEXT']);
// Exact internal sentinels / persisted wire values. Keep comparisons stable and
// translate at the display boundary. No file-wide or component-wide exemption.
const protocol: Record<string, Record<string, string[]>> = {
  'control/Shell.tsx': {
    NOT_A_VOICE_NOTE: ['not a voice note'], FILE_TOO_LARGE: ['file over 1.4 MB'], FILE_NOT_STORED: ['not stored'],
  },
  'control/call.ts': { createCallEngine: ['NotFoundError'], RECOVERY_CLOSING: ['Your last call is still closing. End it, then call again.'] },
  // M6 A1: the placeholder session description that carries the node-routed marker (wire bytes, never shown).
  'control/nodeRoutedConnection.ts': { nodeRoutedSdp: ['o=bitsov 0 0 IN IP4 0.0.0.0', 'c=IN IP4 0.0.0.0'] },
  // M6 P3: the copied call report is a fixed English record set beside the node journal (the button and confirmation are translated).
  'control/callReport.ts': {
    callReportLines: ['BitSov call report', 'app record; compare with the node journal', 'clock: this device', 'block_receipts: count and sum only; seq, amount and time of each are in the node journal'],
  },
  'control/readiness.ts': { readinessSource: ['not_ready'], MONEY_NOT_READY: ['Money is not ready yet. Your node will retry automatically.'] },
  'control/polling.ts': { pollingSource: ['Shell closed', 'Shell stopped'] },
  'control/wallet.ts': { artifactActivity: ['Paid an invoice', 'Paid a node directly', 'Invoice · {0}'], activityLabel: ['Invoice · '] },
  'control/StarterBalance.tsx': { StarterStep: ['storage', 'request', 'read'] },
  'control/Shell.tsx#errors': { ReceivedFile: ['large', 'gone', 'save'] },
  'control/sample.ts': {
    SAMPLE_PEERS: ['Gamma VM'],
    SAMPLE_READS: ['GET /api/v1/messages?limit=50', 'GET /api/v1/messages?peer=… ({0} contacts)'],
    // Fixed model instructions are payload bytes, shown verbatim in the preview.
    SAMPLE_SYSTEM: ["You answer a person's question about their own BitSov node, using only the JSON they send. Amounts are millisatoshis unless a field says sats. \"withheld\" and \"rounded\" mean the person chose not to share the exact value: do not guess it. If the data does not answer the question, say so in one sentence. Do not ask for more data, keys or passwords. Do not tell them to send or pay anything; the app does that only when they ask it to. Answer in at most four short sentences."],
    sampleSource: ['api v2', 'konsensus grant --op 5a3f0c9e21d4b7a8e6f10c2d', 'front_door_invalid: the node dialed an address this front door does not allow', '# Sample only: no real gift request or owner command.', 'konsensus device approve --op 7c2e91d04b5a3f6e8d1c0b2a --config /Users/you/bitsov/konsensus.toml', '/messages/compose failed (400): Recipient is offline. Message will be queued and sent when they reconnect.', 'insufficient payment: required 2000 msat, got 1000 msat', 'payment not found', 'voice note not stored on this node', 'file not stored on this node', 'file over 1.4 MB'],
  },
};

function violations(file: string, source: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    let value: string | undefined;
    if (ts.isJsxText(n)) value = n.text.trim();
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) value = n.text;
    if (ts.isTemplateExpression(n)) value = n.head.text + n.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join('');
    if (value && /[A-Za-z]/.test(value) && !exact.has(value)) {
      const parents: ts.Node[] = [];
      for (let p = n.parent; p; p = p.parent) parents.push(p);
      const scopes = parents.filter(p => ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)).map(p => (p as ts.FunctionDeclaration | ts.VariableDeclaration).name?.getText(ast));
      const allowed = (file === 'control/ownerApproval.ts' && scopes.some(s => consentScopes.has(s ?? ''))) || scopes.some(s => s && (protocol[file]?.[s]?.includes(value!) || protocol[`${file}#errors`]?.[s]?.includes(value!)));
      const attr = parents.find(ts.isJsxAttribute);
      const literalKey = ts.isCallExpression(n.parent) && ['t', 'tr'].includes(n.parent.expression.getText(ast)) && n.parent.arguments[0] === n;
      const comparison = ts.isBinaryExpression(n.parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.parent.operatorToken.kind);
      const structural = ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isLiteralTypeNode(n.parent) || ts.isCaseClause(n.parent) || comparison || literalKey || (ts.isPropertyAssignment(n.parent) && n.parent.name === n);
      // Only error-message arguments, not error codes stored in an explicit map.
      const error = parents.some(p => (ts.isCallExpression(p) && /^set(?:[A-Z]\w*)?(?:Error|Err)$/.test(p.expression.getText(ast))) || (ts.isNewExpression(p) && p.expression.getText(ast) === 'Error') || (ts.isThrowStatement(p) && p.expression === n));
      const prose = /[A-Za-z]+\s+[A-Za-z]+/.test(value);
      const expressionParents = parents.slice(0, parents.findIndex(ts.isJsxExpression));
      const indirect = expressionParents.some(p => ts.isCallExpression(p) || ts.isElementAccessExpression(p) || ts.isArrowFunction(p));
      const jsxValue = ts.isJsxText(n) || (!!attr && ts.isStringLiteral(n) && n.parent === attr && names.has(attr.name.getText(ast))) || (parents.some(ts.isJsxExpression) && !indirect);
      // CSS/DOM selectors and protocol paths are code, not labels.
      const selector = parents.some(p => ts.isCallExpression(p) && /\.(?:querySelector(?:All)?|closest|matches)$/.test(p.expression.getText(ast)));
      if (!allowed && !structural && !selector && (!attr || names.has(attr.name.getText(ast))) && (jsxValue || error || prose)) {
        const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1;
        found.push(`${file}:${line}: ${value}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return found;
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) && !/Copy\.ts$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
}
it('rejects hardcoded display copy and local UI errors throughout migrated folders', () => {
  expect(roots.flatMap(files).flatMap(file => violations(file.slice(4), readFileSync(file, 'utf8')))).toEqual([]);
});
it('catches text, accessible names, conditional labels and interpolation', () => {
  expect(violations('test.tsx', 'function Demo() { return <button title="Pay now">Pay now {ready ? "Retry" : `Pay ${amount} now`}</button>; }')).toHaveLength(4);
});
it('catches display props and fallback labels', () => {
  expect(violations('test.tsx', '<Organ source="Local status"><Show fallback="Unknown">{value}</Show></Organ>')).toHaveLength(2);
});
it('catches local UI errors, including one-word errors and interpolation', () => {
  expect(violations('test.ts', 'function fail() { setError("Failed"); setError(ok ? null : "Try again"); throw new Error(`Could not load ${name}`); }')).toHaveLength(3);
});
it('allows translated copy and node errors without hiding new local errors', () => {
  expect(violations('test.tsx', 'function Demo() { setError(result.error.message); throw new Error(t("loadFailed", name)); return <button aria-label={t("retry")}>{t("retry")}</button>; }')).toEqual([]);
  expect(violations('control/Shell.tsx', 'function ReceivedFile() { setErr("Unexpected failure"); }')).toHaveLength(1);
});
it('parses TypeScript generics as code, not JSX text', () => {
  expect(violations('test.ts', 'const run = <T>(fn: () => Promise<T>): Promise<T> => fn();')).toEqual([]);
});
it('removes the dated sample room and uses a plain hub title', () => {
  expect(SAMPLE_ROOMS.some(room => room.id === SAMPLE_ROOM_ID)).toBe(false);
  expect(readFileSync('src/control/sample.ts', 'utf8')).not.toContain('Mexico build');
  expect(readFileSync('src/control/HubTrust.tsx', 'utf8')).not.toContain('"What MindLink\'s hub can and can\'t do"');
});
