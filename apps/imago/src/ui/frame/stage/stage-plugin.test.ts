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

  test('hide then show the chat history', () => {
    const stage = stageFor('/drive-1');
    dispatch(transactions.collapseSection, 'chat');
    const hidden = paneLayout(stage, getUiState().resources);
    const files = paneLayout(stageFor('/drive-1/files/page-1'), getUiState().resources);
    dispatch(transactions.expandSection, 'chat');
    const shown = paneLayout(stage, getUiState().resources);

    assert({
      given: 'the chat history hidden and then shown again through the store',
      should: 'close the chat’s list and reopen it, never touching the files tree',
      actual: [hidden, files.list, shown],
      expected: [
        { list: 'closed', listHidden: true, object: false },
        'tree',
        { list: 'list', listHidden: false, object: false },
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
  test('every section, including settings and account (SPEC v3.2)', () => {
    const state = createInitialState();
    assert({
      given: 'settings and account collapsed',
      should: 'record both: every left pane closes with Close sidebar',
      actual: collapseSection(collapseSection(state, 'settings'), 'account').resources.collapsedSections,
      expected: ['settings', 'account'],
    });
  });
});

describe('stagePlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the stage slice',
      should: 'start with no pane hidden and Imago open, and own the pane and Imago transactions',
      actual: [stagePlugin.resources(), Object.keys(stagePlugin.transactions).sort()],
      expected: [
        { collapsedSections: [], imagoCollapsed: false, imagoClosed: false },
        ['closeImago', 'collapseImago', 'collapseSection', 'expandImago', 'expandSection', 'openImago'],
      ],
    });
  });
});

describe('Imago column transactions (IMC-1.3)', () => {
  const { collapseImago, expandImago, closeImago, openImago } = stagePlugin.transactions;
  const start = createInitialState();

  test('collapse and expand the docked column', () => {
    assert({
      given: 'Imago docked, collapsed, then expanded',
      should: 'record collapsed and then clear it',
      actual: [
        collapseImago(start).resources.imagoCollapsed,
        expandImago(collapseImago(start)).resources.imagoCollapsed,
      ],
      expected: [true, false],
    });
  });

  test('close Imago on the ground', () => {
    assert({
      given: 'Imago closed on the ground',
      should: 'record it closed',
      actual: closeImago(start).resources.imagoClosed,
      expected: true,
    });
  });

  test('Ask Imago reopens it', () => {
    const reopened = openImago(collapseImago(closeImago(start)));
    assert({
      given: 'Imago closed and collapsed, then Ask Imago',
      should: 'open it and undo the collapse',
      actual: [reopened.resources.imagoClosed, reopened.resources.imagoCollapsed],
      expected: [false, false],
    });
  });

  test('no change, same snapshot', () => {
    assert({
      given: 'expandImago on an expanded column',
      should: 'return the same state',
      actual: expandImago(start) === start,
      expected: true,
    });
  });

  test('every section can hide its pane', () => {
    assert({
      given: 'the settings section collapsed',
      should: 'record it like any list section',
      actual: collapseSection(start, 'settings').resources.collapsedSections,
      expected: ['settings'],
    });
  });
});
