/**
 * Store-targeting for Art 17 security-audit pseudonymization (#890 Phase 2,
 * leaf 6). Pure plan: which store(s) hold the subject's audit PII and which
 * identity may erase there — plus the shell that binds plans to clients.
 *
 * Transitional dual-location state (leaf 5 cutover): NEW rows live in the
 * Admin PG, LEGACY rows remain in the main DB until the backfill leaf plants
 * them. Erasure is legally time-bound, so it must cover BOTH stores NOW —
 * a partial erasure that reports success is worse than a loud refusal.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { __store: 'main' } }));
vi.mock('@pagespace/db/admin-db', () => ({
  getAdminDbMode: vi.fn(),
  getAdminDb: vi.fn(() => ({ __store: 'admin-read' })),
}));
vi.mock('@pagespace/db/admin-eraser-db', () => ({
  getAdminEraserDbMode: vi.fn(),
  getAdminEraserDb: vi.fn(() => ({ __store: 'admin-eraser' })),
}));

import {
  planSecurityAuditErasure,
  resolveSecurityAuditErasureTargets,
} from '../pseudonymize-targets';
import { getAdminDbMode, getAdminDb } from '@pagespace/db/admin-db';
import { getAdminEraserDbMode, getAdminEraserDb } from '@pagespace/db/admin-eraser-db';

describe('planSecurityAuditErasure (pure)', () => {
  it('given dedicated mode with the eraser configured, should target BOTH stores (admin post-cutover rows + main legacy rows)', () => {
    const plan = planSecurityAuditErasure({
      auditMode: 'dedicated',
      eraserMode: 'available',
    });
    expect(plan).toEqual({ ok: true, mode: 'dedicated', stores: ['admin', 'main'] });
  });

  it('given dedicated mode WITHOUT the eraser, should refuse the whole erasure with an actionable reason — never a partial run', () => {
    const plan = planSecurityAuditErasure({
      auditMode: 'dedicated',
      eraserMode: 'unavailable',
      eraserReason: 'ADMIN_ERASER_DATABASE_URL is not set. …',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('ADMIN_ERASER_DATABASE_URL is not set');
      // Must explain WHY main-only would be wrong (post-cutover PII lives in the Admin PG).
      expect(plan.reason).toMatch(/Admin PG/);
      expect(plan.reason).toMatch(/partial/i);
    }
  });

  it('given break-glass mode, should target only the main store (the entire audit surface lives there)', () => {
    const plan = planSecurityAuditErasure({
      auditMode: 'break-glass',
      eraserMode: 'unavailable',
    });
    expect(plan).toEqual({ ok: true, mode: 'break-glass', stores: ['main'] });
  });

  it('given main-db mode (unconfigured default), should target only the main store like break-glass', () => {
    const plan = planSecurityAuditErasure({
      auditMode: 'main-db',
      eraserMode: 'unavailable',
    });
    expect(plan).toEqual({ ok: true, mode: 'main-db', stores: ['main'] });
  });

  it('given fail mode, should refuse loudly with the audit reason — a misconfigured trust plane never silently no-ops an erasure', () => {
    const plan = planSecurityAuditErasure({
      auditMode: 'fail',
      eraserMode: 'available',
      auditReason: 'ADMIN_DATABASE_URL is not set. …',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('ADMIN_DATABASE_URL is not set');
    }
  });
});

describe('resolveSecurityAuditErasureTargets (shell)', () => {
  it('given dedicated + eraser, should bind admin writes to the ERASER client, admin reads to the admin client, and main to the main db', () => {
    vi.mocked(getAdminDbMode).mockReturnValue({ mode: 'dedicated', reason: 'set' });
    vi.mocked(getAdminEraserDbMode).mockReturnValue({ mode: 'available', reason: 'set' });

    const resolved = resolveSecurityAuditErasureTargets();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.mode).toBe('dedicated');
      expect(resolved.targets.map((t) => t.store)).toEqual(['admin', 'main']);
      expect(resolved.targets[0]!.write).toEqual({ __store: 'admin-eraser' });
      expect(resolved.targets[0]!.read).toEqual({ __store: 'admin-read' });
      expect(resolved.targets[1]!.write).toEqual({ __store: 'main' });
      expect(resolved.targets[1]!.read).toEqual({ __store: 'main' });
    }
  });

  it('given break-glass, should bind the single main target WITHOUT touching any admin client', () => {
    vi.mocked(getAdminDbMode).mockReturnValue({ mode: 'break-glass', reason: 'armed' });
    vi.mocked(getAdminEraserDbMode).mockReturnValue({ mode: 'unavailable', reason: 'unset' });
    vi.mocked(getAdminDb).mockClear();
    vi.mocked(getAdminEraserDb).mockClear();

    const resolved = resolveSecurityAuditErasureTargets();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.mode).toBe('break-glass');
      expect(resolved.targets.map((t) => t.store)).toEqual(['main']);
      expect(resolved.targets[0]!.write).toEqual({ __store: 'main' });
    }
    expect(getAdminDb).not.toHaveBeenCalled();
    expect(getAdminEraserDb).not.toHaveBeenCalled();
  });

  it('given a refusing plan, should return it without constructing any client', () => {
    vi.mocked(getAdminDbMode).mockReturnValue({ mode: 'fail', reason: 'no trust plane' });
    vi.mocked(getAdminEraserDbMode).mockReturnValue({ mode: 'unavailable', reason: 'unset' });
    vi.mocked(getAdminEraserDb).mockClear();

    const resolved = resolveSecurityAuditErasureTargets();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain('no trust plane');
    }
    expect(getAdminEraserDb).not.toHaveBeenCalled();
  });
});
