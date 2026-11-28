/**
 * Builds the global console's sidebar groups — pure and side-effect free.
 *
 * Roster-first: the honest model of the dashboard sidebar is "for each place
 * I can work (Assistant + each of my drives), show my sessions there." Groups
 * are the UNION of the roster (every drive the user can work in, whether or
 * not it has a live session) and any drive a returned session names but the
 * roster omits (an orphan — surfaced rather than dropped, so a session never
 * vanishes because of a roster gap; its name falls back to its id at the
 * render layer since the roster is the only source of drive names here).
 *
 * Ordering is the one branching decision that belongs here, not inline in the
 * component: Assistant first (when requested, or when an assistant session
 * exists even if not requested — a session already in hand is never dropped),
 * then roster drives name-ascending (ties broken on driveId), then orphan
 * drives last, same tiebreak.
 */

export const ASSISTANT_GROUP_KEY = 'global';

export interface DriveGroup<T> {
  driveId: string;
  driveName: string | null;
  sessions: T[];
}

export interface RosterDrive {
  driveId: string;
  driveName: string;
}

function byDisplayName<T>(a: DriveGroup<T>, b: DriveGroup<T>): number {
  const nameA = a.driveName ?? a.driveId;
  const nameB = b.driveName ?? b.driveId;
  return nameA.localeCompare(nameB) || a.driveId.localeCompare(b.driveId);
}

export function buildSessionGroups<T extends { driveId: string | null }>(
  sessions: T[],
  { assistant, drives }: { assistant: boolean; drives: readonly RosterDrive[] },
): DriveGroup<T>[] {
  const sessionsByDrive = new Map<string, T[]>();
  for (const session of sessions) {
    const key = session.driveId ?? ASSISTANT_GROUP_KEY;
    sessionsByDrive.set(key, [...(sessionsByDrive.get(key) ?? []), session]);
  }

  const rosterIds = new Set(drives.map((drive) => drive.driveId));

  const rosterGroups = drives
    .map((drive) => ({
      driveId: drive.driveId,
      driveName: drive.driveName,
      sessions: sessionsByDrive.get(drive.driveId) ?? [],
    }))
    .sort(byDisplayName);

  const orphanGroups = [...sessionsByDrive.keys()]
    .filter((key) => key !== ASSISTANT_GROUP_KEY && !rosterIds.has(key))
    .map((driveId) => ({ driveId, driveName: null, sessions: sessionsByDrive.get(driveId) ?? [] }))
    .sort(byDisplayName);

  const hasAssistantSessions = (sessionsByDrive.get(ASSISTANT_GROUP_KEY)?.length ?? 0) > 0;
  const assistantGroup: DriveGroup<T>[] =
    assistant || hasAssistantSessions
      ? [
          {
            driveId: ASSISTANT_GROUP_KEY,
            driveName: 'Global Assistant',
            sessions: sessionsByDrive.get(ASSISTANT_GROUP_KEY) ?? [],
          },
        ]
      : [];

  return [...assistantGroup, ...rosterGroups, ...orphanGroups];
}
