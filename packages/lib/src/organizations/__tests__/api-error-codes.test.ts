import { describe, it, expect } from 'vitest';
import { ORG_API_ERROR_CODES, isOrgApiErrorCode } from '../api-error-codes';

describe('the org, wallet, seat and policy routes\' error codes', () => {
  it('UI-7 (partial) every code is listed once, in snake_case, so the UI can map each one to copy', () => {
    expect(new Set(ORG_API_ERROR_CODES).size).toBe(ORG_API_ERROR_CODES.length);
    for (const code of ORG_API_ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('billing being off has its own code; organizations being dark has none (a bare 404)', () => {
    expect(isOrgApiErrorCode('billing_unavailable')).toBe(true);
    expect(isOrgApiErrorCode('orgs_disabled')).toBe(false);
    expect(isOrgApiErrorCode(undefined)).toBe(false);
  });
});
