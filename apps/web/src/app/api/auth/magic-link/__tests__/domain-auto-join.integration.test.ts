/**
 * Verified-domain auto-join through the REAL sign-up routes against a REAL Postgres (Spec SEC-1).
 *
 * A new person signs up the way the product signs them up: POST /api/auth/magic-link/send (which creates the
 * account) and then GET /api/auth/magic-link/verify with the link from the captured email, or with Google through
 * GET /api/auth/google/callback (only Google's token exchange and ID-token check are faked). Nothing in between is
 * mocked: the account, the email verification, the domain lookup, the seat count under the billing lock, the
 * membership row and the org audit trail are all real. Only external IO is replaced: the outgoing email (captured,
 * to read the link) and Stripe (a recording seat port, for the extra seat when auto-add is on).
 *
 * The domain is proved both ways the Spec allows (a DNS TXT record through a fake resolver, and the admin-mailbox
 * email link), and the cases that must NOT join are driven through the same routes.
 *
 * Every row a test creates is deleted, children before parents, users last (audit rows stay: they are chain links).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgDomains, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import type { SeatBillingPort } from '@pagespace/lib/organizations/seat-service';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

/**
 * apps/web loads @pagespace/lib from its built CommonJS dist, and lib's own modules read the dark-ship constant
 * through require(), which vi.mock does not reach. Orgs are switched on for lib the only way that reaches it: on
 * the one shared module object every dist require() returns, restored after the suite.
 */
const libOrgsFlag = createRequire(import.meta.url)('@pagespace/lib/organizations/orgs-enabled') as { ORGS_ENABLED: boolean };
const shippedOrgsEnabled = libOrgsFlag.ORGS_ENABLED;

const mail = vi.hoisted(() => ({ links: new Map<string, string>() }));
vi.mock('@pagespace/lib/services/email-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/email-service')>()),
  // The magic-link email is the only mail these sign-ups send; keep its link, send nothing.
  sendEmail: vi.fn(async (input: { to: string; react: { props: { magicLinkUrl?: string } } }) => {
    if (input.react.props.magicLinkUrl) mail.links.set(input.to, input.react.props.magicLinkUrl);
  }),
}));

const stripe = vi.hoisted(() => ({ calls: [] as Array<{ quantity: number }> }));
vi.mock('@/lib/org-billing/seat-billing', () => ({
  defaultSeatBilling: (): SeatBillingPort => ({
    async setSeatQuantity(params) {
      stripe.calls.push({ quantity: params.quantity });
      return { quantity: params.quantity };
    },
    async readSeatQuantity() {
      return 0;
    },
  }),
}));

const google = vi.hoisted(() => ({ payload: null as null | { sub: string; email: string; email_verified: boolean; name: string } }));
vi.mock('google-auth-library', () => ({
  // Google's side of the code exchange: the token endpoint and the ID-token check, answered with the test's payload.
  OAuth2Client: class {
    async getToken() {
      return { tokens: { id_token: 'google-id-token' } };
    }
    async verifyIdToken() {
      return { getPayload: () => google.payload };
    }
  },
}));

import { createHmac } from 'node:crypto';
import { generateLoginCSRFToken } from '@/lib/auth/login-csrf-utils';
import { resetAuditDbBindingForTests } from '@pagespace/lib/audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '@pagespace/lib/audit/security-audit';
import { queryOrgAuditEvents } from '@pagespace/lib/audit/org-audit-query';
import { ORG_AUDIT_EVENT_TYPES } from '@pagespace/lib/audit/org-audit-query-core';
import { userEmailMatch } from '@pagespace/lib/auth/user-repository';
import { addOrgDomain, confirmDomainProofEmail, sendDomainProofEmail, verifyOrgDomainByDns } from '@pagespace/lib/organizations/domains';
import { dnsRecordName, dnsRecordValue } from '@pagespace/lib/organizations/domains-core';
import { POST as sendMagicLink } from '../send/route';
import { GET as verifyMagicLink } from '../verify/route';
import { GET as googleCallback } from '../../google/callback/route';

const HOUR = 3_600_000;
const created = { orgs: [] as string[], users: [] as string[] };

/** The audit chain is read on the main database (see the org audit route integration suite for why). */
const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedAuditEnv = new Map<string, string | undefined>(AUDIT_ENV.map((key) => [key, process.env[key]]));

let dbAvailable = false;
beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('domain-auto-join.integration.test.ts', error);
  }
  for (const key of AUDIT_ENV) delete process.env[key];
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
  vi.stubEnv('WEB_APP_URL', 'http://localhost');
  vi.stubEnv('OAUTH_STATE_SECRET', 'sec-1-oauth-state-secret-for-integration-tests');
  libOrgsFlag.ORGS_ENABLED = true;
});

afterEach(async () => {
  stripe.calls = [];
  mail.links.clear();
  if (!dbAvailable) return;
  if (created.orgs.length) {
    await db.delete(drives).where(inArray(drives.orgId, created.orgs));
    await db.delete(orgDomains).where(inArray(orgDomains.orgId, created.orgs));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgs));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgs));
    await db.delete(organizations).where(inArray(organizations.id, created.orgs));
  }
  if (created.users.length) {
    await db.delete(drives).where(inArray(drives.ownerId, created.users));
    await db.delete(users).where(inArray(users.id, created.users));
  }
  created.orgs = [];
  created.users = [];
});

