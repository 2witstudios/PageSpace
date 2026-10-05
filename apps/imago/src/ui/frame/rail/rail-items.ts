import type { IconName } from '../../components/icon/icon-names';
import type { Section, Stage } from '../stage/stage';

/** The rail's own destinations (DEC-6); the account is reached from the avatar. */
export type RailItemId = Exclude<Section, 'account'>;

export type RailItem = {
  readonly id: RailItemId;
  readonly icon: IconName;
  readonly label: string;
  /** The section in the current drive, basePath-relative; null with no drive. */
  readonly href: string | null;
};

export type OverflowItemId = 'calendar' | 'agents' | 'connections' | 'activity' | 'trash';

export type OverflowItem = {
  readonly id: OverflowItemId;
  readonly icon: IconName;
  readonly label: string;
  /** Classic's route for the drive: root-relative, outside imago's basePath. */
  readonly href: string;
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

/** Pinned to the foot of the rail: the drive's settings (IMG-10.1), not the account. */
export const settingsItem = (driveId: string | null): RailItem => ({
  id: 'settings',
  icon: 'settings',
  label: 'Settings',
  href: driveHref(driveId, 'settings'),
});

/**
 * A classic drive route. The id is escaped into one segment under
 * /dashboard/, so the result is always a same-origin path, whatever the id.
 */
export const classicHref = (driveId: string, path: string): string =>
  `/dashboard/${encodeURIComponent(driveId)}/${path}`;

/**
 * The ⋯ overflow (D5, DEC-6): surfaces imago does not build this epic, as
 * deep links into classic for the same drive.
 */
export const overflowItems = (driveId: string): readonly OverflowItem[] => [
  { id: 'calendar', icon: 'calendar', label: 'Calendar', href: classicHref(driveId, 'calendar') },
  { id: 'agents', icon: 'bot', label: 'Agents', href: classicHref(driveId, 'agents') },
  {
    id: 'connections',
    icon: 'connections',
    label: 'Connections',
    href: classicHref(driveId, 'settings/integrations'),
  },
  { id: 'activity', icon: 'activity', label: 'Activity', href: classicHref(driveId, 'activity') },
  { id: 'trash', icon: 'trash', label: 'Trash', href: classicHref(driveId, 'trash') },
];

/**
 * The drive the rail links into: the URL's, or on the user-level stages
 * (DMs, the account) the viewer's Home drive, or none before it exists.
 */
export const railDrive = (stage: Stage, homeDriveId: string | null): string | null =>
  stage.driveId ?? homeDriveId;

/** The URL alone picks the active item; the account belongs to the avatar. */
export const activeRailItem = (stage: Stage): RailItemId | null =>
  stage.section === 'account' ? null : stage.section;

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

/** apps/web's badge counts route (apps/web/src/app/api/sidebar/badges/route.ts). */
export const SIDEBAR_BADGES = '/api/sidebar/badges';
