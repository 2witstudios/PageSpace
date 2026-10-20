'use client';

import type { ReactNode } from 'react';
import { useHomeDriveId } from './home-drive-context';

/**
 * A drive tool's middle on Home, the dashboard, or on any other drive: the route renders both and
 * this picks by whether the URL's drive is the viewer's Home, which the shell already knows.
 */
export function HomeScoped({ driveId, home, drive }: {
  readonly driveId: string;
  readonly home: ReactNode;
  readonly drive: ReactNode;
}): ReactNode {
  return driveId === useHomeDriveId() ? home : drive;
}
