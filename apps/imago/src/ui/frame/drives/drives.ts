import type { Stage } from '../stage/stage';

/** apps/web's drive list (apps/web/src/app/api/drives/route.ts): the drives the viewer can reach. */
export const DRIVES = '/api/drives';

export type DriveKind = 'HOME' | 'STANDARD';

/** What the shell needs of a drive. Names are only ever the API's own. */
export type DriveSummary = {
  readonly id: string;
  readonly name: string;
  readonly kind: DriveKind;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const summaryOf = (entry: unknown): DriveSummary | null => {
  if (!isRecord(entry) || entry.isTrashed === true) return null;
  const { id, name, kind } = entry;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null;
  if (kind !== 'HOME' && kind !== 'STANDARD') return null;
  return { id, name, kind };
};

const byName = (a: DriveSummary, b: DriveSummary): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

/**
 * The viewer's drives from a /api/drives body: the viewer's Home drive first,
 * then the rest by name as classic's picker lists them. Anything malformed or
 * trashed is dropped rather than shown with a made-up name; a body that is not
 * a list (nothing loaded yet, an error body) is no list at all.
 */
export const drivesFrom = (body: unknown, homeDriveId: string | null): readonly DriveSummary[] | null => {
  if (!Array.isArray(body)) return null;
  const drives = body.map(summaryOf).filter((drive): drive is DriveSummary => drive !== null);
  const home = drives.filter((drive) => drive.id === homeDriveId);
  const rest = drives.filter((drive) => drive.id !== homeDriveId).sort(byName);
  return [...home, ...rest];
};

/**
 * Where picking another drive goes: the same section in that drive. An open
 * object (a page, a channel, a DM) belongs to the drive it was opened in, so
 * the switch lands on the section's list; DMs belong to Messages, and the
 * account to no section, so it opens the drive's chat.
 */
export const switchDriveHref = (stage: Stage, driveId: string): string => {
  const drive = `/${encodeURIComponent(driveId)}`;
  switch (stage.section) {
    case 'files':
    case 'messages':
    case 'tasks':
    case 'settings':
      return `${drive}/${stage.section}`;
    case 'chat':
    case 'account':
      return drive;
  }
};

/**
 * Whether the URL's drive is one the API listed. `missing` is the API's own
 * answer (it lists every drive the viewer can reach), never a guess made
 * before the list arrives.
 */
export type DriveStatus = 'none' | 'unknown' | 'listed' | 'missing';

export const driveStatus = (drives: readonly DriveSummary[] | null, driveId: string | null): DriveStatus => {
  if (driveId === null) return 'none';
  if (drives === null) return 'unknown';
  return drives.some((drive) => drive.id === driveId) ? 'listed' : 'missing';
};
