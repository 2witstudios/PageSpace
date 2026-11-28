'use client';

import { createContext, useContext } from 'react';

/**
 * Whether the chat around a component is Imago's own. Imago's thread shows its orb where any
 * other agent's shows a spinner, so the retained chat parts ask this rather than taking a prop
 * through every layer between the chat host and them.
 */
const ImagoThreadContext = createContext(false);

export const ImagoThread = ImagoThreadContext.Provider;

export const useInImagoThread = (): boolean => useContext(ImagoThreadContext);