afterAll(async () => {
  libOrgsFlag.ORGS_ENABLED = shippedOrgsEnabled;
  vi.unstubAllEnvs();
  for (const [key, value] of savedAuditEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
});

async function person(email: string, createdAt = new Date()) {
  const user = await factories.createUser({ email, emailVerified: new Date(), createdAt, subscriptionTier: 'free' });
  created.users.push(user.id);
  return user;
}

/** Northwind Labs on the Business plan (5 included seats), `members` people in it including Jono, the Owner. */
async function northwind(input: { members: number; autoAdd: boolean }) {
  const jono = await person(`jono-${createId()}@owner.test`);
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, seatAutoAdd: input.autoAdd })
    .returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: jono.id, role: 'OWNER' });
  for (let i = 1; i < input.members; i++) {
    const m = await person(`member-${i}-${createId()}@elsewhere.test`);
    await db.insert(orgMembers).values({ orgId: org.id, userId: m.id, role: 'MEMBER' });
  }
  await db.insert(orgSubscriptions).values({
    orgId: org.id,
    stripeSubscriptionId: `sub_${createId()}`,
    stripeBasePriceId: 'price_base_test',
    stripeBaseItemId: `si_${createId()}`,
    stripeSeatPriceId: 'price_seat_test',
    stripeSeatItemId: `si_${createId()}`,
    extraSeatQuantity: 0,
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 20 * 24 * HOUR),
    currentPeriodEnd: new Date(Date.now() + 10 * 24 * HOUR),
  });
  await factories.fundOrgSubscription(org.id);
  return { org, jono };
}

const freshDomain = () => `northwind-${createId()}.com`;

async function claim(orgId: string, actorId: string, domain: string) {
  const added = await addOrgDomain({ orgId, domain, actorId });
  if (!added.ok) throw new Error(`add failed: ${added.reason}`);
  return added.domain;
}

async function verifyByDns(orgId: string, actorId: string, domain = freshDomain()) {
  const row = await claim(orgId, actorId, domain);
  const verified = await verifyOrgDomainByDns({
    orgId, domainId: row.id, actorId, now: new Date(),
    resolveTxt: async (name) => (name === dnsRecordName(domain) ? [[dnsRecordValue(row.dnsToken)]] : []),
  });
  if (!verified.ok) throw new Error(`dns verify failed: ${verified.reason}`);
  return domain;
}

async function verifyByEmail(orgId: string, actorId: string, domain = freshDomain()) {
  const row = await claim(orgId, actorId, domain);
  let token = '';
  const sent = await sendDomainProofEmail({
    orgId, domainId: row.id, mailbox: 'postmaster', actorId, now: new Date(),
    deliver: async (proof) => { token = proof.token; },
  });
  if (!sent.ok) throw new Error('proof email not sent');
  const confirmed = await confirmDomainProofEmail({ token, actorId, now: new Date() });
  if (!confirmed.ok) throw new Error(`email verify failed: ${confirmed.reason}`);
  return domain;
}

/** Sign up (or in) through the two real routes; returns the account the routes created or found. */
async function signUp(email: string) {
  const csrf = generateLoginCSRFToken();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const sent = await sendMagicLink(new Request('http://localhost/api/auth/magic-link/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-login-csrf-token': csrf, cookie: `login_csrf=${csrf}`, 'x-forwarded-for': ip },
    body: JSON.stringify({ email, tosAccepted: true }),
  }));
  expect(sent.status).toBe(200);
  const link = mail.links.get(email);
  if (!link) throw new Error(`no magic link was emailed to ${email}`);
  const token = new URL(link).searchParams.get('token');
  const verified = await verifyMagicLink(new Request(`http://localhost/api/auth/magic-link/verify?token=${token}`, {
    headers: { 'x-forwarded-for': ip },
  }));
  expect(verified.status).toBe(302);
  expect(verified.headers.get('location')).toContain('auth=success');
  const [user] = await db.select({ id: users.id }).from(users).where(userEmailMatch(email));
  if (!user) throw new Error('sign-up created no account');
  if (!created.users.includes(user.id)) created.users.push(user.id);
  return user.id;
}

/** Sign up with Google through the real callback route: a signed state, Google answering with a verified address. */
async function signUpWithGoogle(email: string) {
  google.payload = { sub: `google-${createId()}`, email, email_verified: true, name: 'New Person' };
  const data = { returnUrl: '/dashboard', platform: 'web' as const, timestamp: Date.now() };
  const sig = createHmac('sha256', process.env.OAUTH_STATE_SECRET ?? '').update(JSON.stringify(data)).digest('hex');
  const state = Buffer.from(JSON.stringify({ data, sig })).toString('base64');
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const res = await googleCallback(new Request(`http://localhost/api/auth/google/callback?code=auth-code-${createId()}&state=${encodeURIComponent(state)}`, {
    headers: { 'x-forwarded-for': ip },
  }));
  expect(res.headers.get('location') ?? '').not.toContain('error=');
  const [user] = await db.select({ id: users.id }).from(users).where(userEmailMatch(email));
  if (!user) throw new Error('Google sign-up created no account');
  if (!created.users.includes(user.id)) created.users.push(user.id);
  return user.id;
}

