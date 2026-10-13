/**
 * Organization operations (Spec X-1, ORG-5): every org read and write the web exposes to a
 * delegated key, as one operation each — and therefore one MCP tool each.
 *
 * Route-verified against the `apps/web/src/app/api/orgs/**` route files named on each
 * operation. Every one goes through the web's ONE org authorization function `requireOrgRole`
 * (ORG-5): a non-member gets 404, a role below the route's minimum 403. None re-implements it,
 * so the CLI and MCP get exactly the web's answer.
 *
 * What is deliberately NOT an operation (the server answers a key with a session-only refusal,
 * and an operation that can only ever be refused has no place on the registry or the MCP
 * surface — the wallets.ts reasoning):
 * - creating an org (POST /api/orgs): it is a card checkout;
 * - deleting an org (DELETE /api/orgs/:orgId): it ends the org's Stripe subscription;
 * - transferring ownership: it hands over the org's money authority ([D-OW-26]);
 * - seat caps (PUT/DELETE …/members/:userId/seat-cap): allocating the org pool ([D-OW-26]);
 * - the admin money views (GET …/seat-caps, GET …/pool): a key reads only the consumer
 *   projection of any wallet ([D-OW-26]);
 * - billing (…/billing/**): Stripe, session only.
 *
 * Key scope. Org data is ORG-WIDE, not drive-wide: a key scoped to specific drives is refused
 * (403 `token_scope_refused`) everywhere except the drive directory, which shows a scoped key
 * only the drives its scope already covers, so a key never widens its own reach through it.
 *
 * Sign-in policy (SEC-2/3, O-1). The org's `requireStrongSignIn` / `maximumSessionAgeMinutes`
 * apply to the key exactly as to a browser session: a key whose credential-bound sign-in
 * evidence does not satisfy them is refused (403 `org_strong_sign_in_required` /
 * `org_reauthentication_required`).
 *
 * Vocabulary is inlined (the published SDK never runtime- or type-imports `@pagespace/lib`);
 * `__tests__/organizations-drift-guard.test.ts` pins the copies to lib's canonical types.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** `OrgRole` (`packages/db/src/schema/organizations.ts`), as every org route answers it. */
const orgRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

/** `OrgDriveVisibility` (`packages/db/src/schema/core.ts`) — DRV-4. */
const orgDriveVisibilitySchema = z.enum(['OPEN', 'RESTRICTED', 'PRIVATE']);

/** `OrgSummaryForUser` + the route's `lapsed` flag (GET /api/orgs, ORG-2; [D-OW-33] shows read-only). */
const orgSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  avatarUrl: z.string().nullable(),
  role: orgRoleSchema,
  /** True while the org's subscription has lapsed: org surfaces are read-only (SEAT-9). */
  lapsed: z.boolean(),
});

/**
 * `OrgBillingNotice` (`packages/lib/src/organizations/status-core.ts`), left open on
 * purpose: the route computes it per role (plan detail for Owner/Admins only, SEAT-6)
 * and an additive new `kind` must not break an older SDK — the CLI renders `kind` as-is.
 */
const billingNoticeSchema = z.unknown().optional();

export const listMyOrganizations = defineOperation({
  name: 'organizations.list',
  method: 'GET',
  path: '/api/orgs',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ organizations: z.array(orgSummarySchema) }),
  requiredScope: 'account',
  description:
    'List the organizations you belong to, each with your role in it (OWNER, ADMIN or MEMBER) and whether it is currently lapsed (read-only). Requires a key with no drive restriction — a drive-scoped key is refused, since this lists organizations outside its scope. The organization\'s sign-in policy (requireStrongSignIn, maximumSessionAgeMinutes) applies to the key: 403 org_strong_sign_in_required or org_reauthentication_required when its sign-in does not satisfy it.',
});

export const getOrganization = defineOperation({
  name: 'organizations.get',
  method: 'GET',
  path: '/api/orgs/:orgId',
  inputSchema: z.strictObject({ orgId: z.string().min(1) }),
  outputSchema: z.object({
    organization: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      avatarUrl: z.string().nullable(),
      ownerId: z.string(),
      createdAt: z.string(),
    }),
    /** The CALLER'S accepted org role, so a client renders by role without a second call. */
    viewer: z.object({ userId: z.string(), role: orgRoleSchema }),
    /** The billing banner this caller qualifies for (reactivation or member read-only notice); absent when there is nothing to say. */
    billingNotice: billingNoticeSchema,
  }),
  requiredScope: 'account',
  description:
    "Read one organization you belong to: its identity and owner, your own role in it, and the billing notice your role qualifies for (plan detail is Owner/Admin only). Requires a key with no drive restriction — a drive-scoped key is refused. Not found for an org you are not a member of. The organization's sign-in policy (requireStrongSignIn, maximumSessionAgeMinutes) applies to the key: 403 org_strong_sign_in_required or org_reauthentication_required when its sign-in does not satisfy it.",
});

