'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { DRIVES, drivesFrom } from './drives';

/**
 * Drive names by id from the shell's drive list, for naming each row's drive in an
 * all-drives view on Home; undefined when not enabled, so a single drive names none. It reads
 * the list the shell already holds under DRIVES rather than the retained drive store, which
 * loads only when a retained screen asks it to.
 */
export const useDriveNames = (enabled: boolean): ReadonlyMap<string, string> | undefined => {
  const { data } = useSWR<unknown>(enabled ? DRIVES : null);
  return useMemo(
    () => (enabled ? new Map((drivesFrom(data, null) ?? []).map((drive) => [drive.id, drive.name])) : undefined),
    [enabled, data],
  );
};
