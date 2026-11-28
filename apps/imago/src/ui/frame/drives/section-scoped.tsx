'use client';

import type { ReactNode } from 'react';
import type { ScopedSection } from './section-scope';
import { useAllDrives } from './use-section-scope';

/**
 * A drive tool's middle across every drive or in the URL's drive: the route renders both and this
 * picks by the section's scope, which the pane's head switches.
 */
export function SectionScoped({ section, driveId, all, drive }: {
  readonly section: ScopedSection;
  readonly driveId: string;
  readonly all: ReactNode;
  readonly drive: ReactNode;
}): ReactNode {
  return useAllDrives(section, driveId) ? all : drive;
}
