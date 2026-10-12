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
