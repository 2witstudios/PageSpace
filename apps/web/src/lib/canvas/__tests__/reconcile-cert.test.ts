/**
 * Shell tests for reconcileCustomDomainCert — the cert-advance flow shared by
 * the "Check SSL" route and the lazy reconcile on the domains-list GET. Fly, DB,
 * storage and site-file regeneration are all mocked; cert-action stays real
 * (pure decision).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));

const addCertificate = vi.fn();
const recheckCertificate = vi.fn();
vi.mock('@/lib/fly/certs', () => ({
  addCertificate: (...args: unknown[]) => addCertificate(...args),
  recheckCertificate: (...args: unknown[]) => recheckCertificate(...args),
  // Faithful to the real predicate — it accepts either credential. A stub that
  // only looked at FLY_API_TOKEN would hide the very bug this replaced.
  hasFlyCertCredential: () =>
    Boolean(process.env.FLY_API_TOKEN || process.env.FLY_MACHINES_ORG_TOKEN),
}));

const dbUpdate = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: { update: (...args: unknown[]) => dbUpdate(...args) },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
}));
vi.mock('@pagespace/db/schema/custom-domains', () => ({
  customDomains: { id: 'col_id', status: 'col_status' },
}));

const mirrorDriveToCustomHost = vi.fn().mockResolvedValue(undefined);
const clearCustomHost = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  mirrorDriveToCustomHost: (...args: unknown[]) => mirrorDriveToCustomHost(...args),
  clearCustomHost: (...args: unknown[]) => clearCustomHost(...args),
}));

const resolveTxtRecords = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/publish/dns-resolver', () => ({
  resolveTxtRecords: (...args: unknown[]) => resolveTxtRecords(...args),
}));

const regeneratePublishedSiteFiles = vi.fn().mockResolvedValue(undefined);
const renderDomainNotFoundOverride = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/canvas/publish-page', () => ({
  regeneratePublishedSiteFiles: (...args: unknown[]) => regeneratePublishedSiteFiles(...args),
  renderDomainNotFoundOverride: (...args: unknown[]) => renderDomainNotFoundOverride(...args),
}));

import { reconcileCustomDomainCert } from '../reconcile-cert';

const DRIVE_ID = 'drive-1';
const setMock = vi.fn();

function domain(status: string) {
  return { id: 'dom-1', driveId: DRIVE_ID, hostname: 'docs.acme.com', status };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A benign default: most cases never reach the re-check, and the ones that do
  // set their own. Without a default the mock resolves undefined, which is a
  // shape the real function can never return.
  recheckCertificate.mockResolvedValue({ ok: false, error: 'recheck not stubbed' });
  resolveTxtRecords.mockResolvedValue([]);
  process.env.FLY_API_TOKEN = 'test-token';
  // Cleared so a test that exercises the fallback cannot leak it into the guard
  // tests that follow, which assert the no-credential no-op.
  delete process.env.FLY_MACHINES_ORG_TOKEN;
  process.env.FLY_PROXY_APP_NAME = 'pagespace-proxy';
  setMock.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  dbUpdate.mockReturnValue({ set: setMock });
  mirrorDriveToCustomHost.mockResolvedValue(undefined);
  clearCustomHost.mockResolvedValue(undefined);
  regeneratePublishedSiteFiles.mockResolvedValue(undefined);
});

describe('reconcileCustomDomainCert — no-op guards', () => {
  it('is a no-op when FLY_API_TOKEN is unset (never flips to cert_failed)', async () => {
    delete process.env.FLY_API_TOKEN;

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result).toEqual({ status: 'verified', action: null });
    expect(addCertificate).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the status is not cert-eligible (e.g. pending)', async () => {
    const result = await reconcileCustomDomainCert(domain('pending'));

    expect(result).toEqual({ status: 'pending', action: null });
    expect(addCertificate).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op for dns_failed (DNS not confirmed)', async () => {
    const result = await reconcileCustomDomainCert(domain('dns_failed'));

    expect(result).toEqual({ status: 'dns_failed', action: null });
    expect(addCertificate).not.toHaveBeenCalled();
  });

  it('is a no-op for a platformOwned domain, even though `active` is cert-eligible', async () => {
    const result = await reconcileCustomDomainCert({ ...domain('active'), platformOwned: true });

    expect(result).toEqual({ status: 'active', action: null });
    expect(addCertificate).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
  });
});

describe('reconcileCustomDomainCert — cert advance', () => {
  it('verified + cert Ready → active, regenerates site files + re-mirrors', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(addCertificate).toHaveBeenCalledWith('pagespace-proxy', 'docs.acme.com');
    expect(result).toEqual({ status: 'active', action: 'mark-active', ownershipInstruction: null });
    expect(setMock).toHaveBeenCalledWith({ status: 'active' });
    expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com', expect.any(Function));
    expect(clearCustomHost).not.toHaveBeenCalled();
  });

  it('verified + cert not yet Ready → provisioning, no mirror/regenerate', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result).toEqual({ status: 'provisioning', action: 'provision', ownershipInstruction: null });
    expect(setMock).toHaveBeenCalledWith({ status: 'provisioning' });
    expect(regeneratePublishedSiteFiles).not.toHaveBeenCalled();
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
  });

  it('provisioning + still issuing → stays provisioning', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result).toEqual({ status: 'provisioning', action: 'poll-again', ownershipInstruction: null });
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
  });

  it('provisioning + cert Ready → active, regenerates + re-mirrors', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.status).toBe('active');
    expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com', expect.any(Function));
  });

  it('Fly error → cert_failed, clears the host prefix', async () => {
    addCertificate.mockResolvedValue({ ok: false, error: 'Fly API timeout' });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result).toEqual({ status: 'cert_failed', action: 'mark-failed', ownershipInstruction: null });
    expect(setMock).toHaveBeenCalledWith({ status: 'cert_failed' });
    expect(clearCustomHost).toHaveBeenCalledWith('docs.acme.com');
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
  });

  it('already-active re-check that stays active does NOT re-mirror or clear', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('active'));

    expect(result.status).toBe('active');
    expect(regeneratePublishedSiteFiles).not.toHaveBeenCalled();
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
    expect(clearCustomHost).not.toHaveBeenCalled();
  });
});

describe('reconcileCustomDomainCert — non-destructive read path (allowFailureTransition: false)', () => {
  it('Fly error is a no-op: does NOT flip to cert_failed, does NOT update the DB, does NOT clear', async () => {
    addCertificate.mockResolvedValue({ ok: false, error: 'Fly API timeout' });

    const result = await reconcileCustomDomainCert(domain('verified'), { allowFailureTransition: false });

    expect(result).toEqual({ status: 'verified', action: null });
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(clearCustomHost).not.toHaveBeenCalled();
  });

  it('still advances forward on success (verified + Ready → active) even with failures suppressed', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('verified'), { allowFailureTransition: false });

    expect(result.status).toBe('active');
    expect(setMock).toHaveBeenCalledWith({ status: 'active' });
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com', expect.any(Function));
  });

  it('still advances provisioning → provisioning (poll) with failures suppressed', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    const result = await reconcileCustomDomainCert(domain('provisioning'), { allowFailureTransition: false });

    expect(result.status).toBe('provisioning');
  });

  it('the default (no opts) STILL flips a Fly error to cert_failed + clears — explicit refresh path', async () => {
    addCertificate.mockResolvedValue({ ok: false, error: 'Fly API timeout' });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result.status).toBe('cert_failed');
    expect(clearCustomHost).toHaveBeenCalledWith('docs.acme.com');
  });
});

describe('reconcileCustomDomainCert — side effects never throw', () => {
  it('does not throw when clearCustomHost fails on cert_failed', async () => {
    addCertificate.mockResolvedValue({ ok: false, error: 'Fly down' });
    clearCustomHost.mockRejectedValueOnce(new Error('S3 down'));

    const result = await reconcileCustomDomainCert(domain('active'));

    expect(result.status).toBe('cert_failed');
  });

  it('does not throw when regenerate fails on activation (still re-mirrors)', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });
    regeneratePublishedSiteFiles.mockRejectedValueOnce(new Error('regen boom'));

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result.status).toBe('active');
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com', expect.any(Function));
  });

  it('does not throw when the fire-and-forget re-mirror rejects', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });
    mirrorDriveToCustomHost.mockRejectedValueOnce(new Error('mirror boom'));

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result.status).toBe('active');
  });
});

describe('reconcileCustomDomainCert — blocked on an _fly-ownership TXT', () => {
  /** A pending cert for which Fly is asking for an ownership record. */
  const pendingWithOwnership = {
    ok: true,
    configured: false,
    status: 'pending_validation',
    ownership: {
      name: '_fly-ownership.docs.acme.com',
      appValue: 'app-ABC',
      orgValue: 'org-XYZ',
    },
    ownershipTxtConfigured: false,
  };

  it('given the record is not published, should stay provisioning and say what is missing', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([]);

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    // Non-destructive: this is a domain that is FINE and merely waiting, so it
    // must not be flipped to cert_failed or have its mirrored prefix cleared.
    expect(result.status).toBe('provisioning');
    expect(result.action).toBe('blocked-on-ownership');
    expect(result.ownershipInstruction).toContain('_fly-ownership.docs.acme.com');
    expect(result.ownershipInstruction).toContain('app-ABC');
    expect(clearCustomHost).not.toHaveBeenCalled();
  });

  it('given the record IS published, should carry no instruction and resume ordinary polling', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([['app-ABC']]);

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.action).toBe('poll-again');
    expect(result.ownershipInstruction).toBeNull();
  });

  it('given the record is published at the ownership NAME, should resolve that name', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([['app-ABC']]);

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(resolveTxtRecords).toHaveBeenCalledWith('_fly-ownership.docs.acme.com');
  });

  it('given Fly has already SEEN the record, should skip the DNS read entirely', async () => {
    addCertificate.mockResolvedValue({ ...pendingWithOwnership, ownershipTxtConfigured: true });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(resolveTxtRecords).not.toHaveBeenCalled();
    expect(result.action).toBe('poll-again');
  });

  it('given Fly asked for no ownership record, should do no DNS work at all', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(resolveTxtRecords).not.toHaveBeenCalled();
  });

  it('given the DNS lookup fails, should not turn a resolver outage into a cert failure', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockRejectedValue(new Error('SERVFAIL'));

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.status).toBe('provisioning');
    expect(clearCustomHost).not.toHaveBeenCalled();
  });

  it('given a LIVE certificate, should activate regardless of what any record says', async () => {
    addCertificate.mockResolvedValue({ ...pendingWithOwnership, configured: true });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result.status).toBe('active');
    expect(result.action).toBe('mark-active');
  });
});

