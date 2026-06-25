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
vi.mock('@/lib/fly/certs', () => ({
  addCertificate: (...args: unknown[]) => addCertificate(...args),
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

const regeneratePublishedSiteFiles = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/canvas/publish-page', () => ({
  regeneratePublishedSiteFiles: (...args: unknown[]) => regeneratePublishedSiteFiles(...args),
}));

import { reconcileCustomDomainCert } from '../reconcile-cert';

const DRIVE_ID = 'drive-1';
const setMock = vi.fn();

function domain(status: string) {
  return { id: 'dom-1', driveId: DRIVE_ID, hostname: 'docs.acme.com', status };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLY_API_TOKEN = 'test-token';
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
});

describe('reconcileCustomDomainCert — cert advance', () => {
  it('verified + cert Ready → active, regenerates site files + re-mirrors', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(addCertificate).toHaveBeenCalledWith('pagespace-proxy', 'docs.acme.com');
    expect(result).toEqual({ status: 'active', action: 'mark-active' });
    expect(setMock).toHaveBeenCalledWith({ status: 'active' });
    expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
    expect(clearCustomHost).not.toHaveBeenCalled();
  });

  it('verified + cert not yet Ready → provisioning, no mirror/regenerate', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result).toEqual({ status: 'provisioning', action: 'provision' });
    expect(setMock).toHaveBeenCalledWith({ status: 'provisioning' });
    expect(regeneratePublishedSiteFiles).not.toHaveBeenCalled();
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
  });

  it('provisioning + still issuing → stays provisioning', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result).toEqual({ status: 'provisioning', action: 'poll-again' });
    expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
  });

  it('provisioning + cert Ready → active, regenerates + re-mirrors', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });

    const result = await reconcileCustomDomainCert(domain('provisioning'));

    expect(result.status).toBe('active');
    expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
  });

  it('Fly error → cert_failed, clears the host prefix', async () => {
    addCertificate.mockResolvedValue({ ok: false, error: 'Fly API timeout' });

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result).toEqual({ status: 'cert_failed', action: 'mark-failed' });
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
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
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
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
  });

  it('does not throw when the fire-and-forget re-mirror rejects', async () => {
    addCertificate.mockResolvedValue({ ok: true, configured: true });
    mirrorDriveToCustomHost.mockRejectedValueOnce(new Error('mirror boom'));

    const result = await reconcileCustomDomainCert(domain('verified'));

    expect(result.status).toBe('active');
  });
});
