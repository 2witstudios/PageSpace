'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Whether React has hydrated this tree: false in the server render and the
 * hydrating pass that must match it, true from the render after. Until then
 * the markup is inert, so the shell says so on its frame for anything that
 * must wait to act on it (the e2e specs).
 */
export const useHydrated = (): boolean => useSyncExternalStore(subscribe, onClient, onServer);
