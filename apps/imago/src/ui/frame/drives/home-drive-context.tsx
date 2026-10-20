'use client';

import { createContext, useContext } from 'react';

/** The viewer's Home drive, as the shell's layout read it; null before it exists. */
const HomeDriveContext = createContext<string | null>(null);

export const HomeDriveProvider = HomeDriveContext.Provider;

/** The viewer's Home drive id, for code below the shell that cannot take it as a prop. */
export const useHomeDriveId = (): string | null => useContext(HomeDriveContext);