/** `OrgMemberDetail` (`packages/lib/src/organizations/repository.ts`), any member may read (ORG-2). */
export const listOrgMembers = defineOperation({
  name: 'organizations.listMembers',
  method: 'GET',
  path: '/api/orgs/:orgId/members',
  inputSchema: z.strictObject({ orgId: z.string().min(1) }),
  outputSchema: z.object({
    members: z.array(
      z.object({
        userId: z.string(),
        role: orgRoleSchema,
        /** ISO timestamp. */
        joinedAt: z.string(),
        name: z.string(),
        email: z.string(),
        image: z.string().nullable(),
      }),
    ),
  }),
  requiredScope: 'account',
  description:
    'List the members of an organization you belong to: each person, their org role, when they joined, and their name and email. Requires a key with no drive restriction — a drive-scoped key is refused, since a member roster is wider than any drive scope. The organization\'s sign-in policy (requireStrongSignIn, maximumSessionAgeMinutes) applies to the key: 403 org_strong_sign_in_required or org_reauthentication_required when its sign-in does not satisfy it.',
});

/** One line of the org Drives directory (DRV-6): `OrgDriveDirectoryEntry` as the route returns it. */
const directoryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  orgVisibility: orgDriveVisibilitySchema,
  /** Whether you already hold the drive (Open counts as yes). */
  joined: z.boolean(),
  /** `'pending'` while your join request is unanswered, else null. */
  joinRequest: z.literal('pending').nullable(),
  /** The directory may offer "Request to join". */
  canRequest: z.boolean(),
  lead: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }),
});

export const listOrgDriveDirectory = defineOperation({
  name: 'organizations.listDrives',
  method: 'GET',
  path: '/api/orgs/:orgId/drives',
  inputSchema: z.strictObject({ orgId: z.string().min(1) }),
  outputSchema: z.object({ drives: z.array(directoryEntrySchema) }),
  requiredScope: 'account',
  description:
    "List the organization's drive directory for you (any org member): every Open and Restricted drive with its visibility, whether you have joined it, your open join request, and its lead — the only place a Restricted drive is discovered before joining. Private drives appear only where you can already open them. A key scoped to specific drives sees only those drives here. The organization's sign-in policy (requireStrongSignIn, maximumSessionAgeMinutes) applies to the key: 403 org_strong_sign_in_required or org_reauthentication_required when its sign-in does not satisfy it.",
});

/**
 * `DelegatedOrgPolicies` (`packages/lib/src/organizations/policies-core.ts`): the org's policies, defaults
 * filled in (POL-1), as a key reads them — WITHOUT the money keys (`seatAllowanceCents`, `walletFallback`).
 * [D-OW-26] / D-OW-47: a key never sets money or a spend source and reads money only through the consumer
 * view, so those two are a signed-in session's alone and are absent here.
 */
const orgPoliciesSchema = z.object({
  requireStrongSignIn: z.boolean(),
  // Whole minutes from 15 to 43,200 (30 days), or null for none. The server reads a damaged stored value as its
  // strictest, 0 (no sign-in is fresh enough), so 0 is the one other value it can answer (policies-core SPECS).
  maximumSessionAgeMinutes: z.union([z.literal(0), z.number().int().min(15).max(43_200)]).nullable(),
  guests: z.enum(['off', 'approve', 'on']),
  publicShareLinks: z.boolean(),
  publishWeb: z.boolean(),
  customDomains: z.boolean(),
  whoCanInvite: z.enum(['admins', 'members']),
  whoCanCreateDrives: z.enum(['admins', 'members']),
  openDriveRoleFloor: z.enum(['view', 'edit']),
  modelAllowlist: z.array(z.string()).nullable(),
  providerAllowlist: z.array(z.string()).nullable(),
  agentsAutonomous: z.boolean(),
  crossDriveAgents: z.boolean(),
  cloudSandbox: z.boolean(),
  persistentEnvironments: z.boolean(),
  publishedApps: z.boolean(),
  integrationsAllowlist: z.array(z.string()).nullable(),
});

