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
  /** Chat is where Imago lives: its tile is Imago's orb rather than a line icon. */
  readonly imago?: boolean;
};

/** A drive tool, on the spine or behind More. */
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
  // The drive's front page is Imago's chat, so the spine marks it as home.
  { id: 'chat', icon: 'home', label: 'Home', href: driveHref(driveId, '') },
  { id: 'files', icon: 'files', label: 'Pages', href: driveHref(driveId, 'files') },
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
 * Under the divider: Calendar and Console (the drive's agents and their sessions), the tools that carry their own notifications or are
 * used as destinations in their own right, each a route of the current drive.
 * Calendar opens its screen beside the sidebar by default; its bare route still closes the screen.
 */
export const secondaryItems = (driveId: string | null): readonly SecondaryItem[] => [
  { id: 'calendar', icon: 'calendar', label: 'Calendar', href: driveHref(driveId, 'calendar/view') },
  { id: 'agents', icon: 'console', label: 'Console', href: driveHref(driveId, 'agents') },
];

/**
 * Behind the More entry at the foot: the housekeeping tools, which carry no notifications and
 * are visited rarely. Each is a route of the current drive.
 */
export const moreItems = (driveId: string | null): readonly SecondaryItem[] => [
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

/** The drive's front page (the spine's Home), where a New tab opens; null with no drive. */
export const driveHomeHref = (driveId: string | null): string | null => driveHref(driveId, '');

/** The URL alone picks the active item; the account belongs to the avatar. */
export const activeRailItem = (stage: Stage): RailItemId | null => {
  if (stage.section === 'account' || stage.section === 'notifications') return null;
  return stage.section;
};

/**
 * Where the viewer is relative to the active item: on the URL it links to
 * (`page`), or somewhere inside its section (`section`), such as a page in
 * Files or a DM, whose Messages link points at a drive.
 */
export type RailPlace = 'page' | 'section';

export const activeRailPlace = (stage: Stage): RailPlace => {
  if (stage.driveId === null) return 'section';
  if (stage.section === 'calendar') return stage.object?.kind === 'tool' ? 'page' : 'section';
  return stage.object === null ? 'page' : 'section';
};

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

/** One named count from a /api/sidebar/badges body; nothing loaded or a non-count shows none. */
const badgeCount = (badges: unknown, key: 'files' | 'tasks' | 'calendar'): number =>
  typeof badges !== 'object' || badges === null ? 0 : count((badges as Readonly<Record<string, unknown>>)[key]);

/** Files counts the file mentions waiting for the viewer. */
export const filesUnread = (badges: unknown): number => badgeCount(badges, 'files');

/** Tasks counts the tasks assigned to the viewer. */
export const tasksUnread = (badges: unknown): number => badgeCount(badges, 'tasks');

/** Calendar counts the pending invites to upcoming events the viewer has not answered. */
export const calendarUnread = (badges: unknown): number => badgeCount(badges, 'calendar');
