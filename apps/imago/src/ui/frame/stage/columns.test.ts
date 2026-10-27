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

  test('every rail destination: the sidebar alone leaves Imago the ground', () => {
    const indexes = ['/d1', '/d1/files', '/d1/messages', '/d1/tasks', '/d1/calendar', '/d1/agents', '/d1/workflows', '/d1/activity', '/d1/members', '/d1/trash', '/d1/settings', '/account', '/dm'];
    assert({
      given: 'each section’s own address, with nothing hidden',
      should: 'open no middle and make Imago the ground with Close Imago',
      actual: indexes.map((path) => {
        const columns = columnsFor(stageFor(path), ui());
        return [columns.page, columns.imago, columns.closeImago, columns.closePage];
      }),
      expected: indexes.map(() => [false, 'ground', true, false]),
    });
  });

  test('every rail destination: an object from the sidebar docks Imago and can be closed', () => {
    const selections = ['/d1/files/p1', '/d1/messages/c1', '/d1/tasks/view/today', '/d1/tasks/l1', '/d1/calendar/view', '/d1/members/all', '/d1/settings/general', '/account/display', '/dm/c1'];
    assert({
      given: 'something picked in each sidebar',
      should: 'open the middle, dock Imago beside it and offer Close page',
      actual: selections.map((path) => {
        const columns = columnsFor(stageFor(path), ui());
        return [columns.page, columns.imago, columns.closePage];
      }),
      expected: selections.map(() => [true, 'docked', true]),
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
