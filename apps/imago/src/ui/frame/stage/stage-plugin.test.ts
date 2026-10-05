import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from '../../store/state';
import { getUiState, setUiState, subscribeUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { paneLayout, stageFor } from './stage';
import { stagePlugin } from './stage-plugin';

const { collapseSection, expandSection } = stagePlugin.transactions;

const withCollapsed = (collapsedSections: UiState['resources']['collapsedSections']): UiState => ({
  ...createInitialState(),
  resources: { ...createInitialState().resources, collapsedSections },
});

beforeEach(() => {
  setUiState(createInitialState());
});

describe('collapseSection()', () => {
  test('hides one section', () => {
    assert({
      given: 'no section collapsed and the files section collapsed',
      should: 'record files as collapsed',
      actual: collapseSection(createInitialState(), 'files').resources.collapsedSections,
      expected: ['files'],
    });
  });

  test('keeps the others', () => {
    assert({
      given: 'messages already collapsed and files collapsed next',
      should: 'record both',
      actual: collapseSection(withCollapsed(['messages']), 'files').resources.collapsedSections,
      expected: ['messages', 'files'],
    });
  });

  test('already collapsed', () => {
    const state = withCollapsed(['files']);

    assert({
      given: 'a section collapsed twice',
      should: 'return the same snapshot so nothing re-renders',
      actual: collapseSection(state, 'files') === state,
      expected: true,
    });
  });

  test('pure', () => {
    const state = createInitialState();
    const before = state.resources.collapsedSections;
    collapseSection(state, 'files');

    assert({
      given: 'a snapshot collapsed into a new one',
      should: 'leave the old snapshot untouched',
      actual: [state.resources.collapsedSections === before, before],
      expected: [true, []],
    });
  });
});

describe('expandSection()', () => {
  test('shows one section again', () => {
    assert({
      given: 'files and messages collapsed and files expanded',
      should: 'keep only messages collapsed',
      actual: expandSection(withCollapsed(['files', 'messages']), 'files').resources
        .collapsedSections,
      expected: ['messages'],
    });
  });

  test('not collapsed', () => {
    const state = withCollapsed(['messages']);

    assert({
      given: 'a section expanded that was never collapsed',
      should: 'return the same snapshot so nothing re-renders',
      actual: expandSection(state, 'files') === state,
      expected: true,
    });
  });
});

describe('stage transactions through the store', () => {
  test('registered with the shell', () => {
    assert({
      given: 'the shell’s transaction namespace',
      should: 'carry the stage plugin’s transactions',
      actual: [
        transactions.collapseSection === collapseSection,
        transactions.expandSection === expandSection,
      ],
      expected: [true, true],
    });
  });

  test('collapse then lay out', () => {
    const stage = stageFor('/drive-1/files/page-1');
    dispatch(transactions.collapseSection, 'files');
    const collapsed = paneLayout(stage, getUiState().resources);
    dispatch(transactions.expandSection, 'files');
    const expanded = paneLayout(stage, getUiState().resources);

    assert({
      given: 'the files tree collapsed and then expanded through the store',
      should: 'hide the tree, then show it again, keeping the object open',
      actual: [collapsed, expanded],
      expected: [
        { list: 'closed', listHidden: true, object: true },
        { list: 'tree', listHidden: false, object: true },
      ],
    });
  });

  test('repeat collapse notifies once', () => {
    let notifications = 0;
    const unsubscribe = subscribeUiState(() => {
      notifications += 1;
    });
    dispatch(transactions.collapseSection, 'files');
    dispatch(transactions.collapseSection, 'files');
    unsubscribe();

    assert({
      given: 'the same section collapsed twice through the store',
      should: 'notify subscribers once',
      actual: notifications,
      expected: 1,
    });
  });
});

describe('collapsible sections', () => {
  test('only a list section', () => {
    const state = createInitialState();
    // Type-level: settings has no list, so tsc rejects collapsing it
    // (bun run typecheck fails if the transaction's type widens again).
    // @ts-expect-error settings has no list to collapse
    const next = collapseSection(state, 'settings');
    // @ts-expect-error account has no list to expand
    expandSection(state, 'account');

    assert({
      given: 'collapsing a section that has no list',
      should: 'be a type error (the call above only runs to prove it compiles out)',
      actual: next === state,
      expected: false,
    });
  });
});

describe('stagePlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the stage slice',
      should: 'start with no section collapsed and own the collapse and expand transactions',
      actual: [stagePlugin.resources(), Object.keys(stagePlugin.transactions).sort()],
      expected: [{ collapsedSections: [] }, ['collapseSection', 'expandSection']],
    });
  });
});
