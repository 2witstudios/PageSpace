'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useIsHome } from './home-drive-context';
import {
  NO_SCOPES,
  SECTION_SCOPES_KEY,
  parseScopes,
  resolveScope,
  serializeScopes,
  type ScopedSection,
  type SectionScope,
  type SectionScopes,
} from './section-scope';

/**
 * localStorage, which can throw (private windows, blocked site data): choices then live for the
 * session. A read that throws is undefined, unlike null for nothing stored; a write says whether
 * it held.
 */
const storage = {
  read: (): string | null | undefined => {
    try {
      return window.localStorage.getItem(SECTION_SCOPES_KEY);
    } catch {
      return undefined;
    }
  },
  write: (value: string): boolean => {
    try {
      window.localStorage.setItem(SECTION_SCOPES_KEY, value);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * One snapshot for the window, so a pane's head and the middle it scopes move together. It is
 * kept in step with other tabs through the storage event while anything listens, and read from
 * storage again when something starts listening, since events in between were missed. Once a
 * write has failed, memory alone holds the choice and storage is not read over it.
 */
let current: SectionScopes | null = null;
let memoryOnly = false;
const listeners = new Set<() => void>();

const fromStorage = (): SectionScopes | null => {
  if (memoryOnly) return null;
  const raw = storage.read();
  return raw === undefined ? null : parseScopes(raw);
};

const snapshot = (): SectionScopes => {
  current ??= fromStorage() ?? NO_SCOPES;
  return current;
};

const publish = (next: SectionScopes): void => {
  current = next;
  listeners.forEach((listener) => listener());
};

const onStorage = (event: StorageEvent): void => {
  if (event.key === SECTION_SCOPES_KEY && !memoryOnly) publish(parseScopes(event.newValue));
};

const subscribe = (listener: () => void): (() => void) => {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage);
    const stored = fromStorage();
    // Same choices keep the same snapshot, so nothing re-renders for a read that changed nothing.
    if (stored !== null && serializeScopes(stored) !== serializeScopes(current ?? NO_SCOPES)) current = stored;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
};

/** The server draws no choice: the first client render agrees with it, then the stored choice applies. */
const serverSnapshot = (): SectionScopes => NO_SCOPES;

/** Void action: keep a section at a scope on every drive. */
export const setSectionScope = (section: ScopedSection, scope: SectionScope): void => {
  const scopes = snapshot();
  if (scopes[section] === scope) return;
  const next = { ...scopes, [section]: scope };
  if (!storage.write(serializeScopes(next))) memoryOnly = true;
  publish(next);
};

/** Every section's stored choice, for code that resolves several sections at once. */
export const useSectionScopes = (): SectionScopes => useSyncExternalStore(subscribe, snapshot, serverSnapshot);

/** A section's scope in a drive, and the action that changes it. */
export const useSectionScope = (
  section: ScopedSection,
  driveId: string | null,
): readonly [SectionScope, (scope: SectionScope) => void] => {
  const scopes = useSectionScopes();
  const isHome = useIsHome(driveId);
  const set = useCallback((scope: SectionScope) => setSectionScope(section, scope), [section]);
  return [resolveScope(scopes, section, isHome), set];
};

/** Whether a section reads every drive in this drive. */
export const useAllDrives = (section: ScopedSection, driveId: string | null): boolean =>
  useSectionScope(section, driveId)[0] === 'all';
