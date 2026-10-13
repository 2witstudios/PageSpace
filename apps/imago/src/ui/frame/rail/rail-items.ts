import type { IconName } from '../../components/icon/icon-names';
import type { DriveTool, Section, Stage } from '../stage/stage';

/** The spine's destinations; the account is reached from the avatar. */
export type RailItemId = Exclude<Section, 'account' | 'notifications'> | DriveTool;

export type RailItem = {
  readonly id: RailItemId;
  readonly icon: IconName;
  readonly label: string;
  /** The section in the current drive, basePath-relative; null with no drive. */
  readonly href: string | null;
};

/** The six drive tools under the divider; Members is one of them (SPEC v3). */
export type SecondaryItem = {
  readonly id: DriveTool;
  readonly icon: IconName;
  readonly label: string;
  /** The tool in the current drive, basePath-relative; null with no drive. */
  readonly href: string | null;
};

const driveHref = (driveId: string | null, section: string): string | null => {
  if (driveId === null) return null;
  const drive = `/${encodeURIComponent(driveId)}`;
  return section === '' ? drive : `${drive}/${section}`;
};

/**
 * The rail, written down once as data (myimago ADR 0029): Chat, Files,
 * Messages and Tasks, each in the current drive. DMs live under Messages.
 */
export const railItems = (driveId: string | null): readonly RailItem[] => [
  { id: 'chat', icon: 'chat', label: 'Chat', href: driveHref(driveId, '') },
  { id: 'files', icon: 'files', label: 'Files', href: driveHref(driveId, 'files') },
  { id: 'messages', icon: 'messages', label: 'Messages', href: driveHref(driveId, 'messages') },
  { id: 'tasks', icon: 'tasks', label: 'Tasks', href: driveHref(driveId, 'tasks') },
];

/** Pinned to the foot of the spine: the drive's settings (IMG-10.1), not the account. */
export const settingsItem = (driveId: string | null): RailItem => ({
  id: 'settings',
  icon: 'settings',
  label: 'Drive settings',
  href: driveHref(driveId, 'settings'),
});

/**
 * A classic drive route. The id is escaped into one segment under
 * /dashboard/, so the result is always a same-origin path, whatever the id.
 */
export const classicHref = (driveId: string, path: string): string =>
  `/dashboard/${encodeURIComponent(driveId)}/${path}`;

/**
 * Under the divider (SPEC v3 spine, C-Files-Doc): Calendar, Agents, Workflows, Activity,
 * Members and Trash, each a route of the current drive.
 */
export const secondaryItems = (driveId: string | null): readonly SecondaryItem[] => [
  { id: 'calendar', icon: 'calendar', label: 'Calendar', href: driveHref(driveId, 'calendar') },
  { id: 'agents', icon: 'agents', label: 'Agents', href: driveHref(driveId, 'agents') },
  { id: 'workflows', icon: 'workflows', label: 'Workflows', href: driveHref(driveId, 'workflows') },
  { id: 'activity', icon: 'activity', label: 'Activity', href: driveHref(driveId, 'activity') },
  { id: 'members', icon: 'members', label: 'Members', href: driveHref(driveId, 'members') },
  { id: 'trash', icon: 'trash', label: 'Trash', href: driveHref(driveId, 'trash') },
];

/**
 * The drive the rail links into: the URL's, or on the user-level stages
 * (DMs, the account) the viewer's Home drive, or none before it exists.
 */
export const railDrive = (stage: Stage, homeDriveId: string | null): string | null =>
  stage.driveId ?? homeDriveId;

/** The URL alone picks the active item; the account belongs to the avatar. */
export const activeRailItem = (stage: Stage): RailItemId | null => {
  if (stage.section === 'account' || stage.section === 'notifications') return null;
  if (stage.object?.kind === 'settings' && stage.object.tool !== undefined) return stage.object.tool;
  return stage.section;
};

/**
 * Where the viewer is relative to the active item: on the URL it links to
 * (`page`), or somewhere inside its section (`section`), such as a page in
 * Files or a DM, whose Messages link points at a drive.
 */
export type RailPlace = 'page' | 'section';

export const activeRailPlace = (stage: Stage): RailPlace =>
  stage.driveId !== null && (stage.object === null || stage.object.kind === 'settings')
    ? 'page'
    : 'section';

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

/**
 * Messages counts unread channel messages and DMs from apps/web's
 * /api/sidebar/badges. Anything that is not a count (nothing loaded yet, an
 * error body) shows no badge rather than a wrong number.
 */
export const messagesUnread = (badges: unknown): number => {
  if (typeof badges !== 'object' || badges === null) return 0;
  const { dms, channels } = badges as { readonly dms?: unknown; readonly channels?: unknown };
  return count(dms) + count(channels);
};
