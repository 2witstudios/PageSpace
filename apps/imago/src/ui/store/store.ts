'use client';

import { useRef, useSyncExternalStore } from 'react';
import { createInitialState, type UiState } from './state';

/**
 * Eval-free UI shell store (myimago ADR 0024; a client ECS needs eval, which
 * the nonce CSP forbids): immutable snapshots, pure transactions, and the
 * platform external-store contract. SSR renders the snapshot through
 * getServerSnapshot.
 */
let state: UiState = createInitialState();

const listeners = new Set<() => void>();

export const getUiState = (): UiState => state;

export const subscribeUiState = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The only mutation path: swap in the next immutable snapshot. */
export const setUiState = (next: UiState): void => {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
};

type Selection<T> = {
  readonly snapshot: UiState;
  readonly selector: (state: UiState) => T;
  readonly selected: T;
};

/**
 * Reads a slice of the store. A component re-renders only when its selected
 * value changes by reference, and one snapshot always yields one reference,
 * so a selector that derives a fresh object stays stable until the store
 * changes.
 */
export const useUiState = <T>(selector: (state: UiState) => T): T => {
  const last = useRef<Selection<T> | null>(null);
  const select = (): T => {
    const cached = last.current;
    if (cached !== null && cached.snapshot === state && cached.selector === selector) {
      return cached.selected;
    }
    const selected = selector(state);
    last.current = { snapshot: state, selector, selected };
    return selected;
  };
  return useSyncExternalStore(subscribeUiState, select, select);
};
