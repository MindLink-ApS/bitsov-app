import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { SAMPLE_ROOMS, SAMPLE_ROOM_ID } from '../src/control/sample';

// The first migration is deliberately bounded. Add a component here when moving
// it to the table; identifiers, protocol tokens and user/node data are not copy.
const scopes: Record<string, string[]> = {
  'Shell.tsx': ['SettingsDisplay', 'CallSettings', 'Rail', 'TrackHead', 'PayeeLine', 'MessageView', 'ArtifactView', 'RequestCard', 'DELIVERY_TEXT', 'CallNetworkNote', 'CallButtons', 'CallPanel', 'AmountField', 'InCallPay', 'Composer', 'TouchIdFirst', 'SpendBar', 'DeviceSetup', 'TouchApproval', 'Reconcile', 'BudgetBar'],
  'WalletPage.tsx': ['ReceiveView', 'WalletPage', 'ActivityView', 'SendView', 'AmountInput', 'CopyButton', 'KIND_FILTERS', 'DIRECTION_FILTERS'],
  'OnCallPill.tsx': ['OnCallPill', 'CALL_STATE_WORD'],
  'state.ts': ['undeliveredCopy', 'admissionCopy', 'nodePill', 'spendLine', 'costToSend', 'peerName', 'peerNotReadyMessage'],
  'HubTrust.tsx': ['HubTrust', 'HubTrustInfo', 'HubChannelConfirm'],
  'custody.tsx': ['custodyBadge'],
};
const names = new Set(['aria-label', 'title', 'placeholder', 'label', 'stays']);
// Brands, language autonyms and protocol input examples deliberately stay exact.
const exact = new Set(['Bit', 'Sov', 'BS', 'BTC', 'Mac', 'Touch ID', 'STUN', 'Dansk', 'English', 'stun:host:3478']);
function violations(file: string, source: string, functions: string[]) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const inScope = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name && functions.includes(p.name.getText(ast))) return true;
    }
    // Settings header is nested inside the otherwise unmigrated ControlCenter.
    return file === 'Shell.tsx' && n.getStart(ast) >= source.indexOf('      <aside\n        ref={setSettingsEl}') && n.end <= source.indexOf('        <Switch>', source.indexOf('      <aside\n        ref={setSettingsEl}'));
  };
  const visit = (n: ts.Node) => {
    if (inScope(n)) {
      let value: string | undefined;
      if (ts.isJsxText(n)) value = n.text.trim();
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const p = n.parent;
        if (ts.isJsxAttribute(p) && names.has(p.name.getText(ast))) value = n.text;
        // Also catch English in ternaries, return values, errors and label maps.
        if (!ts.isJsxAttribute(p) && /[A-Za-z]+\s+[A-Za-z]+/.test(n.text) && !/[\[\].#=]/.test(n.text.slice(0, 2))) value = n.text;
      }
      if (ts.isTemplateExpression(n) && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(n.getText(ast).replace(/\$\{[^}]*\}/g, ''))) value = n.getText(ast);
      if (value && /[A-Za-z]/.test(value) && !exact.has(value)) {
        const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1;
        found.push(`${file}:${line}: ${value}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return found;
}
it('rejects hardcoded display copy in migrated components', () => {
  const found = Object.entries(scopes).flatMap(([file, functions]) => violations(file, readFileSync(`src/control/${file}`, 'utf8'), functions));
  expect(found).toEqual([]);
});
it('the guard catches text, accessible names and dynamic English', () => {
  expect(violations('test.tsx', 'function Demo() { return <button title="Pay now">Pay now {ready ? "Try again" : `Pay ${amount} now`}</button>; }', ['Demo']).length).toBeGreaterThanOrEqual(3);
});
it('removes the dated sample room and uses a plain hub title', () => {
  expect(SAMPLE_ROOMS.some(room => room.id === SAMPLE_ROOM_ID)).toBe(false);
  expect(readFileSync('src/control/sample.ts', 'utf8')).not.toContain('Mexico build');
  expect(readFileSync('src/control/HubTrust.tsx', 'utf8')).not.toContain('"What MindLink\'s hub can and can\'t do"');
});
