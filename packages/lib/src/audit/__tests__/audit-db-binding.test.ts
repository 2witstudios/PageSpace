/**
 * Audit DB binding tests (#890 Phase 2, leaf 5 — runtime cutover).
 *
 * resolveAuditDbBinding() is THE resolved-mode call site every default audit
 * read/write path hangs off:
 *   dedicated   → the Admin PG client (trust plane)
 *   break-glass → the MAIN db client — NOT the admin-schema-typed main-pool
 *                 client getAdminDb() returns, because the admin schema maps
 *                 emission_hash (admin migration 0005, admin plane only) and
 *                 the main-plane table has no such column: admin-shaped
 *                 SELECTs against the main DB would 42703.
 *   fail        → throws the actionable reason (fail-fast preserved)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAdminDb, mockMainDb, mockGetAdminDbMode, mockGetAdminDb } = vi.hoisted(() => ({
  mockAdminDb: { kind: 'admin-db' },
  mockMainDb: { kind: 'main-db' },
  mockGetAdminDbMode: vi.fn(),
  mockGetAdminDb: vi.fn(),
}));

vi.mock('@pagespace/db/admin-db', () => ({
  getAdminDb: mockGetAdminDb,
  getAdminDbMode: mockGetAdminDbMode,
}));
vi.mock('@pagespace/db/db', () => ({
  db: mockMainDb,
}));

import { resolveAuditDbBinding, resetAuditDbBindingForTests } from '../audit-db-binding';

describe('resolveAuditDbBinding()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditDbBindingForTests();
    mockGetAdminDb.mockReturnValue(mockAdminDb);
  });

  describe('dedicated mode', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'dedicated', reason: 'ADMIN_DATABASE_URL is set' });
    });

    it('given dedicated, should bind to the Admin PG client', () => {
      const binding = resolveAuditDbBinding();
      expect(binding.mode).toBe('dedicated');
      expect(binding.db).toBe(mockAdminDb);
    });

    it('should cache the binding — one mode resolution and one getAdminDb per process', () => {
      const first = resolveAuditDbBinding();
      const second = resolveAuditDbBinding();
      expect(second).toBe(first);
      expect(mockGetAdminDbMode).toHaveBeenCalledTimes(1);
      expect(mockGetAdminDb).toHaveBeenCalledTimes(1);
    });
  });

  describe('break-glass mode', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'break-glass', reason: 'flag armed' });
    });

    it('given break-glass, should bind to the MAIN db client (legacy path intact)', () => {
      const binding = resolveAuditDbBinding();
      expect(binding.mode).toBe('break-glass');
      expect(binding.db).toBe(mockMainDb);
    });

    it('given break-glass, should never touch getAdminDb — the admin-schema-typed main-pool client is shape-unsafe for main-plane reads', () => {
      resolveAuditDbBinding();
      expect(mockGetAdminDb).not.toHaveBeenCalled();
    });

    it('should carry the decision reason for observability at the bind point', () => {
      expect(resolveAuditDbBinding().reason).toBe('flag armed');
    });
  });

  describe('main-db mode (unconfigured trust plane — THE incident fix)', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'main-db', reason: 'main db default' });
    });

    it('given main-db, should bind to the MAIN db client (silent legacy path)', () => {
      const binding = resolveAuditDbBinding();
      expect(binding.mode).toBe('main-db');
      expect(binding.db).toBe(mockMainDb);
    });

    it('given main-db, should never touch getAdminDb — the admin-schema-typed main-pool client is shape-unsafe for main-plane reads', () => {
      resolveAuditDbBinding();
      expect(mockGetAdminDb).not.toHaveBeenCalled();
    });

    it('should carry the decision reason for the bind point', () => {
      expect(resolveAuditDbBinding().reason).toBe('main db default');
    });
  });

  describe('fail mode', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({
        mode: 'fail',
        reason: 'ADMIN_DATABASE_URL is not set. The Admin PG (trust plane) is required.',
      });
    });

    it('given fail, should throw the actionable reason', () => {
      expect(() => resolveAuditDbBinding()).toThrowError(/ADMIN_DATABASE_URL/);
    });

    it('should throw on every call — a failed resolution is never cached as a binding', () => {
      expect(() => resolveAuditDbBinding()).toThrow();
      expect(() => resolveAuditDbBinding()).toThrow();
      expect(mockGetAdminDbMode).toHaveBeenCalledTimes(2);
    });
  });

  it('resetAuditDbBindingForTests() clears the cache so mode changes are re-observed', () => {
    mockGetAdminDbMode.mockReturnValue({ mode: 'dedicated', reason: 'set' });
    expect(resolveAuditDbBinding().db).toBe(mockAdminDb);

    resetAuditDbBindingForTests();
    mockGetAdminDbMode.mockReturnValue({ mode: 'break-glass', reason: 'flag armed' });
    expect(resolveAuditDbBinding().db).toBe(mockMainDb);
  });
});
