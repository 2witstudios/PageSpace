/**
 * Organization READ operations (Spec X-1): `organizations.list`, `organizations.get`,
 * `organizations.listMembers`, `organizations.listDrives`, `organizations.getPolicies`.
 *
 * Route-verified against `apps/web/src/app/api/orgs/route.ts` GET,
 * `apps/web/src/app/api/orgs/[orgId]/route.ts` GET,
 * `apps/web/src/app/api/orgs/[orgId]/members/route.ts` GET,
 * `apps/web/src/app/api/orgs/[orgId]/drives/route.ts` GET (the org Drives directory,
 * DRV-6 — the only place a Restricted drive is discovered before joining) and
 * `apps/web/src/app/api/orgs/[orgId]/policies/route.ts` GET (POL-1; Owner and Admins
 * only, SEAT-6). All five go through the web's ONE org authorization function
 * `requireOrgRole` (ORG-5); none re-implements it.
 *
 * READS ONLY, deliberately. Every org WRITE (create, rename, delete, invite, remove,
 * role change, policy change, billing) needs a signed-in session on the server today,
 * so there is no write operation here at all — an operation that can only ever be
 * refused has no place on the registry or the MCP tool surface (the wallets.ts
 * reasoning, generalized).
 *
 * Key scope. Org reads are ORG-WIDE, not drive-wide: a key scoped to specific drives
 * is refused (403 `token_scope_refused`) on the org list, the org detail, the member
 * roster and the policies — the same rule `wallets.list` applies to account-wide reads.
 * The one exception is the drive directory: a scoped key may list it, but it only shows
 * drives the key's scope already covers, so a key never widens its own reach through it.
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
    'List the organizations you belong to, each with your role in it (OWNER, ADMIN or MEMBER) and whether it is currently lapsed (read-only). Requires a key with no drive restriction — a drive-scoped key is refused, since this lists organizations outside its scope.',
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
    /** The billing banner this caller qualifies for (lapse, failed payment, trial); absent when there is nothing to say. */
    billingNotice: billingNoticeSchema,
  }),
  requiredScope: 'account',
  description:
    "Read one organization you belong to: its identity and owner, your own role in it, and the billing notice your role qualifies for (plan detail is Owner/Admin only). Requires a key with no drive restriction — a drive-scoped key is refused. Not found for an org you are not a member of.",
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
    'List the members of an organization you belong to: each person, their org role, when they joined, and their name and email. Requires a key with no drive restriction — a drive-scoped key is refused, since a member roster is wider than any drive scope.',
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
    "List the organization's drive directory for you (any org member): every Open and Restricted drive with its visibility, whether you have joined it, your open join request, and its lead — the only place a Restricted drive is discovered before joining. Private drives appear only where you can already open them. A key scoped to specific drives sees only those drives here.",
});

/** `OrgPolicies` (`packages/lib/src/organizations/policies-core.ts`) — every key always present, defaults filled in (POL-1). */
const orgPoliciesSchema = z.object({
  guests: z.enum(['off', 'approve', 'on']),
  publicShareLinks: z.boolean(),
  publishWeb: z.boolean(),
  customDomains: z.boolean(),
  whoCanInvite: z.enum(['admins', 'members']),
  whoCanCreateDrives: z.enum(['admins', 'members']),
  openDriveRoleFloor: z.enum(['view', 'edit']),
  /** Per-consumer monthly seat allowance, whole cents of credit value. Never unlimited. */
  seatAllowanceCents: z.number(),
  walletFallback: z.enum(['refuse', 'seat_allowance', 'own_credits']),
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
    "Read an organization's policies with a default filled in for every key (guests, sharing, publishing, invites, drive creation, the Open-drive role floor, the seat allowance and wallet fallback, model/provider/integration allowlists, agent autonomy, sandbox and environments). Owner and Admins only — a plain member is refused (403) and a non-member gets 404. Changing policies needs a signed-in session. Requires a key with no drive restriction.",
});
