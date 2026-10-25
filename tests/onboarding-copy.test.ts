import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Exact literals only: remaining legacy consent prompts are unchanged in this round.
// File scoping prevents these exceptions from hiding copy elsewhere.
// The sats unit stays literal.
const literalAllowlist: Record<string, readonly string[]> = {
  'src/onboarding/LockedNode.tsx': [
    'enrolled biometrics', 'faces or fingerprints', 'fingerprints', 'biometric',
    "Unlocked. Remember the password on this",
    "If the",
    "on this",
    "change, the saved copy stops opening. Type the password once more and choose Remember to replace it.",
    "If your device’s approval key also stops working, another approved owner device or the box must unlock the node first. Then set up",
    "approvals again before unlocking from this device.",
    "Not now",
  ],
  'src/onboarding/PairAnotherNode.tsx': [
    "Replace this app’s node?",
    "will no longer be this app’s node.",
    "New node:",
    ", fingerprint",
    "Funds and contacts stay on the old node. You can pair back later with a new ticket from that node.",
    "Nothing changes until you confirm.",
    "Replace node",
    "Cancel",
  ],
  'src/App.tsx': [
    "Local trust — read this before you deposit",
    "Your node is only reachable while this Mac is awake and BitSov is open.",
    "This node trusts every program on this computer. Anything running under your user account can ask it for full access over",
    "— enough to spend what you deposit and read your history. Only fund a node on a machine you control.",
    "Your keys stay in the node. BitSov never shows you your recovery phrase and never copies it anywhere.",
    "Remote trust — read this before you deposit",
    "This node’s keys live on the remote machine. Anyone with access — whoever can log in to that computer — can spend what you deposit. Only fund a node whose host you trust.",
    "I understand — continue to funding",
    "sats",
  ],
  // This existing bilingual G6 consent screen is also deliberately preserved.
  'src/onboarding/PhoneTrust.tsx': [
    "Stoler du på boksens vært?",
    "Do you trust the host of this box?",
    "Værten kan bruge dine indskud.",
    "The host can spend your deposits.",
    "Vent et øjeblik…",
    "Please wait…",
    "Jeg forstår — fortsæt",
    "I understand — continue",
    "Kunne ikke gemme. Prøv igen.",
    "Could not save. Try again.",
    "Andre muligheder",
    "Other options",
    "Tillid til værten",
    "Remote trust",
    "Nøglerne ligger på den anden maskine. Alle, der kan logge ind på den, kan bruge dine indskud. Indsæt kun penge, hvis du stoler på værten.",
    "This node’s keys live on the remote machine. Anyone with access — whoever can log in to that computer — can spend what you deposit. Only fund a node whose host you trust.",
    "Nøglerne bliver i boksen. BitSov viser aldrig din gendannelsessætning og kopierer den aldrig.",
    "Your keys stay in the node. BitSov never shows you your recovery phrase and never copies it anywhere.",
  ],
};

function hardcodedText(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    // Brands/protocol examples must remain recognizable in either language.
    const brands = ['Touch ID', 'Mac', 'iPad', 'iPhone', 'bitsov://pair/…'];
    if (/[a-zA-Z]/.test(text) && !brands.includes(text) && !literalAllowlist[file]?.includes(text)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      found.push(file + ':' + line + ': ' + text);
    }
  };
  const renderedExpression = (node: ts.Expression) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) report(node, node.text);
    else if (ts.isTemplateExpression(node)) report(node, node.head.text + node.templateSpans.map(span => span.literal.text).join(' '));
    else if (ts.isConditionalExpression(node)) { renderedExpression(node.whenTrue); renderedExpression(node.whenFalse); }
    else if (ts.isParenthesizedExpression(node)) renderedExpression(node.expression);
    // Calls, property reads and identifiers are translated copy or dynamic node/user data.
  };
  function visit(node: ts.Node) {
    // Reject labels and fragments too, so inline markup cannot evade the guard.
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) renderedExpression(node.expression);
    if (ts.isJsxAttribute(node) && ['aria-label', 'title', 'placeholder', 'summary', 'detailNote'].includes(node.name.getText(ast))) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text);
      if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) renderedExpression(node.initializer.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}
function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}
it('keeps onboarding and App JSX copy in t() (except documented literals)', () => {
  const files = [...tsxFiles('src/onboarding'), 'src/App.tsx'];
  expect(files.flatMap(file => hardcodedText(file, readFileSync(file, 'utf8')))).toEqual([]);
});
it('catches sentences, multiline text and fragments around inline elements', () => {
  expect(hardcodedText('example.tsx', '<p>Connect your node.</p>')).toHaveLength(1);
  expect(hardcodedText('example.tsx', '<p>Connect\n your node.</p>')).toHaveLength(1);
  expect(hardcodedText('example.tsx', '<p>Connect <b>{name}</b> now.</p>')).toHaveLength(2);
  expect(hardcodedText('example.tsx', "<p>{t('connect', name)}{/* A comment is not copy. */}</p>")).toEqual([]);
});

it('also catches literal expressions, conditional copy and accessible names', () => {
  expect(hardcodedText('example.tsx', '<p>{"Connect your node."}</p>')).toHaveLength(1);
  expect(hardcodedText('example.tsx', '<p>{ready ? "Setup complete" : "Please wait"}</p>')).toHaveLength(2);
  expect(hardcodedText('example.tsx', '<p>{`Connect ${name} now`}</p>')).toHaveLength(1);
  expect(hardcodedText('example.tsx', '<button aria-label="Connect your node" />')).toHaveLength(1);
});