const roleIn = async (orgId: string, userId: string) =>
  (await db.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))))[0]?.role ?? null;

const auditOf = async (orgId: string, userId: string) =>
  (await queryOrgAuditEvents(orgId, { eventTypes: [...ORG_AUDIT_EVENT_TYPES], driveId: null, from: null, to: null, limit: 100, before: null }))
    .entries.filter((e) => e.resourceId === userId);

describe('SEC-1 verified email domains auto-join new sign-ups through the real sign-up routes, subject to seats', () => {
  it('a new sign-up on a DNS-verified domain joins as MEMBER while a seat is free, and the join is audited', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 2, autoAdd: false });
    const domain = await verifyByDns(org.id, jono.id);

    const sam = await signUp(`sam-${createId()}@${domain}`);

    expect(await roleIn(org.id, sam)).toBe('MEMBER');
    expect(stripe.calls).toEqual([]);
    expect((await auditOf(org.id, sam)).map((e) => e.eventType)).toContain('org.member.auto_joined');
  });

  it('a new sign-up on a domain verified by the admin-mailbox email link joins the same way', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 1, autoAdd: false });
    const domain = await verifyByEmail(org.id, jono.id);

    const lee = await signUp(`lee-${createId()}@${domain}`);

    expect(await roleIn(org.id, lee)).toBe('MEMBER');
  });

  it('a domain that is only claimed, not verified, auto-joins nobody', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 1, autoAdd: false });
    const domain = freshDomain();
    await claim(org.id, jono.id, domain);

    const ava = await signUp(`ava-${createId()}@${domain}`);

    expect(await roleIn(org.id, ava)).toBeNull();
    expect(await auditOf(org.id, ava)).toEqual([]);
  });

  it('an account that existed before the domain was verified is not a new sign-up and is not added when it signs in', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 1, autoAdd: false });
    const domain = freshDomain();
    const email = `early-${createId()}@${domain}`;
    const early = await person(email, new Date(Date.now() - 2 * HOUR));
    await verifyByDns(org.id, jono.id, domain);

    expect(await signUp(email)).toBe(early.id);

    expect(await roleIn(org.id, early.id)).toBeNull();
  });

  it('with every seat taken and auto-add off the sign-up is refused, the account still works, and the refusal is audited', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 5, autoAdd: false });
    const domain = await verifyByDns(org.id, jono.id);

    const kim = await signUp(`kim-${createId()}@${domain}`);

    expect(await roleIn(org.id, kim)).toBeNull();
    expect(stripe.calls).toEqual([]);
    const refused = (await auditOf(org.id, kim)).find((e) => e.eventType === 'org.member.auto_join_refused');
    expect(refused?.details).toMatchObject({ domain, reason: 'seats_full' });
  });

  it('with every seat taken and auto-add on the sign-up buys one extra seat and joins', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 5, autoAdd: true });
    const domain = await verifyByDns(org.id, jono.id);

    const max = await signUp(`max-${createId()}@${domain}`);

    expect(await roleIn(org.id, max)).toBe('MEMBER');
    expect(stripe.calls).toEqual([{ quantity: 1 }]);
    const [sub] = await db.select({ extra: orgSubscriptions.extraSeatQuantity }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.id));
    expect(sub.extra).toBe(1);
  });

  it('a new Google sign-up through the OAuth callback on a verified domain joins as MEMBER while a seat is free', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 2, autoAdd: false });
    const domain = await verifyByDns(org.id, jono.id);

    const gia = await signUpWithGoogle(`gia-${createId()}@${domain}`);

    expect(await roleIn(org.id, gia)).toBe('MEMBER');
    expect((await auditOf(org.id, gia)).map((e) => e.eventType)).toContain('org.member.auto_joined');
  });

  it('a new Google sign-up on a domain that is only claimed, not verified, joins nobody', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 1, autoAdd: false });
    const domain = freshDomain();
    await claim(org.id, jono.id, domain);

    const hal = await signUpWithGoogle(`hal-${createId()}@${domain}`);

    expect(await roleIn(org.id, hal)).toBeNull();
  });

  it('a new Google sign-up into a full org with auto-add off is refused and audited', async () => {
    if (!dbAvailable) return;
    const { org, jono } = await northwind({ members: 5, autoAdd: false });
    const domain = await verifyByDns(org.id, jono.id);

    const ivy = await signUpWithGoogle(`ivy-${createId()}@${domain}`);

    expect(await roleIn(org.id, ivy)).toBeNull();
    expect(stripe.calls).toEqual([]);
    const refused = (await auditOf(org.id, ivy)).find((e) => e.eventType === 'org.member.auto_join_refused');
    expect(refused?.details).toMatchObject({ domain, reason: 'seats_full' });
  });
});
