/**
 * The org UI's client for /api/orgs/**: one place for each path, its response type and its SWR key,
 * so a realtime event refetches exactly the projections a page reads. Shapes follow the routes on
 * pu/org-wallets (PR #2763 M3 and the route files); refusals surface as ApiRequestError and are
 * turned into copy by org-error-copy.ts.
 */
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import { fetchJSON, post, patch, put, del } from '@/lib/auth/auth-fetch';

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  role: OrgRole;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  ownerId: string;
  createdAt: string;
}

export interface OrgDetail {
  organization: Organization;
  viewer: { userId: string; role: OrgRole };
  billingNotice?: OrgBillingNotice;
}

export interface OrgSubscriptionSummary {
  status: string;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  extraSeatQuantity: number;
}

export type OrgPaymentStep = { kind: 'none' } | { kind: 'confirm_payment'; clientSecret: string };

export type OrgBillingStart =
  | { state: 'not_billed' }
  | { state: 'payment_required'; subscription: OrgSubscriptionSummary; payment: { kind: 'confirm_payment'; clientSecret: string } }
  | { state: 'subscribed'; subscription: OrgSubscriptionSummary }
  | { state: 'pending' };

export interface CreateOrgResponse {
  organization: Organization;
  billing: OrgBillingStart;
}

export interface OrgSeats {
  members: number;
  pendingInvites: number;
  held: number;
  included: number;
  purchasedExtra: number;
  purchased: number;
  autoAdd: boolean;
  hasSubscription: boolean;
  currentPeriodEnd: string | null;
}

export interface OrgMember {
  userId: string;
  role: OrgRole;
  joinedAt: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface OrgInvitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface GuestApproval {
  holdId: string;
  driveId: string;
  userId: string | null;
  email: string | null;
  origin: 'invite' | 'drive_link' | 'page_link' | 'page_invite' | 'page_grant';
  createdAt: string;
  driveName: string;
  requesterName: string | null;
  request: {
    role: string | null;
    customRoleId: string | null;
    pageGrants: number;
    tokenScopes: number;
    earliestExpiry: string | null;
    viaLink: boolean;
  };
}

// ---------------------------------------------------------------------------
// Paths (also the SWR keys)
// ---------------------------------------------------------------------------

export const orgKeys = {
  mine: () => '/api/orgs',
  detail: (orgId: string) => `/api/orgs/${orgId}`,
  members: (orgId: string) => `/api/orgs/${orgId}/members`,
  invitations: (orgId: string) => `/api/orgs/${orgId}/invitations`,
  seats: (orgId: string) => `/api/orgs/${orgId}/billing/seats`,
  guestApprovals: (orgId: string) => `/api/orgs/${orgId}/guest-approvals`,
  automations: (orgId: string) => `/api/orgs/${orgId}/automations`,
  guests: (orgId: string) => `/api/orgs/${orgId}/guests`,
  drives: (orgId: string) => `/api/orgs/${orgId}/drives`,
} as const;

/** Every key that belongs to one org, so an org:changed event can refetch them all. */
export const isOrgKey = (orgId: string, key: unknown): boolean =>
  typeof key === 'string' && (key === orgKeys.detail(orgId) || key.startsWith(`${orgKeys.detail(orgId)}/`) || key.startsWith(`${orgKeys.detail(orgId)}?`));

export const orgFetcher = <T>(url: string): Promise<T> => fetchJSON<T>(url);

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const createOrganization = (body: { name: string; slug: string }) =>
  post<CreateOrgResponse>('/api/orgs', body);

export const startOrgSubscription = (orgId: string) =>
  post<{ subscription: OrgSubscriptionSummary; payment: OrgPaymentStep }>(`/api/orgs/${orgId}/billing/subscription`);

export const openOrgBillingPortal = (orgId: string) => post<{ url: string }>(`/api/orgs/${orgId}/billing/portal`);

export const moveDriveIntoOrg = (driveId: string, orgId: string) => put<{ drive: { id: string } }>(`/api/drives/${driveId}/org`, { orgId });

export const inviteToOrg = (orgId: string, body: { email: string; role?: 'ADMIN' | 'MEMBER' }) =>
  post<{ invitation: OrgInvitation }>(orgKeys.invitations(orgId), body);

export const leaveOrganization = (orgId: string) => post<{ left: true }>(`/api/orgs/${orgId}/leave`);

export const updateOrganization = (orgId: string, body: { name?: string; slug?: string }) =>
  patch<{ organization: Organization }>(orgKeys.detail(orgId), body);

export const revokeOrgInvitation = (orgId: string, invitationId: string) =>
  del<{ revoked: true }>(`${orgKeys.invitations(orgId)}/${invitationId}`);

export const setOrgSeatAutoAdd = (orgId: string, autoAdd: boolean) => patch<{ autoAdd: boolean }>(orgKeys.seats(orgId), { autoAdd });

interface DriveMembersResponse {
  members: { userId: string; user: { email: string } }[];
}

/** The people in a drive the creator is moving in, so they can be invited to a seat. */
export async function fetchDriveMemberEmails(driveId: string): Promise<string[]> {
  const res = await fetchJSON<DriveMembersResponse>(`/api/drives/${driveId}/members`);
  return res.members.map((m) => m.user.email).filter((e): e is string => typeof e === 'string' && e.length > 0);
}
