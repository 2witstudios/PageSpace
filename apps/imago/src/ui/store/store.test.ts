import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from './state';
import * as store from './store';

const { getUiState, setUiState, subscribeUiState, useUiState } = store;

beforeEach(() => {
  setUiState(createInitialState());
});

describe('store module surface', () => {
  test('one mutation path', () => {
    assert({
      given: 'the store module',
      should: 'export setUiState as its only writer beside readers and the hook',
      actual: Object.keys(store).sort(),
      expected: ['getUiState', 'setUiState', 'subscribeUiState', 'useUiState'],
    });
  });
});

describe('setUiState()', () => {
  test('swaps the snapshot', () => {
    const next = createInitialState();
    setUiState(next);

    assert({
      given: 'a new snapshot',
      should: 'make it the current state',
      actual: getUiState() === next,
      expected: true,
    });
  });

  test('notifies only on a changed snapshot', () => {
    const state = getUiState();
    let notifications = 0;
    const unsubscribe = subscribeUiState(() => {
      notifications += 1;
    });

    setUiState(state);
    setUiState({ ...state, resources: { ...state.resources } });
    unsubscribe();
    setUiState(createInitialState());

    assert({
      given: 'an identical swap, a changed swap and a swap after unsubscribing',
      should: 'notify once, for the changed snapshot',
      actual: notifications,
      expected: 1,
    });
  });

  test('notifies every subscriber', () => {
    const calls: string[] = [];
    const unsubscribeA = subscribeUiState(() => calls.push('a'));
    const unsubscribeB = subscribeUiState(() => calls.push('b'));

    setUiState(createInitialState());
    unsubscribeA();
    unsubscribeB();

    assert({
      given: 'two subscribers and one changed snapshot',
      should: 'notify each of them',
      actual: calls,
      expected: ['a', 'b'],
    });
  });
});

function Probe() {
  const collapsed = useUiState((state) => state.resources.collapsedSections);
  return h('p', null, `collapsed:${collapsed.join(',')}`);
}

describe('useUiState() on the server', () => {
  test('server snapshot', () => {
    const initial = createInitialState();
    setUiState({ ...initial, resources: { collapsedSections: ['files'] } });

    assert({
      given: 'a component reading the store rendered to string',
      should: 'render the current snapshot through getServerSnapshot',
      actual: renderToString(h(Probe)),
      expected: '<p>collapsed:files</p>',
    });
  });
});
