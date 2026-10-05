import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { filesPlugin } from './files-plugin';

const { toggleFileFolder } = filesPlugin.transactions;

const withExpanded = (expandedFileIds: readonly string[]): UiState => {
  const state = createInitialState();
  return { ...state, resources: { ...state.resources, expandedFileIds } };
};

beforeEach(() => {
  setUiState(createInitialState());
});

describe('toggleFileFolder()', () => {
  test('the empty shell', () => {
    assert({
      given: 'a new shell',
      should: 'have no folder expanded',
      actual: createInitialState().resources.expandedFileIds,
      expected: [],
    });
  });

  test('expanding', () => {
    assert({
      given: 'f1 expanded and f2 toggled',
      should: 'expand f2 too',
      actual: toggleFileFolder(withExpanded(['f1']), 'f2').resources.expandedFileIds,
      expected: ['f1', 'f2'],
    });
  });

  test('collapsing', () => {
    assert({
      given: 'f1 and f2 expanded and f1 toggled',
      should: 'keep only f2 expanded',
      actual: toggleFileFolder(withExpanded(['f1', 'f2']), 'f1').resources.expandedFileIds,
      expected: ['f2'],
    });
  });

  test('pure', () => {
    const state = withExpanded(['f1']);
    toggleFileFolder(state, 'f2');

    assert({
      given: 'a snapshot toggled into a new one',
      should: 'leave the old snapshot untouched',
      actual: state.resources.expandedFileIds,
      expected: ['f1'],
    });
  });

  test('through the shell', () => {
    dispatch(transactions.toggleFileFolder, 'f1');

    assert({
      given: 'the transaction dispatched through the shell store',
      should: 'record the expansion in the store',
      actual: getUiState().resources.expandedFileIds,
      expected: ['f1'],
    });
  });
});

describe('filesPlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the files slice',
      should: 'start with no folder expanded and own the folder toggle',
      actual: [filesPlugin.resources(), Object.keys(filesPlugin.transactions)],
      expected: [{ expandedFileIds: [] }, ['toggleFileFolder']],
    });
  });
});
