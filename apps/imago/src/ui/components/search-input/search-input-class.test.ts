import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { searchFieldClass, searchInputClass } from './search-input-class';

describe('search input classes', () => {
  test('field', () => {
    assert({
      given: 'the field around the search input',
      should: 'be a glass, hairline-bordered control capped at the search width',
      actual: searchFieldClass,
      expected:
        'flex max-w-search flex-1 items-center gap-2 rounded-md border border-hairline surface-glass-raised px-3 py-2 text-ink-muted transition-colors duration-120 ease-standard focus-within:border-border-strong hover:border-border-strong',
    });
  });

  test('input', () => {
    assert({
      given: 'the search input inside the field',
      should: 'be borderless and transparent with faint placeholder ink',
      actual: searchInputClass,
      expected:
        'flex-1 border-none bg-transparent px-search-x py-search-y text-xs text-ink outline-none placeholder:text-ink-faint',
    });
  });
});
