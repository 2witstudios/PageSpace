import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from './state';
import { getUiState, setUiState, subscribeUiState } from './store';
import { dispatch, mergePlugins, transactions, type UiPlugin } from './transactions';

const collectionsPlugin = {
  transactions: {
    replaceCollections: (state: UiState, collections: UiState['collections']): UiState => ({
      ...state,
      collections,
    }),
  },
} satisfies UiPlugin;

const resourcesPlugin = {
  transactions: {
    keep: (state: UiState, _arg: void): UiState => state,
  },
} satisfies UiPlugin;

beforeEach(() => {
  setUiState(createInitialState());
});

describe('mergePlugins()', () => {
  test('one namespace', () => {
    const merged = mergePlugins(collectionsPlugin, resourcesPlugin);

    assert({
      given: 'two plugins',
      should: 'merge their transactions into one namespace',
      actual: [
        merged.replaceCollections === collectionsPlugin.transactions.replaceCollections,
        merged.keep === resourcesPlugin.transactions.keep,
      ],
      expected: [true, true],
    });
  });

  test('name collision', () => {
    let error: unknown;
    try {
      mergePlugins(resourcesPlugin, resourcesPlugin);
    } catch (caught) {
      error = caught;
    }

    assert({
      given: 'two plugins defining the same transaction name',
      should: 'refuse to merge rather than silently overwrite',
      actual: error instanceof Error ? error.message : error,
      expected: 'Duplicate UI transaction: keep',
    });
  });

  test('the shell’s plugins', () => {
    assert({
      given: 'the shell with the stage, tasks, files and chat plugins registered',
      should: 'expose exactly their transactions',
      actual: Object.keys(transactions).sort(),
      expected: [
        'collapseSection',
        'endStreaming',
        'expandSection',
        'setTaskView',
        'startStreaming',
        'toggleFileFolder',
        'toggleTaskExpanded',
      ],
    });
  });
});

describe('dispatch()', () => {
  test('pure transaction through the store', () => {
    const before = getUiState();
    const beforeCollections = before.collections;
    const collections = {};

    dispatch(collectionsPlugin.transactions.replaceCollections, collections);

    assert({
      given: 'a plugin transaction dispatched with its argument',
      should: 'swap in the returned snapshot and leave the previous one untouched',
      actual: [
        getUiState().collections === collections,
        getUiState() === before,
        before.collections === beforeCollections,
        getUiState().resources === before.resources,
      ],
      expected: [true, false, true, true],
    });
  });

  test('no-op transaction', () => {
    let notifications = 0;
    const unsubscribe = subscribeUiState(() => {
      notifications += 1;
    });

    dispatch(resourcesPlugin.transactions.keep, undefined);
    unsubscribe();

    assert({
      given: 'a transaction that returns the same snapshot',
      should: 'notify no subscriber',
      actual: notifications,
      expected: 0,
    });
  });
});
