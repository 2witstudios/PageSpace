/**
 * Unit tests for the pure restore-authorization decision (security finding H1).
 *
 * The IDOR fix hinges entirely on this decision: any authenticated user could
 * previously restore any trashed page in any drive. These tests pin the
 * decision exhaustively — by role and by MCP token scope — independently of the
 * route shell that resolves the facts.
 */
import { describe, it, expect } from 'vitest';
import { canRestorePage, type RestoreAuthFacts } from '../restore-authorization';

const facts = (overrides: Partial<RestoreAuthFacts> = {}): RestoreAuthFacts => ({
  canDelete: true,
  withinTokenScope: true,
  ...overrides,
});

describe('canRestorePage', () => {
  describe('role-based delete permission', () => {
    it('allows a caller with delete permission (owner/admin/editor)', () => {
      expect(canRestorePage(facts({ canDelete: true }))).toBe(true);
    });

    it('denies a caller without delete permission (viewer/non-member)', () => {
      expect(canRestorePage(facts({ canDelete: false }))).toBe(false);
    });
  });

  describe('MCP token scope', () => {
    it('denies an out-of-scope MCP token even when the user could delete', () => {
      expect(canRestorePage(facts({ canDelete: true, withinTokenScope: false }))).toBe(false);
    });

    it('allows an in-scope token with delete permission', () => {
      expect(canRestorePage(facts({ canDelete: true, withinTokenScope: true }))).toBe(true);
    });
  });

  describe('exhaustive fact matrix', () => {
    it.each([
      { canDelete: false, withinTokenScope: false, expected: false },
      { canDelete: false, withinTokenScope: true, expected: false },
      { canDelete: true, withinTokenScope: false, expected: false },
      { canDelete: true, withinTokenScope: true, expected: true },
    ])(
      'canDelete=$canDelete withinTokenScope=$withinTokenScope -> $expected',
      ({ canDelete, withinTokenScope, expected }) => {
        expect(canRestorePage({ canDelete, withinTokenScope })).toBe(expected);
      },
    );
  });
});
