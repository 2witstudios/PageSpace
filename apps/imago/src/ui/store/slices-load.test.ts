import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { stagePlugin } from '../frame/stage/stage-plugin';

const loadError = async (load: () => Promise<unknown>): Promise<unknown> => {
  try {
    await load();
  } catch (caught) {
    return caught instanceof Error ? caught.message : caught;
  }
  return undefined;
};

afterEach(() => {
  vi.doUnmock('./slices');
  vi.resetModules();
});

describe('a registry with a duplicated slice', () => {
  test('state fails at module load', async () => {
    vi.resetModules();
    vi.doMock('./slices', () => ({ uiSlices: [stagePlugin, stagePlugin] }));

    assert({
      given: 'two registered slices owning the same resource key',
      should: 'make the state module fail to load with the duplicate key',
      actual: await loadError(() => import('./state')),
      expected: 'Duplicate UI resource: collapsedSections',
    });
  });

  test('transactions fail at module load', async () => {
    vi.resetModules();
    vi.doMock('./slices', () => ({ uiSlices: [stagePlugin, { resources: () => ({}), transactions: stagePlugin.transactions }] }));

    assert({
      given: 'two registered slices defining the same transaction name',
      should: 'make the transactions module fail to load with the duplicate name',
      actual: await loadError(() => import('./transactions')),
      expected: 'Duplicate UI transaction: collapseSection',
    });
  });
});
