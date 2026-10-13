import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from '../store/state';
import { transactions } from '../store/transactions';
import { palettePlugin } from './palette-plugin';

const {
  openPalette,
  closePalette,
  setPaletteQuery,
  togglePaletteAllDrives,
  movePaletteActive,
  setPaletteActive,
} = palettePlugin.transactions;

const palette = (state: UiState) => {
  const { paletteOpen, paletteQuery, paletteAllDrives, paletteActive } = state.resources;
  return { paletteOpen, paletteQuery, paletteAllDrives, paletteActive };
};

const typed = (query: string, active = 0): UiState =>
  setPaletteActive(setPaletteQuery(openPalette(createInitialState(), undefined), query), active);

describe('palettePlugin', () => {
  test('the empty shell', () => {
    assert({
      given: 'a new shell',
      should: 'keep the palette closed, empty and on the open drive',
      actual: palette(createInitialState()),
      expected: { paletteOpen: false, paletteQuery: '', paletteAllDrives: false, paletteActive: 0 },
    });
  });

  test('registered with the shell', () => {
    assert({
      given: 'the shell’s merged transactions',
      should: 'include the palette’s',
      actual: transactions.openPalette === openPalette && transactions.movePaletteActive === movePaletteActive,
      expected: true,
    });
  });

  test('opening and closing', () => {
    const open = openPalette(createInitialState(), undefined);
    assert({
      given: 'a palette opened, then closed with a query typed and the third row highlighted',
      should: 'open empty, and close back to empty with the highlight at the top',
      actual: [palette(open), palette(closePalette(typed('road', 2), undefined))],
      expected: [
        { paletteOpen: true, paletteQuery: '', paletteAllDrives: false, paletteActive: 0 },
        { paletteOpen: false, paletteQuery: '', paletteAllDrives: false, paletteActive: 0 },
      ],
    });
  });

  test('no change', () => {
    const open = typed('road', 1);
    const closed = createInitialState();
    assert({
      given: 'an open palette opened again, a closed one closed, and the same query and row set again',
      should: 'return the same snapshot each time',
      actual: [
        openPalette(open, undefined) === open,
        closePalette(closed, undefined) === closed,
        setPaletteQuery(open, 'road') === open,
        setPaletteActive(open, 1) === open,
      ],
      expected: [true, true, true, true],
    });
  });

  test('typing', () => {
    assert({
      given: 'a query typed while the third row was highlighted',
      should: 'hold the query and highlight the top of the new list',
      actual: palette(setPaletteQuery(typed('ro', 2), 'roa')),
      expected: { paletteOpen: true, paletteQuery: 'roa', paletteAllDrives: false, paletteActive: 0 },
    });
  });

  test('every drive', () => {
    const once = togglePaletteAllDrives(typed('road', 2), undefined);
    assert({
      given: '"Include all workspaces" ticked, then cleared',
      should: 'search every drive with the highlight at the top, then the open drive again, keeping the query',
      actual: [palette(once), palette(togglePaletteAllDrives(once, undefined))],
      expected: [
        { paletteOpen: true, paletteQuery: 'road', paletteAllDrives: true, paletteActive: 0 },
        { paletteOpen: true, paletteQuery: 'road', paletteAllDrives: false, paletteActive: 0 },
      ],
    });
  });

  test('moving the highlight', () => {
    const at = (active: number, by: number, count: number) =>
      movePaletteActive(typed('road', active), { by, count }).resources.paletteActive;
    assert({
      given: 'three results: down from the top, down from the last, up from the top, and any move through none',
      should: 'step down, wrap to the top, wrap to the last, and stay at the top',
      actual: [at(0, 1, 3), at(2, 1, 3), at(0, -1, 3), at(0, 1, 0)],
      expected: [1, 0, 2, 0],
    });
  });

  test('pure', () => {
    const state = typed('road', 1);
    movePaletteActive(state, { by: 1, count: 3 });
    togglePaletteAllDrives(state, undefined);
    closePalette(state, undefined);
    assert({
      given: 'a snapshot moved, toggled and closed into new ones',
      should: 'leave the original as it was',
      actual: palette(state),
      expected: { paletteOpen: true, paletteQuery: 'road', paletteAllDrives: false, paletteActive: 1 },
    });
  });
});
