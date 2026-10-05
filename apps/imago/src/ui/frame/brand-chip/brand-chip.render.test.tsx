import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { DriveSummary } from '../drives/drives';
import { renderBrandChip, type BrandChipRenderProps } from './brand-chip.render';

const drives: DriveSummary[] = [
  { id: 'home-1', name: 'Home', kind: 'HOME' },
  { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' },
];

const props = (overrides: Partial<BrandChipRenderProps> = {}): BrandChipRenderProps => ({
  currentId: 'd-alpha',
  drives,
  failed: false,
  hrefFor: (id) => `/${id}/files`,
  open: true,
  onToggle: () => {},
  onPick: () => {},
  ...overrides,
});

const markup = (overrides: Partial<BrandChipRenderProps> = {}) => renderToStaticMarkup(renderBrandChip(props(overrides)));

const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(([, href, inner]) => [
    href,
    (inner ?? '').replace(/<[^>]+>/g, ''),
  ]);

describe('renderBrandChip()', () => {
  test('the drive list', () => {
    const html = markup();

    assert({
      given: 'Home and Alpha, with Alpha open',
      should: 'list each drive by its initial and name, linking into the same section, in the order given',
      actual: links(html),
      expected: [
        ['/home-1/files', 'HHome'],
        ['/d-alpha/files', 'AAlpha'],
      ],
    });

    assert({
      given: 'Alpha open',
      should: 'name the chip after Alpha and mark only Alpha as the current drive',
      actual: [
        /<summary[^>]*aria-label="Switch drive, Alpha"/.test(html),
        html.match(/aria-current="[^"]+"/g),
        /aria-current="page"[^>]*href="\/d-alpha\/files"|href="\/d-alpha\/files"[^>]*aria-current="page"/.test(html),
      ],
      expected: [true, ['aria-current="page"'], true],
    });
  });

  test('a drive the API did not list', () => {
    const html = markup({ currentId: 'd-secret' });

    assert({
      given: 'a URL naming a drive missing from the list',
      should: 'show no drive name on the chip and mark no drive current',
      actual: [/aria-label="Switch drive"/.test(html), html.includes('aria-current'), html.includes('d-secret')],
      expected: [true, false, false],
    });
  });

  test('before the list arrives, and when it fails', () => {
    assert({
      given: 'no list yet, then a failed request',
      should: 'say so in the menu, with no drive names',
      actual: [markup({ drives: null }).includes('Loading drives…'), markup({ drives: null, failed: true }).includes('Couldn’t load drives'), links(markup({ drives: null }))],
      expected: [true, true, []],
    });
  });

  test('closed', () => {
    assert({
      given: 'the menu closed',
      should: 'render the disclosure closed',
      actual: [/<details[^>]*open=""/.test(markup({ open: false })), /<details[^>]*open=""/.test(markup())],
      expected: [false, true],
    });
  });
});
