import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderPalette, type PaletteRenderProps } from './palette.render';

const props = (overrides: Partial<PaletteRenderProps> = {}): PaletteRenderProps => ({
  open: true,
  query: 'road',
  allDrives: false,
  scope: 'Alpha',
  status: 'done',
  rows: [
    { id: 'p-1', title: 'Roadmap', icon: 'page', driveName: null },
    { id: 'p-2', title: 'road-crew', icon: 'hash', driveName: null },
  ],
  active: 1,
  idPrefix: 'pal',
  typeQuery: () => {},
  toggleAllDrives: () => {},
  move: () => {},
  pick: () => {},
  hover: () => {},
  close: () => {},
  ...overrides,
});

const markup = (overrides: Partial<PaletteRenderProps> = {}) => renderToStaticMarkup(renderPalette(props(overrides)));

/** An attribute of the first tag that opens with `start` (a tag name, or a tag and its first attributes). */
const attribute = (html: string, start: string, name: string) =>
  new RegExp(`<${start}[ >][^>]*?\\b${name}="([^"]*)"`).exec(html)?.[1];

describe('renderPalette()', () => {
  test('closed', () => {
    assert({
      given: 'a closed palette',
      should: 'draw nothing',
      actual: markup({ open: false }),
      expected: '',
    });
  });

  test('a modal combobox over a listbox', () => {
    const html = markup();
    assert({
      given: 'two results with the second highlighted',
      should: 'be a modal dialog whose field controls the results and points at the highlighted one',
      actual: {
        dialog: [attribute(html, 'div role="dialog"', 'aria-modal'), attribute(html, 'div role="dialog"', 'aria-label')],
        field: [
          attribute(html, 'input', 'role'),
          attribute(html, 'input', 'aria-controls'),
          attribute(html, 'input', 'aria-activedescendant'),
          attribute(html, 'input', 'aria-expanded'),
          attribute(html, 'input', 'placeholder'),
        ],
        list: attribute(html, 'ul', 'id'),
        options: [...html.matchAll(/<li id="([^"]+)" role="option" aria-selected="(true|false)"/g)].map(([, id, selected]) => [id, selected]),
      },
      expected: {
        dialog: ['true', 'Search'],
        field: ['combobox', 'pal-results', 'pal-result-1', 'true', 'Search Alpha…'],
        list: 'pal-results',
        options: [
          ['pal-result-0', 'false'],
          ['pal-result-1', 'true'],
        ],
      },
    });
  });

  test('the scope toggle', () => {
    assert({
      given: 'the palette on the open drive, then on every drive',
      should: 'offer "Include all workspaces" as a checkbox, ticked only for every drive',
      actual: [false, true].map((allDrives) => {
        const html = markup({ allDrives });
        return [attribute(html, 'button', 'aria-label'), attribute(html, 'button', 'aria-checked')];
      }),
      expected: [
        ['Include all workspaces', 'false'],
        ['Include all workspaces', 'true'],
      ],
    });
  });

  test('every drive', () => {
    const html = markup({
      allDrives: true,
      rows: [
        { id: 'p-1', title: 'Roadmap', icon: 'page', driveName: 'Alpha' },
        { id: 'a-1', title: 'Planner', icon: 'bot', driveName: null },
      ],
    });
    assert({
      given: 'results from every drive, one in a drive the viewer’s list does not name',
      should: 'show the drive beside each result that has one',
      actual: [...html.matchAll(/role="option"[^>]*>(.*?)<\/li>/g)].map(([, inner]) => (inner ?? '').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')),
      expected: ['|Roadmap|Alpha|', '|Planner|'],
    });
  });

  test('what the note says', () => {
    const note = (overrides: Partial<PaletteRenderProps>) => /<p role="status"[^>]*>([^<]*)<\/p>/.exec(markup(overrides))?.[1];
    assert({
      given: 'an empty field, a search in flight, a failure, no matches, and one match',
      should: 'prompt, say it is searching, say it failed, say nothing matched, and count for screen readers',
      actual: [
        note({ status: 'idle', rows: [] }),
        note({ status: 'loading', rows: [] }),
        note({ status: 'error', rows: [] }),
        note({ status: 'done', rows: [] }),
        note({ rows: [{ id: 'p-1', title: 'Roadmap', icon: 'page', driveName: null }], active: 0 }),
      ],
      expected: ['Type to search Alpha', 'Searching…', 'Search failed. Try again.', 'No matches', '1 result'],
    });
  });

  test('a highlight past a shorter list', () => {
    const html = markup({ rows: [{ id: 'p-1', title: 'Roadmap', icon: 'page', driveName: null }], active: 4 });
    assert({
      given: 'the highlight past the end of a one-result list',
      should: 'highlight its top instead, and with no results point at nothing',
      actual: [attribute(html, 'input', 'aria-activedescendant'), attribute(markup({ rows: [] }), 'input', 'aria-activedescendant')],
      expected: ['pal-result-0', undefined],
    });
  });
});
