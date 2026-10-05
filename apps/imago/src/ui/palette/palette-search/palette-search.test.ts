import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { PALETTE_SEARCH, resultsFrom, searchPath } from './palette-search';

describe('searchPath()', () => {
  test('the open drive', () => {
    assert({
      given: 'a query in drive d-1',
      should: 'ask apps/web’s search for that drive’s pages, the query trimmed and escaped',
      actual: searchPath({ query: '  road map & co ', driveId: 'd-1', allDrives: false }),
      expected: `${PALETTE_SEARCH}?q=road+map+%26+co&types=page&driveId=d-1`,
    });
  });

  test('every drive', () => {
    assert({
      given: '"Include all workspaces" ticked, with or without an open drive',
      should: 'ask for every drive the viewer can reach and name none',
      actual: [
        searchPath({ query: 'road', driveId: 'd-1', allDrives: true }),
        searchPath({ query: 'road', driveId: null, allDrives: true }),
      ],
      expected: [
        `${PALETTE_SEARCH}?q=road&types=page&crossDrive=true`,
        `${PALETTE_SEARCH}?q=road&types=page&crossDrive=true`,
      ],
    });
  });

  test('nothing to ask', () => {
    assert({
      given: 'an empty or blank query, or no drive to search and not every drive',
      should: 'ask nothing',
      actual: [
        searchPath({ query: '', driveId: 'd-1', allDrives: false }),
        searchPath({ query: '   ', driveId: 'd-1', allDrives: true }),
        searchPath({ query: 'road', driveId: null, allDrives: false }),
      ],
      expected: [null, null, null],
    });
  });
});

describe('resultsFrom()', () => {
  test('the server’s pages', () => {
    assert({
      given: 'the search’s pages of each kind, in its order',
      should: 'keep each page’s id, title, type and drive, in the same order',
      actual: resultsFrom([
        { id: 'p-1', label: 'Roadmap', type: 'page', data: { pageType: 'DOCUMENT', driveId: 'd-1' }, description: 'document' },
        { id: 'p-2', label: 'road-crew', type: 'page', data: { pageType: 'CHANNEL', driveId: 'd-2' } },
        { id: 'p-3', label: 'Road tasks', type: 'page', data: { pageType: 'TASK_LIST', driveId: 'd-1' } },
        { id: 'p-4', label: 'Road agent', type: 'page', data: { pageType: 'AI_CHAT', driveId: 'd-1' } },
      ]),
      expected: [
        { id: 'p-1', title: 'Roadmap', pageType: 'DOCUMENT', driveId: 'd-1' },
        { id: 'p-2', title: 'road-crew', pageType: 'CHANNEL', driveId: 'd-2' },
        { id: 'p-3', title: 'Road tasks', pageType: 'TASK_LIST', driveId: 'd-1' },
        { id: 'p-4', title: 'Road agent', pageType: 'AI_CHAT', driveId: 'd-1' },
      ],
    });
  });

  test('only what can be opened', () => {
    assert({
      given: 'people (one even carrying a page’s fields), a page with an unknown type, one with no drive, a malformed row and an error body',
      should: 'list none of them, and add nothing of its own',
      actual: [
        resultsFrom([
          { id: 'u-1', label: 'Ada', type: 'user', data: {} },
          { id: 'u-2', label: 'Grace', type: 'user', data: { pageType: 'DOCUMENT', driveId: 'd-1' } },
          { id: 'p-1', label: 'Old', type: 'page', data: { pageType: 'MACHINE', driveId: 'd-1' } },
          { id: 'p-2', label: 'Lost', type: 'page', data: { pageType: 'DOCUMENT' } },
          null,
          'p-3',
        ]),
        resultsFrom({ error: 'Access denied to the specified drive' }),
        resultsFrom(undefined),
      ],
      expected: [[], [], []],
    });
  });

  test('a page with no title', () => {
    assert({
      given: 'a page whose title is empty',
      should: 'call it Untitled rather than draw an empty row',
      actual: resultsFrom([{ id: 'p-1', label: '  ', type: 'page', data: { pageType: 'DOCUMENT', driveId: 'd-1' } }]),
      expected: [{ id: 'p-1', title: 'Untitled', pageType: 'DOCUMENT', driveId: 'd-1' }],
    });
  });
});
