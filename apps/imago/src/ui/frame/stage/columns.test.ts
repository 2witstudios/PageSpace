import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { columnsFor, type ColumnState } from './columns';
import { stageFor } from './stage';

const page = stageFor('/drive1/files/page1');
const index = stageFor('/drive1/files');
const settings = stageFor('/drive1/settings');
const ui = (patch: Partial<ColumnState> = {}): ColumnState => ({
  paneCollapsed: false,
  imagoCollapsed: false,
  imagoClosed: false,
  ...patch,
});

describe('columnsFor() — the C-Files-Doc renderVals machine (IMC-1.3)', () => {
  test('default: three columns', () => {
    assert({
      given: 'a page open and nothing hidden',
      should: 'show the pane, the page and Imago docked with its collapse control',
      actual: columnsFor(page, ui()),
      expected: {
        pane: true,
        page: true,
        imago: 'docked',
        paneSheet: false,
        showSidebarIn: null,
        askPill: false,
        collapseImago: true,
        closeImago: false,
        closePage: true,
      },
    });
  });

  test('sidebar closed beside a page', () => {
    assert({
      given: 'a page open and the pane closed',
      should: 'put Show sidebar at the start of the page head',
      actual: columnsFor(page, ui({ paneCollapsed: true })).showSidebarIn,
      expected: 'page',
    });
  });

  test('Imago collapsed', () => {
    const columns = columnsFor(page, ui({ imagoCollapsed: true }));
    assert({
      given: 'a page open and Imago collapsed',
      should: 'leave the Ask pill in the page head and drop the collapse control',
      actual: [columns.imago, columns.askPill, columns.collapseImago],
      expected: ['collapsed', true, false],
    });
  });

  test('the Tasks index: its list fills the middle, and Imago docks beside it', () => {
    const tasks = stageFor('/drive1/tasks');
    const columns = columnsFor(tasks, ui());
    assert({
      given: 'the Tasks index of a drive with nothing hidden',
      should: 'open the middle column for the list and dock Imago beside it, with no Close Imago',
      actual: [columns.page, columns.imago, columns.collapseImago, columns.closeImago, columns.closePage],
      expected: [true, 'docked', true, false, false],
    });
  });

  test('the Tasks index: Imago collapses to the Ask pill in its head', () => {
    const columns = columnsFor(stageFor('/drive1/tasks'), ui({ imagoCollapsed: true }));
    assert({
      given: 'the Tasks index with Imago collapsed',
      should: 'fold Imago to the Ask pill in the middle head',
      actual: [columns.imago, columns.askPill],
      expected: ['collapsed', true],
    });
  });

  test('page closed', () => {
    const columns = columnsFor(index, ui({ imagoCollapsed: true }));
    assert({
      given: 'no page open, even with Imago collapsed beforehand',
      should: 'make Imago the ground with Close Imago and no collapse or Ask pill',
      actual: [columns.page, columns.imago, columns.closeImago, columns.collapseImago, columns.askPill],
      expected: [false, 'ground', true, false, false],
    });
  });

  test('page and sidebar closed', () => {
    assert({
      given: 'no page open and the pane closed',
      should: 'put Show sidebar at the start of the Imago head',
      actual: columnsFor(index, ui({ paneCollapsed: true })).showSidebarIn,
      expected: 'imago',
    });
  });

  test('empty middle', () => {
    const columns = columnsFor(index, ui({ imagoClosed: true }));
    assert({
      given: 'no page open and Imago closed on the ground',
      should: 'leave the empty middle with no Imago and no close controls',
      actual: [columns.imago, columns.closeImago, columns.showSidebarIn],
      expected: ['none', false, null],
    });
  });

  test('empty middle with the sidebar closed', () => {
    assert({
      given: 'the empty middle and the pane closed',
      should: 'put Show sidebar in the empty head',
      actual: columnsFor(index, ui({ imagoClosed: true, paneCollapsed: true })).showSidebarIn,
      expected: 'empty',
    });
  });

  test('Imago closed only applies on the ground', () => {
    assert({
      given: 'a page open after Imago was closed on the ground',
      should: 'dock Imago again',
      actual: columnsFor(page, ui({ imagoClosed: true })).imago,
      expected: 'docked',
    });
  });

  test('a stage with no pane', () => {
    const noPane = { ...settings, list: 'closed' as const };
    assert({
      given: 'a stage that has no left pane and a collapsed flag set',
      should: 'show no pane and offer no Show sidebar',
      actual: [columnsFor(noPane, ui({ paneCollapsed: true })).pane, columnsFor(noPane, ui({ paneCollapsed: true })).showSidebarIn],
      expected: [false, null],
    });
  });
});

describe('columnsFor() — the responsive tiers (IMC-11.1)', () => {
  test('desktop is the default and docks Imago', () => {
    assert({
      given: 'a page open on desktop',
      should: 'dock Imago and keep the pane a column',
      actual: [columnsFor(page, ui(), 'desktop').imago, columnsFor(page, ui(), 'desktop').paneSheet],
      expected: ['docked', false],
    });
  });

  test('overlay tier: Imago never docks and the pane stays docked', () => {
    const columns = columnsFor(page, ui(), 'overlay');
    assert({
      given: 'a page open at 1024 to 1279',
      should: 'make Imago an overlay with Collapse Imago, keep the pane a column',
      actual: [columns.imago, columns.collapseImago, columns.pane, columns.paneSheet, columns.askPill],
      expected: ['overlay', true, true, false, false],
    });
  });

  test('overlay tier: the scrim or Collapse folds it to the Ask pill', () => {
    const columns = columnsFor(page, ui({ imagoCollapsed: true }), 'overlay');
    assert({
      given: 'the overlay collapsed',
      should: 'show the Ask pill and no collapse control',
      actual: [columns.imago, columns.askPill, columns.collapseImago],
      expected: ['collapsed', true, false],
    });
  });

  test('overlay tier: with the page closed Imago is the ground, then the empty middle', () => {
    assert({
      given: 'the Files index at 1024 to 1279, then Imago closed',
      should: 'make Imago the ground with Close Imago, then leave the middle empty',
      actual: [
        [columnsFor(index, ui(), 'overlay').imago, columnsFor(index, ui(), 'overlay').closeImago],
        columnsFor(index, ui({ imagoClosed: true }), 'overlay').imago,
      ],
      expected: [['ground', true], 'none'],
    });
  });

  test('overlay tier: Show sidebar still moves with the first head', () => {
    assert({
      given: 'the pane closed at each state',
      should: 'name the page head, then the Imago head, then the empty middle',
      actual: [
        columnsFor(page, ui({ paneCollapsed: true }), 'overlay').showSidebarIn,
        columnsFor(index, ui({ paneCollapsed: true }), 'overlay').showSidebarIn,
        columnsFor(index, ui({ paneCollapsed: true, imagoClosed: true }), 'overlay').showSidebarIn,
      ],
      expected: ['page', 'imago', 'empty'],
    });
  });

  test('narrow and phone tiers: the pane is a sheet while open, Imago stays an overlay', () => {
    assert({
      given: 'a page at 800px and at 390px, and the pane closed at 800px',
      should: 'float the pane and Imago, and drop the sheet once closed',
      actual: [
        columnsFor(page, ui(), 'narrow').paneSheet,
        columnsFor(page, ui(), 'narrow').imago,
        columnsFor(page, ui(), 'phone').paneSheet,
        columnsFor(page, ui({ paneCollapsed: true }), 'narrow').paneSheet,
      ],
      expected: [true, 'overlay', true, false],
    });
  });
});
