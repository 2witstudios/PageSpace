import { describe, it, expect } from 'vitest';
import { ORG_API_ERROR_CODES } from '@pagespace/lib/organizations/api-error-codes';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { ORG_ERROR_COPY, orgErrorCode, orgErrorMessage } from '../org-error-copy';

describe('ORG_ERROR_COPY', () => {
  it('has user-facing copy for every code the org, wallet and policy routes answer', () => {
    for (const code of ORG_API_ERROR_CODES) {
      expect(ORG_ERROR_COPY[code], code).toEqual(expect.any(String));
      expect(ORG_ERROR_COPY[code].trim().length, code).toBeGreaterThan(0);
    }
  });

  it('has no entry beyond the registered codes', () => {
    expect(Object.keys(ORG_ERROR_COPY).sort()).toEqual([...ORG_API_ERROR_CODES].sort());
  });

  it('never prints a dollar sign (credits are counts, not money)', () => {
    for (const code of ORG_API_ERROR_CODES) {
      expect(ORG_ERROR_COPY[code], code).not.toContain('$');
    }
  });

  it('shows no machine code or snake_case jargon to the person', () => {
    for (const code of ORG_API_ERROR_CODES) {
      expect(ORG_ERROR_COPY[code], code).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

describe('orgErrorMessage', () => {
  const refusal = (code: unknown, error = 'raw server text') =>
    new ApiRequestError(error, 403, { error, code });

  it('maps a registered code to its copy, never the server message', () => {
    expect(orgErrorMessage(refusal('seats_full'), 'fallback')).toBe(ORG_ERROR_COPY.seats_full);
  });

  it("says an automation's owner is gone without claiming why, and who can act, for the owner-left refusals", () => {
    // owner_left also covers a deleted account and a drive guest who was never an org member.
    expect(ORG_ERROR_COPY.owner_left).not.toMatch(/left the organization/);
    // owner_present answers DELETE as well as reassign.
    expect(ORG_ERROR_COPY.owner_present).toMatch(/reassigned or deleted/);
    expect(orgErrorMessage(new ApiRequestError('raw', 409, { error: 'raw', code: 'owner_left' }), 'fallback')).toMatch(/owner is no longer here.*Owner or Admin must reassign or delete/);
    expect(orgErrorMessage(refusal('new_owner_no_drive_access'), 'fallback')).toMatch(/cannot reach this automation's drive/);
  });

  it('uses the fallback for an unknown code', () => {
    expect(orgErrorMessage(refusal('something_new'), 'Could not save')).toBe('Could not save');
  });

  it('uses the fallback for a body without a code (the dark-orgs 404)', () => {
    expect(orgErrorMessage(new ApiRequestError('Not found', 404, { error: 'Not found' }), 'Could not load')).toBe('Could not load');
  });

  it('uses the fallback for an error that is not an ApiRequestError', () => {
    expect(orgErrorMessage(new Error('network down'), 'Try again')).toBe('Try again');
    expect(orgErrorMessage('a string', 'Try again')).toBe('Try again');
    expect(orgErrorMessage(undefined, 'Try again')).toBe('Try again');
  });

  it('uses the fallback for a code that is an Object.prototype key, never a prototype value', () => {
    for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(orgErrorMessage(refusal(code), 'Try again'), code).toBe('Try again');
      expect(orgErrorCode(refusal(code)), code).toBeNull();
    }
  });

  it('uses the fallback when the body is not an object', () => {
    expect(orgErrorMessage(new ApiRequestError('oops', 500, 'text body'), 'Try again')).toBe('Try again');
  });
});

describe('orgErrorCode', () => {
  it('returns the registered code so a surface can branch on it', () => {
    expect(orgErrorCode(new ApiRequestError('x', 403, { error: 'x', code: 'org_lapsed' }))).toBe('org_lapsed');
  });

  it('returns null for an unregistered code or a non-API error', () => {
    expect(orgErrorCode(new ApiRequestError('x', 403, { error: 'x', code: 'nope' }))).toBeNull();
    expect(orgErrorCode(new Error('x'))).toBeNull();
  });
});
