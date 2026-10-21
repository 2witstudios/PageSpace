// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderPalette, type PaletteRenderProps } from './palette.render';

const props = (overrides: Partial<PaletteRenderProps> = {}): PaletteRenderProps => ({
  open: true,
  query: 'road',
  allDrives: false,
  driveName: 'Alpha',
  status: 'done',
  rows: [
    { id: 'p-1', title: 'Roadmap', icon: 'page', driveName: null },
    { id: 'p-2', title: 'road-crew', icon: 'hash', driveName: null },
  ],
  people: [],
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
/** Each result's text, its text runs joined with |, read through the DOM. */
const optionTexts = (html: string) =>
  [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[role="option"]')].map((option) => {
    const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT);
    const runs: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) runs.push(node.textContent ?? '');
    return runs.join('|');
  });

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
        list: /<div id="([^"]+)" role="listbox"/.exec(html)?.[1],
        options: [...html.matchAll(/<div id="([^"]+)" role="option" aria-selected="(true|false)"/g)].map(([, id, selected]) => [id, selected]),
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

  test('the scope switch', () => {
    assert({
      given: 'the palette on the open drive, then on every drive',
      should: 'offer the drive and every drive as two radios out of the tab order, the scope checked, and search it',
      actual: [false, true].map((allDrives) => {
        const html = markup({ allDrives });
        const radios = [...html.matchAll(/<button type="button" role="radio" aria-checked="(true|false)" tabindex="-1"[^>]*>([^<]*)<\/button>/g)];
        return [radios.map(([, checked, label]) => [label, checked]), attribute(html, 'input', 'placeholder')];
      }),
      expected: [
        [
          [
            ['Alpha', 'true'],
            ['All workspaces', 'false'],
          ],
          'Search Alpha…',
        ],
        [
          [
            ['Alpha', 'false'],
            ['All workspaces', 'true'],
          ],
          'Search all workspaces…',
        ],
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
      should: 'tint what matched, show the drive under each result that has one, and the Enter hint on the highlighted one',
      actual: [optionTexts(html), [...html.matchAll(/<span class="text-accent-strong">([^<]*)<\/span>/g)].map(([, text]) => text)],
      expected: [['Road|map|Alpha', 'Planner|↵'], ['Road']],
    });
  });

  test('the Pages and People groups, and the keyboard hints', () => {
    const html = markup({ people: [{ id: 'u-1', name: 'Priya Raman' }], active: 2 });
    const groups = [...html.matchAll(/role="group" aria-label="([^"]+)"/g)].map(([, label]) => label);

    assert({
      given: 'two pages and one person, with the person highlighted',
      should: 'group the pages, then the people, put the Enter hint on the person, and close with a kbd footer',
      actual: [groups, optionTexts(html).at(-1), html.includes('Tab</kbd>Switch scope') && html.includes('esc</kbd>Close')],
      expected: [['Pages', 'People'], 'Priya Raman|↵', true],
    });
  });

  test('an empty field', () => {
    const html = markup({ query: '', active: 0 });
    assert({
      given: 'nothing typed and the recent pages listed',
      should: 'list them under "Recently updated" with nothing tinted',
      actual: [/role="group" aria-label="([^"]+)"/.exec(html)?.[1], html.includes('class="text-accent-strong"'), optionTexts(html)],
      expected: ['Recently updated', false, ['Roadmap|↵', 'road-crew']],
    });
  });

  test('what the note says', () => {
    const note = (overrides: Partial<PaletteRenderProps>) => /<p role="status"[^>]*>([^<]*)<\/p>/.exec(markup(overrides))?.[1];
    assert({
      given: 'nowhere to search, recents loading, no recents, a search in flight, a failure, no matches, and one match',
      should: 'prompt, say it is loading, say there is nothing yet, say it is searching, say it failed, say nothing matched, and count for screen readers',
      actual: [
        note({ status: 'idle', rows: [] }),
        note({ query: '', status: 'loading', rows: [] }),
        note({ query: '', status: 'done', rows: [] }),
        note({ status: 'loading', rows: [] }),
        note({ status: 'error', rows: [] }),
        note({ status: 'done', rows: [] }),
        note({ rows: [{ id: 'p-1', title: 'Roadmap', icon: 'page', driveName: null }], active: 0 }),
      ],
      expected: ['Type to search', 'Loading…', 'Nothing here yet', 'Searching…', 'Search failed. Try again.', 'No matches', '1 result'],
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
