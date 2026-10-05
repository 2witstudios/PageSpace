import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { composeResources, createInitialState, type UiSlice } from './state';
import { transactions } from './transactions';
import { uiSlices } from './slices';

const noTransactions = {};

const draftsSlice = {
  resources: () => ({ draft: '' }),
  transactions: noTransactions,
} satisfies UiSlice;

const filtersSlice = {
  resources: () => ({ filter: 'all' }),
  transactions: noTransactions,
} satisfies UiSlice;

const loadError = (load: () => unknown): unknown => {
  try {
    load();
  } catch (caught) {
    return caught instanceof Error ? caught.message : caught;
  }
  return undefined;
};

describe('composeResources()', () => {
  test('one resource record', () => {
    const initialResources = composeResources(draftsSlice, filtersSlice);

    assert({
      given: 'two slices with distinct resource keys',
      should: 'build one record holding every slice’s initial resources',
      actual: initialResources(),
      expected: { draft: '', filter: 'all' },
    });
  });

  test('fresh record per call', () => {
    const initialResources = composeResources(draftsSlice);

    assert({
      given: 'the composed factory called twice',
      should: 'return a new record each time',
      actual: initialResources() === initialResources(),
      expected: false,
    });
  });

  test('resource key collision', () => {
    const shadowSlice = {
      resources: () => ({ filter: 'none' }),
      transactions: noTransactions,
    } satisfies UiSlice;

    assert({
      given: 'two slices declaring the same resource key',
      should: 'refuse to compose rather than let one slice overwrite the other',
      actual: loadError(() => composeResources(filtersSlice, shadowSlice)),
      expected: 'Duplicate UI resource: filter',
    });
  });
});

describe('uiSlices', () => {
  test('the registry is the shell’s resources', () => {
    assert({
      given: 'the slices listed in the registry',
      should: 'make up exactly the shell’s initial resources',
      actual: Object.keys(createInitialState().resources).sort(),
      expected: uiSlices.flatMap((slice) => Object.keys(slice.resources())).sort(),
    });
  });

  test('the registry is the shell’s transactions', () => {
    assert({
      given: 'the slices listed in the registry',
      should: 'make up exactly the shell’s transactions',
      actual: Object.keys(transactions).sort(),
      expected: uiSlices.flatMap((slice) => Object.keys(slice.transactions)).sort(),
    });
  });
});