describe('reconcileCustomDomainCert — nudging Fly once the record is published', () => {
  const pendingWithOwnership = {
    ok: true,
    configured: false,
    status: 'pending_validation',
    ownership: { name: '_fly-ownership.docs.acme.com', appValue: 'app-ABC', orgValue: 'org-XYZ' },
    ownershipTxtConfigured: false,
  };

  it('given our resolver sees the record but Fly has not, should ask Fly to re-read DNS', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([['app-ABC']]);
    recheckCertificate.mockResolvedValue({ ...pendingWithOwnership, ownershipTxtConfigured: true });

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(recheckCertificate).toHaveBeenCalledWith('pagespace-proxy', 'docs.acme.com');
  });

  it('given the re-check reports the cert now live, should activate on this pass', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([['app-ABC']]);
    recheckCertificate.mockResolvedValue({ ok: true, configured: true, status: 'active' });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.status).toBe('active');
  });

  it('given Fly has ALREADY seen the record, should not re-check', async () => {
    addCertificate.mockResolvedValue({ ...pendingWithOwnership, ownershipTxtConfigured: true });

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(recheckCertificate).not.toHaveBeenCalled();
  });

  it('given the record is still MISSING, should not re-check — there is nothing new to see', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([]);

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(recheckCertificate).not.toHaveBeenCalled();
  });

  it('given no ownership requirement at all, should not re-check', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    await reconcileCustomDomainCert(domain('provisioning'));

    expect(recheckCertificate).not.toHaveBeenCalled();
  });

  it('given the re-check fails, should not let a Fly blip fail a healthy domain', async () => {
    addCertificate.mockResolvedValue(pendingWithOwnership);
    resolveTxtRecords.mockResolvedValue([['app-ABC']]);
    recheckCertificate.mockResolvedValue({ ok: false, error: 'Fly API 500' });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.status).toBe('provisioning');
    expect(clearCustomHost).not.toHaveBeenCalled();
  });
});

describe('reconcileCustomDomainCert — which Fly credential counts as configured', () => {
  it('given only FLY_MACHINES_ORG_TOKEN, should still reconcile', async () => {
    // The published-app deployment configures that token and not FLY_API_TOKEN.
    // Gating on FLY_API_TOKEN alone made the documented fallback unreachable from
    // here, so cert reconciliation silently never ran for exactly that setup.
    delete process.env.FLY_API_TOKEN;
    process.env.FLY_MACHINES_ORG_TOKEN = 'org-token';
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(addCertificate).toHaveBeenCalled();
    expect(result.status).toBe('active');
  });

  it('given NEITHER credential, should stay a no-op and never flip the domain', async () => {
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_MACHINES_ORG_TOKEN;

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(addCertificate).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'verified', action: null });
  });
});
