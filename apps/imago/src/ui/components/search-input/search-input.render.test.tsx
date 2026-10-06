import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { searchFieldClass, searchInputClass } from './search-input-class';
import { renderSearchInput, type SearchInputRenderProps } from './search-input.render';

type InputProps = {
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onKeyDown?: (event: { readonly key: string; readonly preventDefault: () => void }) => void;
};

const props = (overrides: Partial<SearchInputRenderProps> = {}): SearchInputRenderProps => ({
  value: 'launch',
  placeholder: 'Filter files',
  label: 'Filter files',
  typeSearchQuery: () => undefined,
  ...overrides,
});

const inputOf = (rendered: SearchInputRenderProps) =>
  findElement<InputProps>(renderSearchInput(rendered), (element) => element.type === 'input');

/** Presses `key` on the input; returns the queries it committed and whether it prevented default. */
const pressKey = (value: string, key: string) => {
  const typed: string[] = [];
  let prevented = false;
  inputOf(props({ value, typeSearchQuery: (query) => typed.push(query) }))?.props.onKeyDown?.({
    key,
    preventDefault: () => {
      prevented = true;
    },
  });
  return { typed, prevented };
};

describe('renderSearchInput', () => {
  test('a labelled search field', () => {
    const html = renderToString(renderSearchInput(props()));
    assert({
      given: 'a value, a placeholder and a label',
      should: 'render a controlled, named searchbox inside the styled field',
      actual: [
        html.startsWith(`<label class="${searchFieldClass}">`),
        html.includes('type="search"'),
        html.includes('value="launch"'),
        html.includes('placeholder="Filter files"'),
        html.includes('aria-label="Filter files"'),
        html.includes(`class="${searchInputClass}"`),
        html.includes('aria-hidden="true"'),
      ],
      expected: [true, true, true, true, true, true, true],
    });
  });

  test('typing', () => {
    const typed: string[] = [];
    inputOf(props({ value: '', typeSearchQuery: (query) => typed.push(query) }))?.props.onChange?.({
      currentTarget: { value: 'elo' },
    });
    assert({
      given: 'a change event on the input',
      should: 'commit the typed text',
      actual: typed,
      expected: ['elo'],
    });
  });

  test('Escape with a query', () => {
    assert({
      given: 'Escape while the field holds a query',
      should: 'clear the query and keep the key from closing anything else',
      actual: pressKey('launch', 'Escape'),
      expected: { typed: [''], prevented: true },
    });
  });

  test('Escape on an empty field', () => {
    assert({
      given: 'Escape while the field is empty',
      should: 'leave the key to the surrounding pane',
      actual: pressKey('', 'Escape'),
      expected: { typed: [], prevented: false },
    });
  });

  test('other keys', () => {
    assert({
      given: 'a key other than Escape',
      should: 'do nothing beyond typing',
      actual: pressKey('launch', 'Enter'),
      expected: { typed: [], prevented: false },
    });
  });
});
