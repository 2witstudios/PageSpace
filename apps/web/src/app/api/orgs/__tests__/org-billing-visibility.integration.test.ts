// @vitest-environment node
/**
 * SEAT-6 end to end: every org billing route handler, the real org gate (requireOrgRole over
 * the real membership rows), the real billing gate (DEPLOYMENT_MODE read per call), the real
 * org billing shell and a REAL Postgres. Stripe is the in-memory FakeOrgStripe behind the
 * shell's adapter seam, wrapped so every port call is counted; the app's raw Stripe client is
 * replaced by one that fails the test if anything reaches it.
 *
 * Only authentication is faked (who is calling), and ORGS_ENABLED (a dark-ship code constant)
 * is turned on.
 *
 * Requires DATABASE_URL → a migrated Postgres (requireDb). Deletes every row it creates.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { seatRefusalMessage } from '@pagespace/lib/organizations/seats';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import type { OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgBillingDeps, OrgBillingStripe } from '@/lib/org-billing/org-subscription';
import { FakeOrgStripe } from '@/lib/org-billing/__tests__/fake-org-stripe';
import { orgHubSections } from '@/lib/orgs/org-hub';

const harness = vi.hoisted(() => ({
  callerId: null as string | null,
  /** Every call that reached the org billing Stripe port, by method. */
  stripeCalls: [] as string[],
  /** Any touch of the app's raw Stripe client (nothing may bypass the port). */
  rawStripeTouches: [] as string[],
  stripe: null as unknown,
}));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    authenticateRequestWithOptions: vi.fn(async (): Promise<SessionAuthResult> => {
      if (!harness.callerId) throw new Error('no caller set');
      return { userId: harness.callerId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess_seat6', role: 'user', adminRoleVersion: 0 };
    }),
    isAuthError: (result: object) => 'error' in result,
  };
});
vi.mock('@/lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stripe')>();
  const tripwire: unknown = new Proxy(() => undefined, {
    get: (_t, prop) => {
      harness.rawStripeTouches.push(String(prop));
      return tripwire;
    },
    apply: () => {
      harness.rawStripeTouches.push('call');
      throw new Error('raw Stripe client reached in SEAT-6 test');
    },
  });
  return { ...actual, stripe: tripwire };
});
// The shell's own default deps resolve inside the module, so the three entry points the routes
// call are rebound to the counted fake. The shell bodies are the real ones.
vi.mock('@/lib/org-billing/org-subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/org-billing/org-subscription')>();
  const deps = (): OrgBillingDeps => ({
    stripe: harness.stripe as OrgBillingStripe,
    prices: () => PRICES_FOR_MOCK,
    countSeats: async () => 1,
  });
  const PRICES_FOR_MOCK: OrgBusinessPrices = { basePriceId: 'price_seat6_base', seatPriceId: 'price_seat6_seat' };
  return {
    ...actual,
    provisionOrgSubscription: (orgId: string) => actual.provisionOrgSubscription(orgId, deps()),
    listOrgInvoices: (orgId: string, opts: { limit: number; startingAfter?: string }) => actual.listOrgInvoices(orgId, opts, deps()),
    createOrgBillingPortalSession: (orgId: string, returnUrl: string) => actual.createOrgBillingPortalSession(orgId, returnUrl, deps()),
  };
});

import { POST as subscriptionPOST } from '../[orgId]/billing/subscription/route';
import { GET as seatsGET, PATCH as seatsPATCH } from '../[orgId]/billing/seats/route';
import { GET as invoicesGET } from '../[orgId]/billing/invoices/route';
import { POST as portalPOST } from '../[orgId]/billing/portal/route';

