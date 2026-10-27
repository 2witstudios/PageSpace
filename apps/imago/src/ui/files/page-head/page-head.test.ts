import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { crumbsOf, driveIdOf, isCollaborative } from './page-head-model';

describe('crumbsOf() (IMC-1.9)', () => {
  test('the path from the breadcrumbs route', () => {
    assert({
      given: 'ancestors and the page itself',
      should: 'name each step, the last one the page',
      actual: crumbsOf([{ id: 'launch', title: 'Launch' }, { id: 'plan', title: 'Q4 Launch Plan' }], 'plan', 'DOCUMENT'),
      expected: [
        { id: 'launch', label: 'Launch', current: false },
        { id: 'plan', label: 'Q4 Launch Plan', current: true },
      ],
    });
  });

  test('a channel', () => {
    assert({
      given: 'a channel page',
      should: 'write its own step #name, as tabs do',
      actual: crumbsOf([{ id: 'launch', title: 'Launch' }, { id: 'ops', title: 'launch-ops' }], 'ops', 'CHANNEL').map((crumb) => crumb.label),
      expected: ['Launch', '#launch-ops'],
    });
  });

  test('not loaded, or another page’s trail', () => {
    assert({
      given: 'no trail yet, and a stale trail for a different page',
      should: 'show no crumbs rather than the wrong ones',
      actual: [crumbsOf(undefined, 'plan', 'DOCUMENT'), crumbsOf([{ id: 'x', title: 'X' }], 'plan', 'DOCUMENT')],
      expected: [[], []],
    });
  });
});

describe('isCollaborative()', () => {
  test('presence only on collaborative pages (SPEC v3)', () => {
    assert({
      given: 'every page type',
      should: 'show presence on doc, sheet, code, canvas, task list and channel only',
      actual: ['DOCUMENT', 'SHEET', 'CODE', 'CANVAS', 'TASK_LIST', 'CHANNEL', 'FOLDER', 'FILE', 'AI_CHAT'].map(isCollaborative),
      expected: [true, true, true, true, true, true, false, false, false],
    });
  });
});

describe('driveIdOf() (IMC-9.3)', () => {
  test('the drive a page belongs to, from the page route', () => {
    assert({
      given: 'a page body with its drive id',
      should: 'return the drive id, or null without one',
      actual: [driveIdOf({ driveId: 'd1' }), driveIdOf(undefined), driveIdOf({ title: 'x' })],
      expected: ['d1', null, null],
    });
  });
});
