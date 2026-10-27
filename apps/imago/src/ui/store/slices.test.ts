import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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

const uiRoot = join(__dirname, '..');

/** Section slice modules under ui/: `<section>-plugin.ts` or `store-slice.ts`. */
const sliceModules = (): readonly string[] =>
  readdirSync(uiRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => /(^|\/)([\w-]+-plugin|store-slice)\.ts$/.test(file));

const isSlice = (value: unknown): value is UiSlice =>
  typeof value === 'object' &&
  value !== null &&
  'resources' in value &&
  typeof value.resources === 'function' &&
  'transactions' in value;

describe('uiSlices', () => {
  test('every slice module is registered', async () => {
    const registered = new Set<unknown>(uiSlices);
    const found = new Set<unknown>();
    const unregistered: string[] = [];
    for (const file of sliceModules()) {
      const exports: Record<string, unknown> = await import(/* @vite-ignore */ join(uiRoot, file));
      for (const [name, value] of Object.entries(exports)) {
        if (!isSlice(value)) continue;
        found.add(value);
        if (!registered.has(value)) unregistered.push(`${file}: ${name}`);
      }
    }

    assert({
      given: 'every section slice module under ui/',
      should: 'find each exported slice in the registry, and each registered slice in a slice module',
      actual: { unregistered, outsideSliceModules: uiSlices.filter((slice) => !found.has(slice)).length },
      expected: { unregistered: [], outsideSliceModules: 0 },
    });
  });

  test('the registry has no duplicate slice', () => {
    assert({
      given: 'the registry',
      should: 'list each slice once',
      actual: new Set(uiSlices).size,
      expected: uiSlices.length,
    });
  });

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
