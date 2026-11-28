import { describe, it, expect, vi } from 'vitest';

// The constant needs no lock; the module's lock import needs a db build this unit test should not.
vi.mock('@pagespace/db/advisory-lock', () => ({ withAdvisoryLock: vi.fn() }));

import { TENANT_UNIVERSAL_AUTH_CONFIG } from '../infisical-tenant-provisioner-client';

describe('TENANT_UNIVERSAL_AUTH_CONFIG', () => {
  it('given a plane that reaches Infisical over IPv6 (Fly 6PN) or IPv4, should trust both address families for login and tokens', () => {
    const actual = {
      clientSecret: TENANT_UNIVERSAL_AUTH_CONFIG.clientSecretTrustedIps.map((entry) => entry.ipAddress),
      accessToken: TENANT_UNIVERSAL_AUTH_CONFIG.accessTokenTrustedIps.map((entry) => entry.ipAddress),
    };
    expect(actual).toEqual({ clientSecret: ['0.0.0.0/0', '::/0'], accessToken: ['0.0.0.0/0', '::/0'] });
  });
});
