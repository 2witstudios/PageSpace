/**
 * apps/web's Fly certificate wrapper, after the port off GraphQL.
 *
 * The previous version of this file asserted the shape of hand-written GraphQL
 * mutations against a stubbed global `fetch`. None of that survives the port:
 * the transport is now the shared flaps client, so what is worth asserting is
 * the BEHAVIOUR the callers depend on, which deliberately did not change —
 * `FlyCertResponse`, its `configured` boolean, idempotence, and degrading to
 * `ok: false` instead of throwing into a settings page.
 *
 * What is new, and is the reason for the port: `ownership` and `status` are
 * carried through, so a certificate stuck on an `_fly-ownership` TXT can be
 * told apart from one that is simply still validating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  getCertificateMock,
  requestAcmeCertificateMock,
  checkCertificateMock,
  deleteCertificateMock,
  StubFlapsError,
} = vi.hoisted(() => ({
  getCertificateMock: vi.fn(),
  requestAcmeCertificateMock: vi.fn(),
  checkCertificateMock: vi.fn(),
  deleteCertificateMock: vi.fn(),
  // Hoisted with the mocks: the module factory below references it, and a class
  // declared at file scope is still in its temporal dead zone when that runs.
  StubFlapsError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'FlapsError';
    }
  },
}));

vi.mock('@pagespace/lib/services/fly/flaps-client', () => ({
  FlapsError: StubFlapsError,
  getCertificate: getCertificateMock,
  requestAcmeCertificate: requestAcmeCertificateMock,
  checkCertificate: checkCertificateMock,
  deleteCertificate: deleteCertificateMock,
}));

import {
  addCertificate,
  ownershipRequirementOf,
  recheckCertificate,
  removeCertificate,
} from '../certs';

const APP_NAME = 'pagespace-proxy';
const HOSTNAME = 'docs.acme.com';

const ACTIVE = { hostname: HOSTNAME, status: 'active', configured: true };
const PENDING = {
  hostname: HOSTNAME,
  status: 'pending_validation',
  configured: false,
  dns_requirements: {
    ownership: { name: `_fly-ownership.${HOSTNAME}`, app_value: 'app-ABC', org_value: 'org-XYZ' },
  },
  validation: { ownership_txt_configured: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLY_API_TOKEN = 'fly-test-token';
});

afterEach(() => {
  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_MACHINES_ORG_TOKEN;
});

describe('addCertificate — reads before it writes', () => {
  it('given a hostname Fly already has, should return its state without requesting a new cert', async () => {
    getCertificateMock.mockResolvedValueOnce(ACTIVE);

    const result = await addCertificate(APP_NAME, HOSTNAME);

    expect(result).toEqual({
      ok: true,
      configured: true,
      status: 'active',
      ownership: null,
      ownershipTxtConfigured: false,
    });
    // The poll cycle this serves runs on every domains-list load; it must not be
    // a stream of mutations.
    expect(requestAcmeCertificateMock).not.toHaveBeenCalled();
  });

  it('given a hostname Fly has never seen, should request an ACME certificate', async () => {
    getCertificateMock.mockResolvedValueOnce(null);
    requestAcmeCertificateMock.mockResolvedValueOnce(PENDING);

    const result = await addCertificate(APP_NAME, HOSTNAME);

    expect(requestAcmeCertificateMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fly-test-token' }),
      APP_NAME,
      HOSTNAME,
    );
    expect(result).toMatchObject({ ok: true, configured: false, status: 'pending_validation' });
  });

  it('given a pending cert, should surface the ownership record the customer still owes', async () => {
    getCertificateMock.mockResolvedValueOnce(PENDING);

    const result = await addCertificate(APP_NAME, HOSTNAME);

    expect(result).toEqual({
      ok: true,
      configured: false,
      status: 'pending_validation',
      ownership: { name: `_fly-ownership.${HOSTNAME}`, appValue: 'app-ABC', orgValue: 'org-XYZ' },
      ownershipTxtConfigured: false,
    });
  });

  it('given Fly reports the ownership TXT as seen, should say so', async () => {
    getCertificateMock.mockResolvedValueOnce({
      ...PENDING,
      validation: { ownership_txt_configured: true },
    });

    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result).toMatchObject({ ok: true, ownershipTxtConfigured: true });
  });

  it('given a cert that is DNS-configured but not yet ISSUED, should not call it configured', async () => {
    // The distinction the old `clientStatus === 'Ready'` check drew, preserved
    // across the port: Fly's own `configured` boolean reflects DNS, and a
    // hostname can be correctly configured for minutes before a certificate
    // actually issues. Serving on the strength of it would mean serving without
    // TLS.
    getCertificateMock.mockResolvedValueOnce({
      hostname: HOSTNAME,
      status: 'pending_validation',
      configured: true,
    });
    expect(await addCertificate(APP_NAME, HOSTNAME)).toMatchObject({ ok: true, configured: false });
  });

  it('given a Fly failure, should degrade to ok:false rather than throw into the settings page', async () => {
    getCertificateMock.mockRejectedValueOnce(new StubFlapsError('Fly Machines API 403'));

    expect(await addCertificate(APP_NAME, HOSTNAME)).toEqual({
      ok: false,
      error: 'Fly Machines API 403',
    });
  });

  it('given a non-Error rejection, should still report an error response', async () => {
    getCertificateMock.mockRejectedValueOnce('something odd');
    expect(await addCertificate(APP_NAME, HOSTNAME)).toEqual({
      ok: false,
      error: 'Unknown Fly API error',
    });
  });
});

describe('the token is required before any request is attempted', () => {
  it('given no token at all, should report it without spending a request on a guaranteed 401', async () => {
    delete process.env.FLY_API_TOKEN;

    const result = await addCertificate(APP_NAME, HOSTNAME);

    expect(result).toEqual({ ok: false, error: 'FLY_API_TOKEN is not configured' });
    expect(getCertificateMock).not.toHaveBeenCalled();
  });

  it('given only FLY_MACHINES_ORG_TOKEN, should use it as the fallback credential', async () => {
    delete process.env.FLY_API_TOKEN;
    process.env.FLY_MACHINES_ORG_TOKEN = 'org-token';
    getCertificateMock.mockResolvedValueOnce(ACTIVE);

    await addCertificate(APP_NAME, HOSTNAME);

    expect(getCertificateMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'org-token' }),
      APP_NAME,
      HOSTNAME,
    );
  });
});

describe('recheckCertificate — the endpoint behind "Check SSL"', () => {
  it('given a hostname, should ask Fly to re-read its DNS', async () => {
    checkCertificateMock.mockResolvedValueOnce(ACTIVE);
    expect(await recheckCertificate(APP_NAME, HOSTNAME)).toMatchObject({ ok: true, configured: true });
    expect(checkCertificateMock).toHaveBeenCalledWith(expect.anything(), APP_NAME, HOSTNAME);
  });

  it('given Fly does not have the hostname, should report no certificate', async () => {
    checkCertificateMock.mockResolvedValueOnce(null);
    expect(await recheckCertificate(APP_NAME, HOSTNAME)).toEqual({
      ok: false,
      error: 'Fly did not return a certificate',
    });
  });
});

describe('removeCertificate — a hostname left attached bills forever', () => {
  it('given an attached hostname, should detach it', async () => {
    deleteCertificateMock.mockResolvedValueOnce(undefined);
    expect(await removeCertificate(APP_NAME, HOSTNAME)).toEqual({ ok: true });
  });

  it('given the delete fails, should report the failure rather than assume removal', async () => {
    deleteCertificateMock.mockRejectedValueOnce(new StubFlapsError('Fly Machines API 403'));
    expect(await removeCertificate(APP_NAME, HOSTNAME)).toEqual({
      ok: false,
      error: 'Fly Machines API 403',
    });
  });

  it('given no token, should report it', async () => {
    delete process.env.FLY_API_TOKEN;
    expect(await removeCertificate(APP_NAME, HOSTNAME)).toEqual({
      ok: false,
      error: 'FLY_API_TOKEN is not configured',
    });
  });
});

describe('ownershipRequirementOf — a half-populated requirement names nothing actionable', () => {
  it('given no ownership block, should return null', () => {
    expect(ownershipRequirementOf(ACTIVE)).toBeNull();
  });

  it('given a complete requirement, should normalize it', () => {
    expect(ownershipRequirementOf(PENDING)).toEqual({
      name: `_fly-ownership.${HOSTNAME}`,
      appValue: 'app-ABC',
      orgValue: 'org-XYZ',
    });
  });

  it('given only an org value, should still be actionable', () => {
    expect(
      ownershipRequirementOf({
        dns_requirements: { ownership: { name: 'n', org_value: 'org-XYZ' } },
      }),
    ).toEqual({ name: 'n', appValue: '', orgValue: 'org-XYZ' });
  });

  it.each([
    ['no name', { name: '', app_value: 'app-ABC' }],
    ['no values', { name: 'n' }],
  ])('given a requirement with %s, should return null rather than an instruction with blanks in it', (_l, ownership) => {
    expect(ownershipRequirementOf({ dns_requirements: { ownership } })).toBeNull();
  });
});