export const getOrgPolicies = defineOperation({
  name: 'organizations.getPolicies',
  method: 'GET',
  path: '/api/orgs/:orgId/policies',
  inputSchema: z.strictObject({ orgId: z.string().min(1) }),
  outputSchema: z.object({ policies: orgPoliciesSchema }),
  requiredScope: 'account',
  description:
    "Read an organization's policies with a default filled in for every key (guests, sharing, publishing, invites, drive creation, the Open-drive role floor, model/provider/integration allowlists, agent autonomy, sandbox and environments). The money policies (seat allowance, wallet fallback) are never shown to a key: they need a signed-in session. Owner and Admins only — a plain member is refused (403) and a non-member gets 404. Change them with organizations.updatePolicies. Requires a key with no drive restriction. The organization's sign-in policy (requireStrongSignIn, maximumSessionAgeMinutes) applies to the key: 403 org_strong_sign_in_required or org_reauthentication_required when its sign-in does not satisfy it.",
});

// ---------------------------------------------------------------------------
// Shared pieces of the org writes and admin reads
// ---------------------------------------------------------------------------

/**
 * The key rules every org operation below states in its description: an unscoped key, and the
 * org's sign-in policy applied to it. One string so an MCP agent reads the same rule everywhere.
 */
const KEY_RULES =
  "Requires a key with no drive restriction (a drive-scoped key is refused: 403 token_scope_refused). The organization's sign-in policy applies to the key: if it requires strong sign-in or a maximum session age that the key's sign-in does not satisfy, it is refused (403 org_strong_sign_in_required or org_reauthentication_required).";

/** The roles an invitation or a role change may grant: Owner moves only by a (session-only) transfer. */
const grantableRoleSchema = z.enum(['ADMIN', 'MEMBER']);

const orgIdInput = { orgId: z.string().min(1) };

