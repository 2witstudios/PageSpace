import { describe, it, expect } from 'vitest';
import { isDriveWithinCredentialScope } from '../credential-scope';

/**
 * The pure credential drive-ceiling rule. It is small, and it is the answer to
 * one authorization question asked at seven call sites across two layers — which
 * is exactly why it is pinned here rather than only through its callers: the
 * defect it exists to prevent was one question answered in several places, with
 * one of them forgotten.
 */
describe('isDriveWithinCredentialScope', () => {
  describe('an UNSCOPED credential admits everything', () => {
    it('given an empty ceiling, admits any drive', () => {
      expect(isDriveWithinCredentialScope([], 'any-drive')).toBe(true);
    });

    it('given an empty ceiling, admits a resource with NO drive', () => {
      // A global-assistant workspace has no drive. An unscoped caller — a
      // session, or a full-account token — reaches it, which is the case this
      // whole epic set out to enable.
      expect(isDriveWithinCredentialScope([], null)).toBe(true);
    });

    it('treats an absent ceiling as unscoped', () => {
      // `mcpAllowedDriveIds` is optional on the tool context; undefined means
      // "no token scope", not "no drives".
      expect(isDriveWithinCredentialScope(undefined, 'any-drive')).toBe(true);
    });
  });

  describe('a SCOPED credential admits only its own drives', () => {
    it('admits a drive inside the ceiling', () => {
      expect(isDriveWithinCredentialScope(['a', 'b'], 'b')).toBe(true);
    });

    it('refuses a drive outside the ceiling', () => {
      expect(isDriveWithinCredentialScope(['a', 'b'], 'c')).toBe(false);
    });

    it('refuses a resource with NO drive — there is nothing for a drive-scope to have granted', () => {
      // The asymmetry with the unscoped case above is the point: a
      // global-assistant workspace is not "in" any drive, so a credential
      // defined as a set of drives can never have been given it.
      expect(isDriveWithinCredentialScope(['a'], null)).toBe(false);
    });

    it('FAILS CLOSED on an unresolvable drive', () => {
      // `undefined` reaches here when a workspace row could not be read. Unknown
      // is not a grant — a confined credential must not be given its benefit.
      expect(isDriveWithinCredentialScope(['a'], undefined)).toBe(false);
    });

    it('refuses an empty-string drive id, which matches no real drive', () => {
      expect(isDriveWithinCredentialScope(['a'], '')).toBe(false);
    });
  });
});
