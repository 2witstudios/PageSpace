/**
 * Store-targeting for Art 17 security-audit pseudonymization (#890 Phase 2,
 * leaf 6).
 *
 * Since the runtime cutover (leaf 5) a subject's security-audit PII can be
 * SPLIT across two stores: post-cutover rows live in the Admin PG
 * (trust plane), legacy rows remain in the main DB until the backfill leaf
 * plants them under the admin chain. Erasure is legally time-bound
 * (Art 17), so a pseudonymization run must cover BOTH stores now — and each
 * store is written by the identity that is allowed to touch it:
 *
 *   admin  → the eraser LOGIN (admin_gdpr_eraser_user: SELECT + column-scoped
 *            UPDATE on exactly the 6 PII columns) via ADMIN_ERASER_DATABASE_URL.
 *            Chain verification reads use the regular admin client.
 *   main   → the app's main-db connection (the legacy table has no role
 *            split; this is the pre-cutover behavior, unchanged).
 *
 * Refusal over partial success: in dedicated mode with no eraser configured,
 * the WHOLE erasure refuses with an actionable reason. Erasing only the main
 * store while post-cutover PII sits unreachable in the Admin PG would report
 * completion that did not happen. Under break-glass the entire audit surface
 * (reads + writes) is the main DB, so the plan collapses to main-only. In
 * fail mode there is no trust plane and no armed fallback — the erasure
 * refuses loudly (never a silent no-op) until the deploy is fixed.
 *
 * planSecurityAuditErasure is the pure core; resolveSecurityAuditErasureTargets
 * is the thin shell binding plans to live clients.
 */

import { db as mainDb } from '@pagespace/db/db';
import { getAdminDb, getAdminDbMode, type AdminDbModeName } from '@pagespace/db/admin-db';
import {
  getAdminEraserDb,
  getAdminEraserDbMode,
} from '@pagespace/db/admin-eraser-db';
import type { SecurityAuditDatabase } from '../../audit/security-audit-repository';

export type SecurityAuditErasureStore = 'admin' | 'main';

export interface SecurityAuditErasurePlanInput {
  auditMode: AdminDbModeName;
  eraserMode: 'available' | 'unavailable';
  auditReason?: string;
  eraserReason?: string;
}

export type SecurityAuditErasurePlan =
  | { ok: true; mode: 'dedicated' | 'break-glass'; stores: SecurityAuditErasureStore[] }
  | { ok: false; reason: string };

/** Pure: which stores an erasure run must touch, or why it must refuse. */
export function planSecurityAuditErasure(
  input: SecurityAuditErasurePlanInput,
): SecurityAuditErasurePlan {
  switch (input.auditMode) {
    case 'fail':
      return {
        ok: false,
        reason:
          `Audit store unavailable — refusing to pseudonymize (never a silent no-op): ` +
          `${input.auditReason ?? 'trust plane not configured'}`,
      };
    case 'break-glass':
      // The whole audit surface (writes AND reads) is the main DB; there are
      // no admin-store rows the eraser identity could reach.
      return { ok: true, mode: 'break-glass', stores: ['main'] };
    case 'dedicated':
      if (input.eraserMode === 'unavailable') {
        return {
          ok: false,
          reason:
            'Post-cutover audit PII lives in the Admin PG, which only the eraser identity may update — ' +
            'refusing a partial (main-only) erasure that would misreport completion. ' +
            `${input.eraserReason ?? 'ADMIN_ERASER_DATABASE_URL is not configured.'}`,
        };
      }
      // Dual-location: admin (post-cutover chained rows) AND main (legacy
      // rows awaiting backfill). Both must be pseudonymized in one run.
      return { ok: true, mode: 'dedicated', stores: ['admin', 'main'] };
  }
}

export interface SecurityAuditErasureTarget {
  store: SecurityAuditErasureStore;
  /** Connection the PII UPDATE runs on (eraser identity for admin; app identity for main). */
  write: SecurityAuditDatabase;
  /** Connection the before/after chain verification reads from. */
  read: SecurityAuditDatabase;
}

export type ResolvedSecurityAuditErasureTargets =
  | { ok: true; mode: 'dedicated' | 'break-glass'; targets: SecurityAuditErasureTarget[] }
  | { ok: false; reason: string };

/**
 * Shell: resolve the current process's erasure targets. Never constructs a
 * client for a store the plan does not include, and never falls back across
 * identities — an unavailable eraser refuses the run.
 */
export function resolveSecurityAuditErasureTargets(): ResolvedSecurityAuditErasureTargets {
  const auditDecision = getAdminDbMode();
  const eraserDecision = getAdminEraserDbMode();

  const plan = planSecurityAuditErasure({
    auditMode: auditDecision.mode,
    eraserMode: eraserDecision.mode,
    auditReason: auditDecision.reason,
    eraserReason: eraserDecision.reason,
  });
  if (!plan.ok) return plan;

  const targets = plan.stores.map((store): SecurityAuditErasureTarget => {
    if (store === 'admin') {
      return { store, write: getAdminEraserDb(), read: getAdminDb() };
    }
    // Main-plane rows: writes and chain-verification reads both use the main
    // db client (NOT getAdminDb()'s admin-schema-typed client — leaf 5 pin:
    // admin-shaped SELECTs would 42703 on emission_hash against main).
    return { store, write: mainDb, read: mainDb };
  });

  return { ok: true, mode: plan.mode, targets };
}