/** `PublicOrgInvitation` (`packages/lib/src/organizations/invitations.ts`): the row without its token hash. */
const invitationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  invitedBy: z.string().nullable(),
  /** ISO timestamp. */
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  avatarUrl: z.string().nullable(),
  ownerId: z.string(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// The organization itself
// ---------------------------------------------------------------------------

/** PATCH /api/orgs/[orgId] — name and slug (ORG-1; the avatar is an uploaded image, set in the web app). */
export const updateOrganization = defineOperation({
  name: 'organizations.update',
  method: 'PATCH',
  path: '/api/orgs/:orgId',
  inputSchema: z
    .strictObject({
      ...orgIdInput,
      name: z.string().min(1).max(100).optional(),
      /** 1-48 lowercase letters, digits or inner hyphens; it becomes part of org URLs. */
      slug: z.string().min(1).max(48).optional(),
    })
    .refine((input) => input.name !== undefined || input.slug !== undefined, 'Nothing to update'),
  outputSchema: z.object({ organization: organizationSchema }),
  requiredScope: 'account',
  description: `Rename an organization, or change its URL slug (409 slug_taken when another org has it). The avatar is an image uploaded in the web app, not a URL. Owner and Admins only. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** `OrgMemberActivity` (`packages/lib/src/permissions/org-read-models.ts`, D-OW-38). */
export const listOrgMemberActivity = defineOperation({
  name: 'organizations.listMemberActivity',
  method: 'GET',
  path: '/api/orgs/:orgId/members/activity',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({
    activity: z.array(z.object({ userId: z.string(), driveCount: z.number(), lastActiveAt: z.string().nullable() })),
  }),
  requiredScope: 'account',
  description: `List each member's org drive count and most recent activity. Owner and Admins only. ${KEY_RULES}`,
});

export const changeOrgMemberRole = defineOperation({
  name: 'organizations.changeMemberRole',
  method: 'PATCH',
  path: '/api/orgs/:orgId/members/:userId',
  inputSchema: z.strictObject({ ...orgIdInput, userId: z.string().min(1), role: grantableRoleSchema }),
  outputSchema: z.object({ userId: z.string(), role: grantableRoleSchema }),
  requiredScope: 'account',
  description: `Make a member an Admin or a plain Member. Owner and Admins only; the Owner's own role changes only by an ownership transfer, which needs a signed-in session. While the org is lapsed only a demotion is allowed. ${KEY_RULES}`,
});

export const removeOrgMember = defineOperation({
  name: 'organizations.removeMember',
  method: 'DELETE',
  path: '/api/orgs/:orgId/members/:userId',
  inputSchema: z.strictObject({ ...orgIdInput, userId: z.string().min(1) }),
  outputSchema: z.object({ removed: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description: `Remove a member from the organization: they lose every org drive they reached through the org, and the drives they led go to a new lead. Owner and Admins only; the Owner cannot be removed, and you leave with organizations.leave. ${KEY_RULES}`,
});

export const leaveOrganization = defineOperation({
  name: 'organizations.leave',
  method: 'POST',
  path: '/api/orgs/:orgId/leave',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({ left: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description: `Leave an organization you belong to (any role but Owner: the Owner transfers ownership first, 409 owner_must_transfer). You lose the org drives you reached through the org. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Invitations (ORG-3)
// ---------------------------------------------------------------------------

export const listOrgInvitations = defineOperation({
  name: 'organizations.listInvitations',
  method: 'GET',
  path: '/api/orgs/:orgId/invitations',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({ invitations: z.array(invitationSchema) }),
  requiredScope: 'account',
  description: `List the organization's open (not yet accepted) invitations; each pending invite holds a seat. Owner and Admins only. ${KEY_RULES}`,
});

export const inviteToOrganization = defineOperation({
  name: 'organizations.invite',
  method: 'POST',
  path: '/api/orgs/:orgId/invitations',
  inputSchema: z.strictObject({
    ...orgIdInput,
    email: z.string().min(3).max(254),
    /** Defaults to MEMBER server-side; only an Owner or Admin may invite an ADMIN. */
    role: grantableRoleSchema.optional(),
  }),
  outputSchema: z.object({ invitation: invitationSchema }),
  requiredScope: 'account',
  description: `Invite someone to the organization by email (they get a link that expires). Who may invite follows the org's whoCanInvite policy; only an Owner or Admin may invite an Admin. Refused when every seat is taken (seats_full) or the org is lapsed. Re-inviting an expired address rotates its link. ${KEY_RULES}`,
});

export const resendOrgInvitation = defineOperation({
  name: 'organizations.resendInvitation',
  method: 'POST',
  path: '/api/orgs/:orgId/invitations/:invitationId/resend',
  inputSchema: z.strictObject({ ...orgIdInput, invitationId: z.string().min(1) }),
  outputSchema: z.object({ invitation: invitationSchema }),
  requiredScope: 'account',
  description: `Send an open invitation again with a new link (the old link stops working). Judged by the org's whoCanInvite policy on the role the invitation carries. ${KEY_RULES}`,
});

export const revokeOrgInvitation = defineOperation({
  name: 'organizations.revokeInvitation',
  method: 'DELETE',
  path: '/api/orgs/:orgId/invitations/:invitationId',
  inputSchema: z.strictObject({ ...orgIdInput, invitationId: z.string().min(1) }),
  outputSchema: z.object({ revoked: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description: `Revoke an open invitation: its link stops working and its seat is freed. Owner and Admins only. ${KEY_RULES}`,
});

export const acceptOrgInvitation = defineOperation({
  name: 'organizations.acceptInvitation',
  method: 'POST',
  path: '/api/orgs/invitations/accept',
  inputSchema: z.strictObject({ token: z.string().min(1).max(256) }),
  outputSchema: z.object({ orgId: z.string(), role: orgRoleSchema, joined: z.boolean() }),
  requiredScope: 'account',
  description:
    "Accept an organization invitation with the token from its email link. The invitation must have been sent to your account's email address (403 email_mismatch otherwise); expired or used links are refused. Requires a key with no drive restriction.",
});

// ---------------------------------------------------------------------------
// Policies (POL-1)
// ---------------------------------------------------------------------------

/**
 * A policy change: any subset of the non-money policy keys, validated server-side by lib's
 * `validateOrgPoliciesPatch` (unknown keys and invalid values are refused, nothing is partly
 * applied). `maximumSessionAgeMinutes` is 15–43200 minutes, or null for no maximum.
 */
const orgPoliciesPatchShape = {
  ...orgPoliciesSchema.partial().shape,
  maximumSessionAgeMinutes: z.number().int().min(15).max(43_200).nullable().optional(),
};

/** Every policy key a key's change may name — lib's `DelegatedOrgPolicies` keys, pinned by the drift guard. */
export const ORG_POLICY_KEYS = Object.keys(orgPoliciesSchema.shape) as ReadonlyArray<keyof typeof orgPoliciesSchema.shape>;

export const updateOrgPolicies = defineOperation({
  name: 'organizations.updatePolicies',
  method: 'PATCH',
  path: '/api/orgs/:orgId/policies',
  inputSchema: z
    .strictObject({ ...orgIdInput, ...orgPoliciesPatchShape })
    .refine((input) => Object.keys(input).some((key) => key !== 'orgId'), 'No policies to change'),
  outputSchema: z.object({
    policies: orgPoliciesSchema,
    /** The keys that actually changed. */
    changed: z.array(z.string()),
    /** What the change newly suspended / restored, counted by kind. */
    suspended: z.record(z.string(), z.number()),
    restored: z.record(z.string(), z.number()),
    /** What it forbids that is blocked where used rather than suspended, counted by kind. */
    blocked: z.record(z.string(), z.number()),
    auditRecorded: z.boolean(),
    publishedVisibility: z.object({ parked: z.number(), restored: z.number(), failed: z.number() }).optional(),
  }),
  requiredScope: 'account',
  description: `Change one or more organization policies, including the sign-in policy (requireStrongSignIn; maximumSessionAgeMinutes 15-43200, or null for none). Applies immediately; anything newly forbidden is suspended (never deleted) and counted in the answer. A lapsed org may only restrict. The money policies (seatAllowanceCents, walletFallback) cannot be changed with a key: the server refuses them (mcp_token_cannot_move_money / mcp_token_cannot_change_spend_source), so they are not inputs here. Owner and Admins only. ${KEY_RULES}`,
});

/** `SuspensionKind` (`packages/lib/src/organizations/policies-core.ts`). */
const suspensionKindSchema = z.enum(['publicShareLinks', 'publishedPages', 'customDomains', 'guests', 'integrations']);
/** `SuspendedResourceType` (`packages/lib/src/organizations/policy-suspension.ts`). */
const suspendedResourceTypeSchema = z.enum([
  'drive_share_link',
  'page_share_link',
  'published_page',
  'custom_domain',
  'integration_connection',
  'guest_hold',
]);

/** `NamedSuspendedListing` (`packages/lib/src/organizations/policy-suspension-names.ts`). */
const suspendedListingSchema = z.object({
  kind: suspensionKindSchema,
  resourceType: suspendedResourceTypeSchema,
  total: z.number(),
  items: z.array(
    z.object({
      kind: suspensionKindSchema,
      resourceType: suspendedResourceTypeSchema,
      id: z.string(),
      driveId: z.string(),
      userId: z.string().optional(),
      driveName: z.string().nullable(),
      userName: z.string().nullable(),
      label: z.string(),
    }),
  ),
});

export const listOrgPolicySuspensions = defineOperation({
  name: 'organizations.listSuspended',
  method: 'GET',
  path: '/api/orgs/:orgId/policies/suspended',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({ suspended: z.array(suspendedListingSchema) }),
  requiredScope: 'account',
  description: `List what the organization's policies are holding suspended (share links, published pages, custom domains, integration connections, guests), by name, never content. Owner and Admins only. ${KEY_RULES}`,
});

/** `SignInBlockedCounts` (`packages/lib/src/organizations/sign-in-blocked.ts`). */
export const previewOrgSignInPolicy = defineOperation({
  name: 'organizations.previewSignInPolicy',
  method: 'GET',
  path: '/api/orgs/:orgId/policies/sign-in-preview',
  inputSchema: z.strictObject({
    ...orgIdInput,
    requireStrongSignIn: z.boolean().optional(),
    /** Whole minutes, 15-43200; omitted for no maximum. */
    maximumSessionAgeMinutes: z.number().int().min(15).max(43200).optional(),
  }),
  outputSchema: z.object({ members: z.number(), credentials: z.number() }),
  requiredScope: 'account',
  description: `Before changing the sign-in policy: how many of the organization's members, and how many of their live credentials, a candidate policy (requireStrongSignIn; maximumSessionAgeMinutes 15-43200, omitted for none) would refuse right now. Counts only, no identities. Owner and Admins only. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Org drives: trash and usage (UI-7 read models)
// ---------------------------------------------------------------------------

export const listOrgTrashedDrives = defineOperation({
  name: 'organizations.listTrashedDrives',
  method: 'GET',
  path: '/api/orgs/:orgId/drives/trashed',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({
    drives: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        trashedAt: z.string().nullable(),
        lead: z.object({ id: z.string(), name: z.string().nullable() }),
      }),
    ),
  }),
  requiredScope: 'account',
  description: `List the organization's trashed drives, Private ones included. Owner and Admins only. ${KEY_RULES}`,
});

export const getOrgDriveUsage = defineOperation({
  name: 'organizations.getDriveUsage',
  method: 'GET',
  path: '/api/orgs/:orgId/drives/usage',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({
    usage: z.array(z.object({ driveId: z.string(), memberCount: z.number(), guestCount: z.number(), storageBytes: z.number() })),
  }),
  requiredScope: 'account',
  description: `People, guests and stored bytes per organization drive. Owner and Admins only. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Audit log (AUD-1, AUD-3)
// ---------------------------------------------------------------------------

/** `OrgAuditCategory` (`packages/lib/src/audit/org-audit-query-core.ts`). */
const orgAuditCategorySchema = z.enum([
  'membership',
  'seats',
  'invites',
  'policies',
  'domains',
  'visibility',
  'drive_moves',
  'private_drive_access',
  'wallets',
  'donations',
  'billing',
  'compute',
  'automations',
]);

const auditFilterShape = {
  ...orgIdInput,
  /** One event type of the org catalog (e.g. `org.member.removed`). */
  type: z.string().min(1).optional(),
  category: orgAuditCategorySchema.optional(),
  driveId: z.string().min(1).optional(),
  /** ISO times. */
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
};

/** `OrgAuditEntry` (`packages/lib/src/audit/org-audit-query-core.ts`). */
const auditEntrySchema = z.object({
  timestamp: z.string(),
  category: orgAuditCategorySchema,
  eventType: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  driveId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

export const getOrgAuditLog = defineOperation({
  name: 'organizations.getAuditLog',
  method: 'GET',
  path: '/api/orgs/:orgId/audit',
  inputSchema: z.strictObject({
    ...auditFilterShape,
    limit: z.number().int().min(1).max(500).optional(),
    /** The previous page's `nextCursor`. */
    before: z.number().int().nonnegative().optional(),
  }),
  outputSchema: z.object({ entries: z.array(auditEntrySchema), nextCursor: z.number().nullable() }),
  requiredScope: 'account',
  description: `Read the organization's audit log, newest first, filtered by event type or category, drive and time range, paged by the previous page's nextCursor. Owner and Admins only. ${KEY_RULES}`,
});

export const exportOrgAuditLog = defineOperation({
  name: 'organizations.exportAuditLog',
  method: 'GET',
  path: '/api/orgs/:orgId/audit/export',
  inputSchema: z.strictObject(auditFilterShape),
  outputSchema: z.string(),
  textResponse: true,
  expectedContentType: 'text/csv',
  requiredScope: 'account',
  // The whole log streams in one response; a large org's export runs well past the default 30s.
  timeoutMsOverride: 120_000,
  description: `Export the organization's audit log as CSV (formula-neutralized), with the same filters as the log. Rate limited; the export itself is audited. Owner and Admins only. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Automations whose owner left ([D-OW-36])
// ---------------------------------------------------------------------------

/** `AutomationKind` (`packages/lib/src/organizations/automation-ownership.ts`). */
const automationKindSchema = z.enum(['workflow', 'page_webhook']);

const automationInput = { ...orgIdInput, kind: automationKindSchema, automationId: z.string().min(1) };

export const listOrgAutomations = defineOperation({
  name: 'organizations.listAutomations',
  method: 'GET',
  path: '/api/orgs/:orgId/automations',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({
    automations: z.array(
      z.object({ kind: automationKindSchema, id: z.string(), driveId: z.string(), name: z.string(), ownerLeftAt: z.string() }),
    ),
  }),
  requiredScope: 'account',
  description: `List the organization's automations (workflows, page webhooks) whose creator left: disabled until reassigned or deleted. Owner and Admins only. ${KEY_RULES}`,
});

export const deleteOrgAutomation = defineOperation({
  name: 'organizations.deleteAutomation',
  method: 'DELETE',
  path: '/api/orgs/:orgId/automations/:kind/:automationId',
  inputSchema: z.strictObject(automationInput),
  outputSchema: z.object({ deleted: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description: `Delete an automation whose creator left (a workflow takes its triggers with it). Owner and Admins only; an automation whose owner is still here is refused (owner_present). ${KEY_RULES}`,
});

export const reassignOrgAutomation = defineOperation({
  name: 'organizations.reassignAutomation',
  method: 'POST',
  path: '/api/orgs/:orgId/automations/:kind/:automationId/reassign',
  inputSchema: z.strictObject({ ...automationInput, newOwnerId: z.string().min(1) }),
  outputSchema: z.object({ reassigned: z.literal(true), newOwnerId: z.string() }),
  requiredScope: 'account',
  description: `Hand an automation whose creator left to a member who can reach its drive; it is switched back on and runs as them, bounded by their caps. Owner and Admins only. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Guests (POL-2)
// ---------------------------------------------------------------------------

/** `OrgGuestSource` (`packages/lib/src/permissions/org-read-models.ts`). */
const orgGuestSourceSchema = z.enum(['invited', 'page_link']);

/** `OrgGuest` (`packages/lib/src/permissions/org-read-models.ts`). */
const orgGuestSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  drives: z.array(z.object({ id: z.string(), name: z.string(), pending: z.boolean(), source: orgGuestSourceSchema, pageCount: z.number() })),
});

export const listOrgGuests = defineOperation({
  name: 'organizations.listGuests',
  method: 'GET',
  path: '/api/orgs/:orgId/guests',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({ guests: z.array(orgGuestSchema) }),
  requiredScope: 'account',
  description: `List the organization's guests (people outside the org with access to its drives) and the drives each reaches. Owner and Admins only. ${KEY_RULES}`,
});

/** `GuestHoldOrigin` (`packages/db/src/schema/org-guest-holds.ts`). */
const guestHoldOriginSchema = z.enum(['invite', 'drive_link', 'page_link', 'page_invite', 'page_grant']);

/** `PendingGuestApprovalView` (`packages/lib/src/permissions/guest-holds.ts`). */
const guestApprovalSchema = z.object({
  holdId: z.string(),
  driveId: z.string(),
  userId: z.string().nullable(),
  email: z.string().nullable(),
  origin: guestHoldOriginSchema,
  createdAt: z.string(),
  driveName: z.string(),
  requesterName: z.string().nullable(),
  request: z.object({
    role: z.string().nullable(),
    customRoleId: z.string().nullable(),
    pageGrants: z.number(),
    tokenScopes: z.number(),
    earliestExpiry: z.string().nullable(),
    viaLink: z.boolean(),
  }),
});

export const listOrgGuestApprovals = defineOperation({
  name: 'organizations.listGuestApprovals',
  method: 'GET',
  path: '/api/orgs/:orgId/guest-approvals',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({
    /** The whole queue's size; `items` is at most one page. */
    total: z.number(),
    items: z.array(guestApprovalSchema),
  }),
  requiredScope: 'account',
  description: `List outsiders waiting for approval under the org's "approve" guests policy: the drive, who is asking and what for. Owner and Admins only. ${KEY_RULES}`,
});

/** The approval queue's answer (POST /api/orgs/[orgId]/guest-approvals/[holdId]). */
export const GUEST_APPROVAL_DECISIONS = ['approve', 'decline'] as const;

export const answerOrgGuestApproval = defineOperation({
  name: 'organizations.answerGuestApproval',
  method: 'POST',
  path: '/api/orgs/:orgId/guest-approvals/:holdId',
  inputSchema: z.strictObject({ ...orgIdInput, holdId: z.string().min(1), decision: z.enum(GUEST_APPROVAL_DECISIONS) }),
  outputSchema: z.object({
    decided: z.enum(['approved', 'declined']),
    driveId: z.string().optional(),
    pageIds: z.array(z.string()).optional(),
    /** The replayed invite's own answer, where approval re-ran an invite. */
    result: z.unknown().optional(),
  }),
  requiredScope: 'account',
  description: `Approve or decline a queued guest. Approving admits them through the same path the original invite or link would have run. Owner and Admins only; a request already decided or of another org is 404. ${KEY_RULES}`,
});

// ---------------------------------------------------------------------------
// Verified domains (SEC-1) and departure suppressions ([D-OW-27])
// ---------------------------------------------------------------------------

/** `OrgDomainVerificationMethod` (`packages/db/src/schema/organizations.ts`). */
const domainVerificationMethodSchema = z.enum(['dns', 'email']);
/** The administrative mailboxes a proof link may be mailed to (the route's `domainVerifySchema`). */
const domainProofMailboxSchema = z.enum(['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster']);

/** `PublicOrgDomain` (`packages/lib/src/organizations/domains.ts`), plus the TXT record list/add carry. */
const orgDomainSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domain: z.string(),
  dnsToken: z.string(),
  emailTokenExpiresAt: z.string().nullable(),
  emailSentTo: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedMethod: domainVerificationMethodSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  dnsRecord: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }).optional(),
});

export const listOrgDomains = defineOperation({
  name: 'organizations.listDomains',
  method: 'GET',
  path: '/api/orgs/:orgId/domains',
  inputSchema: z.strictObject(orgIdInput),
  outputSchema: z.object({ domains: z.array(orgDomainSchema) }),
  requiredScope: 'account',
  description: `List the organization's domain claims, their verification status and the DNS TXT record each needs. Owner and Admins only. ${KEY_RULES}`,
});

export const addOrgDomain = defineOperation({
  name: 'organizations.addDomain',
  method: 'POST',
  path: '/api/orgs/:orgId/domains',
  inputSchema: z.strictObject({ ...orgIdInput, domain: z.string().min(1).max(253) }),
  outputSchema: z.object({ domain: orgDomainSchema }),
  requiredScope: 'account',
  description: `Claim a domain for the organization (pending until verified). Shared email providers and domains another org verified are refused. Owner and Admins only. ${KEY_RULES}`,
});

export const removeOrgDomain = defineOperation({
  name: 'organizations.removeDomain',
  method: 'DELETE',
  path: '/api/orgs/:orgId/domains/:domainId',
  inputSchema: z.strictObject({ ...orgIdInput, domainId: z.string().min(1) }),
  outputSchema: z.object({ removed: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description: `Remove a domain claim from the organization. Owner and Admins only. ${KEY_RULES}`,
});

export const verifyOrgDomain = defineOperation({
  name: 'organizations.verifyDomain',
  method: 'POST',
  path: '/api/orgs/:orgId/domains/:domainId/verify',
  inputSchema: z.strictObject({
    ...orgIdInput,
    domainId: z.string().min(1),
    method: domainVerificationMethodSchema,
    /** Required with `method: 'email'`: the administrative mailbox the one-use link is mailed to. */
    mailbox: domainProofMailboxSchema.optional(),
  }),
  outputSchema: z.union([
    z.object({ domain: orgDomainSchema, alreadyVerified: z.boolean() }),
    z.object({ sentTo: z.string(), expiresAt: z.string() }),
  ]),
  requiredScope: 'account',
  description: `Verify a domain claim: method "dns" checks its TXT record now; method "email" mails a one-use link to an administrative mailbox of the domain (mailbox: admin, administrator, hostmaster, postmaster or webmaster), confirmed with organizations.confirmDomainEmail. Owner and Admins only. ${KEY_RULES}`,
});

export const confirmOrgDomainEmail = defineOperation({
  name: 'organizations.confirmDomainEmail',
  method: 'POST',
  path: '/api/orgs/domains/verify-email',
  inputSchema: z.strictObject({ token: z.string().min(1).max(256) }),
  outputSchema: z.object({ domain: z.string(), verified: z.literal(true) }),
  requiredScope: 'account',
  description:
    'Confirm a mailed domain proof link with its token: holding the mailbox is the proof, so any signed-in account may confirm it (often IT, not an org member). Rate limited. Requires a key with no drive restriction.',
});

export const clearOrgSuppression = defineOperation({
  name: 'organizations.clearSuppression',
  method: 'POST',
  path: '/api/orgs/:orgId/suppressions/clear',
  inputSchema: z.strictObject({ ...orgIdInput, email: z.string().min(3).max(254) }),
  outputSchema: z.object({ cleared: z.boolean() }),
  requiredScope: 'account',
  description: `Let a departed member's email address be auto-joined by a verified domain again. The answer is only whether a record was cleared; the address is never stored or echoed. Owner and Admins only. ${KEY_RULES}`,
});

/** The org-wide drive visibility vocabulary, for the drive-org operations in `drives.ts`. */
export { orgDriveVisibilitySchema };
