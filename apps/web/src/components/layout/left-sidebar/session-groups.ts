/**
 * Groups the global console's sessions by drive, for the sidebar's tree.
 * Pure and side-effect free — the one branching decision (where the Assistant
 * group sorts) belongs here, not inline in the component render.
 *
 * The Assistant group (the user's own, driveId `null`) is always FIRST,
 * regardless of where its sessions land in the fetch response — sorted
 * explicitly rather than relying on Map insertion order, which only put it
 * first when `showEmptyAssistantGroup` happened to seed the Map before any
 * drive session was iterated.
 */

export const ASSISTANT_GROUP_KEY = 'global';

export interface DriveGroup<T> {
  driveId: string;
  sessions: T[];
}

export function groupSessionsByDrive<T extends { driveId: string | null }>(
  sessions: T[],
  { seedEmptyAssistantGroup }: { seedEmptyAssistantGroup: boolean },
): DriveGroup<T>[] {
  const byDrive = new Map<string, T[]>(seedEmptyAssistantGroup ? [[ASSISTANT_GROUP_KEY, []]] : []);
  for (const session of sessions) {
    const key = session.driveId ?? ASSISTANT_GROUP_KEY;
    byDrive.set(key, [...(byDrive.get(key) ?? []), session]);
  }

  // A stable sort: the Assistant group moves to the front, and every other
  // group keeps the server's original ordering relative to the others.
  const entries = [...byDrive.entries()];
  entries.sort(([a], [b]) => {
    if (a === ASSISTANT_GROUP_KEY) return -1;
    if (b === ASSISTANT_GROUP_KEY) return 1;
    return 0;
  });

  return entries.map(([driveId, list]) => ({ driveId, sessions: list }));
}
