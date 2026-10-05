// What the settings objects know of a drive, its members and the viewer's
// Imago access, read from apps/web's own answers. The server decides every
// action; the actions shown here are only the ones it would not refuse.

import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import type { DriveKind } from '../../frame/drives/drives';

const drivePath = (driveId: string): string => `/api/drives/${encodeURIComponent(driveId)}`;

/** apps/web's drive route (GET details, PATCH settings). */
export const driveEndpoint = drivePath;

/** apps/web's drive members route (GET, read-only here). */
export const membersEndpoint = (driveId: string): string => `${drivePath(driveId)}/members`;

/** apps/web's Imago access route (IMG-4.6): GET the state, PUT `{ enabled }`. */
export const imagoAccessEndpoint = (driveId: string): string => `${drivePath(driveId)}/imago-access`;

export type DriveRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type DriveSettings = {
  readonly id: string;
  readonly name: string;
  readonly kind: DriveKind;
  /** The viewer's role in the drive. */
  readonly role: DriveRole;
};

export type Member = {
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: DriveRole;
  /** The custom role's name, when the member holds one. */
  readonly customRole: string | null;
};

export type ImagoAccess = { readonly enabled: boolean };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// Anything the settings do not know (a guest, a missing role) earns no more than MEMBER.
const roleOf = (value: unknown): DriveRole => (value === 'OWNER' || value === 'ADMIN' ? value : 'MEMBER');

/** A drive from GET /api/drives/[driveId]; null for an error body or nothing. */
export const driveOf = (body: unknown): DriveSettings | null => {
  if (!isRecord(body)) return null;
  const id = text(body.id);
  if (id === null || typeof body.name !== 'string') return null;
  return {
    id,
    name: body.name,
    // A missing kind is STANDARD: only kind === 'HOME' is ever protected.
    kind: body.kind === 'HOME' ? 'HOME' : 'STANDARD',
    role: body.isOwned === true ? 'OWNER' : roleOf(body.role),
  };
};

export type DriveActions = {
  readonly rename: boolean;
  readonly imagoAccess: boolean;
};

/**
 * What the viewer may do here: the drive routes allow owners and admins
 * only, and the Home drive guards refuse rename and the Imago toggle
 * whoever asks. The server still has the last word on each request.
 */
export const driveActions = (drive: DriveSettings): DriveActions => {
  const admin = drive.role === 'OWNER' || drive.role === 'ADMIN';
  return {
    rename: admin && homeDriveActionError(drive, 'rename') === null,
    imagoAccess: admin && homeDriveActionError(drive, 'imago-access') === null,
  };
};

const memberOf = (row: unknown): Member | null => {
  if (!isRecord(row)) return null;
  const userId = text(row.userId);
  if (userId === null) return null;
  const user = isRecord(row.user) ? row.user : {};
  const profile = isRecord(row.profile) ? row.profile : {};
  const email = text(user.email);
  return {
    userId,
    name: text(profile.displayName) ?? text(user.name) ?? email ?? 'Unknown member',
    email,
    role: roleOf(row.role),
    customRole: isRecord(row.customRole) ? text(row.customRole.name) : null,
  };
};

/** The members from GET /api/drives/[driveId]/members, owner first as the API lists them. */
export const membersFrom = (body: unknown): readonly Member[] | null => {
  if (!isRecord(body) || !Array.isArray(body.members)) return null;
  return body.members.map(memberOf).filter((member): member is Member => member !== null);
};

/** The viewer's Imago access from the imago-access route; null for an error body. */
export const imagoAccessOf = (body: unknown): ImagoAccess | null =>
  isRecord(body) && typeof body.enabled === 'boolean' ? { enabled: body.enabled } : null;

export type AccountLink = {
  readonly id: 'account' | 'billing' | 'connections';
  readonly label: string;
  readonly detail: string;
  /** Classic's settings page: root-relative, outside imago's basePath. */
  readonly href: string;
};

/**
 * The account object's ways into classic settings. Billing shows only
 * where classic shows it (isBillingEnabled: cloud).
 */
export const accountLinks = ({ billing }: { readonly billing: boolean }): readonly AccountLink[] => [
  { id: 'account', label: 'Account', detail: 'Your profile, email and sign-in', href: '/settings/account' },
  ...(billing
    ? [
        {
          id: 'billing',
          label: 'Billing',
          detail: 'Subscription, payment methods and invoices',
          href: '/settings/billing',
        } as const,
      ]
    : []),
  {
    id: 'connections',
    label: 'Connections',
    detail: 'External services your agents can use',
    href: '/settings/integrations',
  },
];
