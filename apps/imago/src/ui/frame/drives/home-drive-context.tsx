'use client';

import { createContext, useContext } from 'react';

/** The viewer's Home drive, as the shell's layout read it; null before it exists. */
const HomeDriveContext = createContext<string | null>(null);

export const HomeDriveProvider = HomeDriveContext.Provider;

/** The viewer's Home drive id, for code below the shell that cannot take it as a prop. */
export const useHomeDriveId = (): string | null => useContext(HomeDriveContext);

/** Whether a drive is the viewer's Home, the dashboard (ADR 0007 D4, amended); false before Home exists. */
export const useIsHome = (driveId: string | null | undefined): boolean => {
  const homeDriveId = useHomeDriveId();
  return homeDriveId !== null && driveId === homeDriveId;
};
