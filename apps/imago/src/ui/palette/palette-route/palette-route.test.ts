import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { PaletteResult } from '../palette-search/palette-search';
import { destinationFor } from './palette-route';

const result = (pageType: PaletteResult['pageType'], overrides: Partial<PaletteResult> = {}): PaletteResult => ({
  id: 'p-1',
  title: 'Roadmap',
  pageType,
  driveId: 'd-1',
  ...overrides,
});

describe('destinationFor()', () => {
  test('each kind of page', () => {
    assert({
      given: 'a document, a folder, a sheet, a channel and a task list',
      should: 'open each where imago keeps it in its own drive: files, files, files, messages and tasks',
      actual: [
        destinationFor(result('DOCUMENT')),
        destinationFor(result('FOLDER')),
        destinationFor(result('SHEET')),
        destinationFor(result('CHANNEL')),
        destinationFor(result('TASK_LIST')),
      ],
      expected: [
        { href: '/d-1/files/p-1', agent: null },
        { href: '/d-1/files/p-1', agent: null },
        { href: '/d-1/files/p-1', agent: null },
        { href: '/d-1/messages/p-1', agent: null },
        { href: '/d-1/tasks/p-1', agent: null },
      ],
    });
  });

  test('an agent', () => {
    assert({
      given: 'an agent',
      should: 'open its drive’s chat talking to that agent',
      actual: destinationFor(result('AI_CHAT', { id: 'a-1', title: 'Planner', driveId: 'd-2' })),
      expected: { href: '/d-2', agent: { id: 'a-1', title: 'Planner' } },
    });
  });

  test('ids stay one segment', () => {
    assert({
      given: 'ids holding a slash and a query',
      should: 'escape each into its own segment',
      actual: destinationFor(result('DOCUMENT', { id: 'p/../x', driveId: 'd?1' })).href,
      expected: '/d%3F1/files/p%2F..%2Fx',
    });
  });
});
