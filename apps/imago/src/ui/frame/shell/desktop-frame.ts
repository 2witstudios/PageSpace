'use client';

import { useEffect, useState } from 'react';

/** The bridge the desktop shell exposes on window (see retained/types/electron.d.ts). */
type DesktopWindow = { readonly electron?: { readonly isDesktop?: boolean } };

/** Whether the page runs inside the Electron desktop app. */
export const isDesktopWindow = (win: DesktopWindow | undefined): boolean => win?.electron?.isDesktop === true;

/**
 * Whether the shell runs in the desktop app. False on the server and in the hydrating pass,
 * then the real answer: the desktop CSS keys its macOS traffic-light inset off the marker.
 */
export function useDesktopFrame(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setDesktop(isDesktopWindow(window as DesktopWindow));
  }, []);
  return desktop;
}
