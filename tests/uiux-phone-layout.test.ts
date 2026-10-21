import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { samplePeers } from '../src/control/sample';

// UI/UX audit 21 Oct, phone layout at 375 px. happy-dom has no layout, so these
// lock the CSS rules that fix what the 375 px screenshots showed.
const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
const contact = readFileSync(join(__dirname, '../src/control/ContactPanel.tsx'), 'utf8');

/** The body of the last `@media (max-width: <px>)` block that contains `needle`. */
function mediaBlockWith(px: number, needle: string): string {
  const head = `@media (max-width: ${px}px) {`;
  let at = css.indexOf(head);
  let found = '';
  while (at >= 0) {
    let depth = 0;
    let i = at + head.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    const body = css.slice(at, i + 1);
    if (body.includes(needle)) found = body;
    at = css.indexOf(head, i);
  }
  return found;
}

describe('phone layout (375 px)', () => {
  it('the top strip does not show the rail’s empty-state sentences', () => {
    expect(mediaBlockWith(680, '.rail .track-empty')).toMatch(/\.rail \.track-empty \{ display: none; \}/);
  });

  it('the contact key under the QR wraps instead of running off the screen', () => {
    expect(contact).toContain('data-contact-qr-text');
    expect(css).toMatch(/\.contact-panel \[data-contact-qr-text\] \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-all;/);
  });

  it('a status dot stays on the line of its sentence', () => {
    expect(css).toMatch(/\.spend-line > \.dot \{ display: inline-block; vertical-align: middle;/);
    expect(css).toMatch(/\.spend-line:not\(:has\(> \.line-text\)\) \{ display: block; \}/);
  });

  it('watch and meeting checkboxes are thumb-sized on a phone', () => {
    const block = mediaBlockWith(480, '.ai-watches label');
    expect(block).toMatch(/\.ai-watches label, \.meeting-panel \.meeting-legs label \{ min-height: 44px;/);
    expect(block).toMatch(/input\[type='checkbox'\] \{ width: 22px; height: 22px;/);
  });

  it('the meeting planner is held inside the screen and scrolls (rendered check: npm run check:layout)', () => {
    expect(css).toMatch(/\.meeting-panel\[data-meeting-panel='planning'\] \{ max-height: calc\(100dvh - 48px\); overflow-y: auto; \}/);
    expect(readFileSync(join(__dirname, '../scripts/ui-layout/meeting-planner-check.mjs'), 'utf8')).toContain('width: 375, height: 667');
    // `?sample&peers=12`, the list the rendered check uses: 12 distinct contacts.
    const peers = samplePeers(12);
    expect(peers).toHaveLength(12);
    expect(new Set(peers.map((p) => p.node_id)).size).toBe(12);
    expect(peers.every((p) => /^[0-9a-f]{64}$/.test(p.node_id))).toBe(true);
  });

  it('the assistant badge takes its own row on a phone, and the header never shrinks', () => {
    const block = mediaBlockWith(480, '.endpoint-badge');
    expect(block).toMatch(/\.track-head:has\(\.endpoint-badge\) \{ flex-wrap: wrap;/);
    expect(block).toMatch(/\.track-head \.sub:has\(\.endpoint-badge\) \{ order: 3; flex: 1 1 100%; \}/);
    expect(css).toMatch(/\.track-head \{ flex-shrink: 0; \}/);
  });
});
