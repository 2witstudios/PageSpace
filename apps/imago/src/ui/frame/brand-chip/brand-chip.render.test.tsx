// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { DriveSummary } from '../drives/drives';
import { renderBrandChip, type BrandChipRenderProps } from './brand-chip.render';

const drives: DriveSummary[] = [
  { id: 'home-1', name: 'Home', kind: 'HOME', lastAccessedAt: null },
  { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD', lastAccessedAt: null },
];

const props = (overrides: Partial<BrandChipRenderProps> = {}): BrandChipRenderProps => ({
  currentId: 'd-alpha',
  drives,
  open: false,
  onToggle: () => {},
  ...overrides,
});

const markup = (overrides: Partial<BrandChipRenderProps> = {}) => {
  const parsed = document.createElement('template');
  parsed.innerHTML = renderToStaticMarkup(renderBrandChip(props(overrides)));
  return parsed.content;
};

describe('renderBrandChip()', () => {
  test('the tile for the open drive', () => {
    const tile = markup().querySelector('button');

    assert({
      given: 'Alpha open',
      should: 'name the tile for Alpha, show its initial and advertise the dialog it opens',
      actual: [tile?.getAttribute('aria-label'), tile?.textContent?.startsWith('A'), tile?.getAttribute('aria-haspopup'), tile?.getAttribute('aria-expanded')],
      expected: ['Switch drive: Alpha', true, 'dialog', 'false'],
    });
  });

  test('a drive the list does not hold, and a list not yet loaded', () => {
    assert({
      given: 'an unlisted current drive, then no list at all',
      should: 'never name a drive on the tile',
      actual: [
        markup({ currentId: 'secret' }).querySelector('button')?.getAttribute('aria-label'),
        markup({ drives: null }).querySelector('button')?.getAttribute('aria-label'),
      ],
      expected: ['Switch drive', 'Switch drive'],
    });
  });

  test('the switcher beside the tile', () => {
    const fragment = markup({ open: true, switcher: <div data-switcher="" /> });

    assert({
      given: 'the switcher open',
      should: 'mount the dialog beside the tile and mark the tile expanded',
      actual: [fragment.querySelector('[data-switcher]') !== null, fragment.querySelector('button')?.getAttribute('aria-expanded')],
      expected: [true, 'true'],
    });
  });
});

test('the organization surface uses the same single picker tile instead of a second breadcrumb level', () => {
  const fragment = markup({ organization: { name: 'Northwind Labs' } });
  expect(fragment.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(1);
  expect(fragment.querySelector('button')?.getAttribute('aria-label')).toBe('Switch workspace: Northwind Labs');
  expect(fragment.querySelector('button')?.textContent).not.toContain('Alpha');
});
