import { describe, it, expect } from 'vitest';
import type { UserId } from '../../grant';
import { decideGoogleEnrollment } from '../google-enrollment';
import { planEnrolledMaterial } from '../plan-enrolled-material';
import { OAUTH_PROVIDER_ENDPOINTS } from '../../refresh/oauth-provider-endpoints';

const OWNER = 'owner' as UserId;
const base = { name: 'Agent Google', services: ['gmail.read', 'calendar'], ownership: 'dedicated' as const, acknowledged: false, autoApproveReads: false };

describe('decideGoogleEnrollment', () => {
  it('given services, should ask for the identity scopes plus one scope per service and pin exactly their API origins', () => {
    const actual = decideGoogleEnrollment({ input: base, approver: OWNER });
    expect(actual.ok && { origins: actual.draft.allowedOrigins, scopes: actual.draft.requestedScopes, policy: actual.draft.approvalPolicy, slug: actual.draft.providerSlug }).toEqual({
      origins: ['https://gmail.googleapis.com:443', 'https://www.googleapis.com:443'],
      scopes: ['email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.readonly', 'openid'],
      policy: null,
      slug: 'google',
    });
  });

  it('given "read without asking", should write a standing policy over the read class only, asking for unknown and irreversible operations', () => {
    const actual = decideGoogleEnrollment({ input: { ...base, autoApproveReads: true }, approver: OWNER });
    expect(actual.ok && { operations: actual.draft.approvalPolicy?.scope.operations, trigger: actual.draft.approvalPolicy?.trigger }).toEqual({ operations: [{ class: 'read', name: '*' }], trigger: 'unknown_and_irreversible' });
  });

  it('given no service, an unknown one, a personal login without acknowledgment or a blank name, should refuse', () => {
    const actual = [
      decideGoogleEnrollment({ input: { ...base, services: [] }, approver: OWNER }),
      decideGoogleEnrollment({ input: { ...base, services: ['gmail.read', 'youtube'] }, approver: OWNER }),
      decideGoogleEnrollment({ input: { ...base, ownership: 'personal' }, approver: OWNER }),
      decideGoogleEnrollment({ input: { ...base, name: '  ' }, approver: OWNER }),
    ];
    expect(actual).toEqual([{ ok: false, reason: 'services_empty' }, { ok: false, reason: 'service_unknown' }, { ok: false, reason: 'acknowledgment_required' }, { ok: false, reason: 'name_invalid' }]);
  });
});

const NOW = 1_800_000_000_000;
const CLIENT = 'client-123.apps.googleusercontent.com';
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const goodClaims = { iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 3600, email: 'agent@example.com', email_verified: true };
const response = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'ya29.access',
  refresh_token: '1//refresh',
  expires_in: 3599,
  token_type: 'Bearer',
  scope: 'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
  id_token: idToken(goodClaims),
  ...overrides,
});
const plan = (body: unknown) => planEnrolledMaterial({ body, endpoint: OAUTH_PROVIDER_ENDPOINTS.google!, clientId: CLIENT, requestedScopes: ['email', 'openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar'], now: NOW });

describe('planEnrolledMaterial', () => {
  it('given a complete Google response, should store the tokens against the PINNED endpoint and name the verified account', () => {
    const actual = plan(response());
    expect(actual).toEqual({
      ok: true,
      email: 'agent@example.com',
      material: {
        accessToken: 'ya29.access',
        accessExpiresAt: NOW + 3_599_000,
        refreshToken: '1//refresh',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email', 'openid'],
        issuer: 'https://accounts.google.com',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
      },
    });
  });

  it('given a scope nobody asked for, should not store it', () => {
    const actual = plan(response({ scope: 'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive' }));
    expect(actual.ok && actual.material.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly', 'openid']);
  });

  it('given no refresh token, no service the person kept ticked, or a malformed response, should refuse', () => {
    const actual = [plan(response({ refresh_token: undefined })), plan(response({ scope: 'openid email' })), plan(response({ expires_in: 0 })), plan(response({ token_type: 'mac' })), plan('not json')];
    expect(actual.map((verdict) => (verdict.ok ? 'ok' : verdict.reason))).toEqual(['no_refresh_token', 'no_service_granted', 'malformed', 'malformed', 'malformed']);
  });

  it('given an id token for another client, another issuer, an expired one or an unverified email, should refuse identity_invalid', () => {
    const actual = [
      plan(response({ id_token: idToken({ ...goodClaims, aud: 'someone-else' }) })),
      plan(response({ id_token: idToken({ ...goodClaims, iss: 'https://evil.example' }) })),
      plan(response({ id_token: idToken({ ...goodClaims, exp: NOW / 1000 - 1 }) })),
      plan(response({ id_token: idToken({ ...goodClaims, email_verified: false }) })),
      plan(response({ id_token: 'garbage' })),
    ];
    expect(actual.map((verdict) => (verdict.ok ? 'ok' : verdict.reason))).toEqual(['identity_invalid', 'identity_invalid', 'identity_invalid', 'identity_invalid', 'identity_invalid']);
  });
});