/** A FakeOrgStripe whose every method call is recorded in harness.stripeCalls. */
function countedStripe(): OrgBillingStripe {
  const fake = new FakeOrgStripe();
  return new Proxy(fake, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        harness.stripeCalls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

type Mode = 'cloud' | 'onprem' | 'tenant';
type Caller = OrgRole | 'OUTSIDER';
const CALLERS: readonly Caller[] = ['OWNER', 'ADMIN', 'MEMBER', 'OUTSIDER'];
const MODES: readonly Mode[] = ['cloud', 'onprem', 'tenant'];

interface RouteCase {
  name: string;
  /** The least role the route serves. */
  minRole: OrgRole;
  call: (orgId: string) => Promise<Response>;
  /** Owner/Admin in cloud: the status a served call answers and whether it reached Stripe. */
  served: number[];
}

const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const url = (orgId: string, path: string) => `https://app.test/api/orgs/${orgId}/billing/${path}`;

// subscription first: it creates the org's Stripe customer the portal then opens a session on.
const ROUTES: readonly RouteCase[] = [
  { name: 'POST subscription', minRole: 'ADMIN', served: [200, 201], call: (o) => subscriptionPOST(new Request(url(o, 'subscription'), { method: 'POST' }), ctx(o)) },
  { name: 'GET seats', minRole: 'ADMIN', served: [200], call: (o) => seatsGET(new Request(url(o, 'seats')), ctx(o)) },
  { name: 'PATCH seats', minRole: 'OWNER', served: [200], call: (o) => seatsPATCH(new Request(url(o, 'seats'), { method: 'PATCH', body: JSON.stringify({ autoAdd: true }) }), ctx(o)) },
  { name: 'GET invoices', minRole: 'ADMIN', served: [200], call: (o) => invoicesGET(new Request(url(o, 'invoices')), ctx(o)) },
  { name: 'POST portal', minRole: 'ADMIN', served: [200], call: (o) => portalPOST(new Request(url(o, 'portal'), { method: 'POST' }), ctx(o)) },
];

const RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const orgIds: string[] = [];
const userIds: string[] = [];

async function person(label: string): Promise<string> {
  const user = await factories.createUser({ email: `seat6+${label}${Date.now()}${Math.random().toString(36).slice(2, 8)}@northwind.test`, name: label });
  userIds.push(user.id);
  return user.id;
}

/** Northwind with an Owner, an Admin and a Member; plus someone who belongs to no part of it. */
async function northwind(): Promise<{ orgId: string; ids: Record<Caller, string> }> {
  const owner = await person('owner');
  const created = await createOrganization({ name: 'Northwind Labs', slug: `northwind-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  const orgId = created.organization.id;
  orgIds.push(orgId);
  const admin = await person('admin');
  const member = await person('member');
  await db.insert(orgMembers).values([
    { orgId, userId: admin, role: 'ADMIN' },
    { orgId, userId: member, role: 'MEMBER' },
  ]);
  return { orgId, ids: { OWNER: owner, ADMIN: admin, MEMBER: member, OUTSIDER: await person('outsider') } };
}

describe('org billing visibility (real Postgres, counted Stripe port)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-billing-visibility.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (!dbAvailable) return;
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEAT-6 plan, seat count, invoices, billing email and portal are served to the Owner and Admins only: on every billing route a Member and a non-member are refused before any Stripe call and never see a seat count (nor in a seats_full refusal); with DEPLOYMENT_MODE onprem or tenant every billing route is absent (one 404 billing_unavailable for every role, no Stripe call) and no hub shows a Billing section', async () => {
    if (!dbAvailable) return;
    harness.stripe = countedStripe();

    for (const mode of MODES) {
      process.env.DEPLOYMENT_MODE = mode;
      // A fresh org per mode, so a cloud call cannot pre-create what an onprem call would read.
      const { orgId, ids } = await northwind();

      for (const route of ROUTES) {
        for (const caller of CALLERS) {
          const where = `${mode} ${route.name} as ${caller}`;
          harness.callerId = ids[caller];
          harness.stripeCalls.length = 0;
          const response = await route.call(orgId);
          const body = (await response.json()) as Record<string, unknown>;

          if (mode !== 'cloud') {
            expect({ where, status: response.status, code: body.code }).toEqual({ where, status: 404, code: 'billing_unavailable' });
            expect(harness.stripeCalls, where).toEqual([]);
            continue;
          }
          if (caller === 'OUTSIDER') {
            expect({ where, status: response.status, code: body.code }).toEqual({ where, status: 404, code: 'org_not_found' });
            expect(harness.stripeCalls, where).toEqual([]);
            expect(JSON.stringify(body), where).not.toMatch(/\d/);
            continue;
          }
          if (RANK[caller] < RANK[route.minRole]) {
            expect({ where, status: response.status, code: body.code }).toEqual({ where, status: 403, code: 'insufficient_role' });
            expect(harness.stripeCalls, where).toEqual([]);
            // A refused caller learns nothing about the plan: no count, no price, no Stripe id.
            expect(JSON.stringify(body), where).not.toMatch(/\d|seat|cus_|sub_/i);
            continue;
          }
          expect(route.served, `${where} answered ${response.status} ${JSON.stringify(body)}`).toContain(response.status);
        }
      }

      if (mode === 'cloud') {
        // What "served" means: the Owner/Admin read the plan, the seat count, the invoices and a
        // portal session (where the billing email is managed) on the ORG's own Stripe customer.
        harness.callerId = ids.ADMIN;
        const seats = (await (await seatsGET(new Request(url(orgId, 'seats')), ctx(orgId))).json()) as { seats: { held: number; purchased: number; autoAdd: boolean } };
        expect(seats.seats).toMatchObject({ held: 3, autoAdd: true });
        expect(typeof seats.seats.purchased).toBe('number');
        const portal = (await (await portalPOST(new Request(url(orgId, 'portal'), { method: 'POST' }), ctx(orgId))).json()) as { url: string };
        const [stored] = await db.select({ customer: organizations.stripeCustomerId }).from(organizations).where(inArray(organizations.id, [orgId]));
        expect(portal.url).toBe(`https://billing.stripe.test/p/session/${stored.customer}`);
        const invoices = await (await invoicesGET(new Request(url(orgId, 'invoices')), ctx(orgId))).json();
        expect(invoices).toHaveProperty('invoices');
      }

      // The hub: only an Owner or Admin with billing on gets a Billing section.
      for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
        const titles = orgHubSections({ orgId, orgName: 'Northwind Labs', role, counts: {}, billingEnabled: isBillingEnabled() }).map((s) => s.title);
        expect({ mode, role, billing: titles.includes('Billing') }).toEqual({ mode, role, billing: mode === 'cloud' && role !== 'MEMBER' });
      }
    }

    // The seats_full refusal a Member may hit when inviting (POL-5) names no seat count.
    expect(seatRefusalMessage({ purchased: 7, held: 7, actorRole: 'MEMBER' })).not.toMatch(/\d/);
    // Nothing anywhere bypassed the port to reach Stripe directly.
    expect(harness.rawStripeTouches).toEqual([]);
  });
});
