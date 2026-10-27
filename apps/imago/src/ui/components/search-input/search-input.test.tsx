// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { SearchInput } from './search-input';

afterEach(unmountAll);

function Harness() {
  const [query, setQuery] = useState('');
  return (
    <SearchInput value={query} placeholder="Filter files" label="Filter files" typeSearchQuery={setQuery} />
  );
}

describe('SearchInput', () => {
  test('keyboard typing and clearing', () => {
    const container = mount(<Harness />);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    input?.focus();
    const focused = document.activeElement === input;
    if (input) typeInto(input, 'launch');
    const typed = input?.value;
    const prevented = input ? press(input, 'Escape') : false;
    assert({
      given: 'a focused search field, typed into, then Escape',
      should: 'show the query and then clear it',
      actual: { focused, typed, prevented, cleared: input?.value },
      expected: { focused: true, typed: 'launch', prevented: true, cleared: '' },
    });
  });
});
