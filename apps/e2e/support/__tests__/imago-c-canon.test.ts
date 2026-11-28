import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANON_TREE, CANON_FAVORITES, CANON_RECENTS, CANON_TABS, flattenCanon } from '../imago-c/canon';
import { boardReference, BOARD_REFERENCE_DIR } from '../imago-c/board-reference';

describe('CANON story data (IMC-1.1)', () => {
  it('given the Files tree, should list the 19 canon pages in tree order', () => {
    const titles = flattenCanon(CANON_TREE).map((node) => node.title);
    expect(titles).toEqual([
      'Launch', 'Q4 Launch Plan', 'Launch Tasks', 'Pricing Model', 'Waitlist Page', 'Waitlist Signups',
      'pricing-calc.ts', 'launch-ops', 'Launch Agent',
      'Research', 'Research Plan', 'Interviews', 'Interview — Priya.pdf', 'Competitor Notes', 'Research Agent',
      'Brand Voice', 'Onboarding Notes', 'Hiring', 'Inbox Triage',
    ]);
  });

  it('given each canon node, should carry the PageType the board draws', () => {
    const types = Object.fromEntries(flattenCanon(CANON_TREE).map((node) => [node.title, node.type]));
    expect(types).toMatchObject({
      Launch: 'FOLDER', 'Q4 Launch Plan': 'DOCUMENT', 'Launch Tasks': 'TASK_LIST', 'Pricing Model': 'SHEET',
      'Waitlist Page': 'CANVAS', 'pricing-calc.ts': 'CODE', 'launch-ops': 'CHANNEL', 'Launch Agent': 'AI_CHAT',
      'Interview — Priya.pdf': 'FILE',
    });
  });

  it('given favorites, recents and open tabs, should name canon pages only', () => {
    const titles = new Set(flattenCanon(CANON_TREE).map((node) => node.title));
    for (const title of [...CANON_FAVORITES, ...CANON_RECENTS.map((recent) => recent.title), ...CANON_TABS]) {
      expect(titles.has(title), title).toBe(true);
    }
    expect(CANON_RECENTS.map((recent) => recent.minutesAgo)).toEqual([0, 60, 120]);
  });
});

describe('board references (IMC-1.1)', () => {
  it('given a board name, should resolve its committed reference PNG', () => {
    const file = boardReference('C-Files-Doc');
    expect(file.startsWith(BOARD_REFERENCE_DIR)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('given a board state, should resolve Board@state.png', () => {
    expect(boardReference('C-Files-Doc', 'pane-closed')).toMatch(/C-Files-Doc@pane-closed\.png$/);
  });

  it('given a name that is not a board, should refuse it', () => {
    expect(() => boardReference('../etc/passwd')).toThrow(/not a board/);
  });
});
