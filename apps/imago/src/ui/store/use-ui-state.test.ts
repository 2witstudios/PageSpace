// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from './state';
import { getUiState, setUiState, useUiState } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { readonly root: Root; readonly renders: () => number; readonly seen: () => readonly unknown[] };

let mounted: Mounted[] = [];

/** Mounts a real client root that reads the store and counts its renders. */
const mount = <T>(selector: (state: UiState) => T): Mounted => {
  let renders = 0;
  const seen: unknown[] = [];
  function Reader() {
    const value = useUiState(selector);
    renders += 1;
    seen.push(value);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(h(Reader));
  });
  const entry = { root, renders: () => renders, seen: () => seen };
  mounted.push(entry);
  return entry;
};

const replaceCollections = (state: UiState): UiState => ({
  ...state,
  collections: { ...state.collections },
});

const replaceResources = (state: UiState): UiState => ({
  ...state,
  resources: { ...state.resources },
});

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  vi.restoreAllMocks();
});

describe('useUiState() stable references', () => {
  test('unrelated update', () => {
    const reader = mount((state) => state.resources);

    act(() => setUiState(replaceCollections(getUiState())));

    assert({
      given: 'a component selecting resources and an update to collections only',
      should: 'not re-render',
      actual: reader.renders(),
      expected: 1,
    });
  });

  test('related update (control)', () => {
    const reader = mount((state) => state.resources);
    const next = replaceResources(getUiState());

    act(() => setUiState(next));

    assert({
      given: 'a component selecting resources and an update to resources',
      should: 're-render once with the new reference',
      actual: [reader.renders(), reader.seen().at(-1) === next.resources],
      expected: [2, true],
    });
  });

  test('derived selector', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = mount((state) => [state.resources, state.collections]);
    const [first] = reader.seen();

    assert({
      given: 'a selector deriving a fresh array from one snapshot',
      should: 'render once, return one reference and raise no React warning',
      actual: [reader.renders(), reader.seen().every((value) => value === first), consoleError.mock.calls.length],
      expected: [1, true, 0],
    });
  });
});

describe('useUiState() selector identity', () => {
  test('a prop-dependent selector', () => {
    const seen: unknown[] = [];
    function Reader({ slice }: { readonly slice: 'resources' | 'collections' }) {
      const value = useUiState((state) => state[slice]);
      seen.push(value);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    mounted.push({ root, renders: () => seen.length, seen: () => seen });
    const snapshot = getUiState();

    act(() => root.render(h(Reader, { slice: 'resources' })));
    act(() => root.render(h(Reader, { slice: 'collections' })));

    assert({
      given: 'a selector that changes with a prop while the store stays on one snapshot',
      should: 'return the new selector’s slice, not the cached one',
      actual: [getUiState() === snapshot, seen.at(0) === snapshot.resources, seen.at(-1) === snapshot.collections],
      expected: [true, true, true],
    });
  });
});
