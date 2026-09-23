/**
 * Turning orgs on is mechanically blocked on the Phase 6 export work
 * (leaf yfmlkdchehmberwthwu6g7vt). B1 left TEMPORARY exclusions so org rows are
 * not yet exported: `organizations`, `org_members` and `drive_join_requests` in the GDPR export's
 * EXCLUDED_TABLES (Spec X-2) and `drives.orgId` in the tenant export's excluded
 * columns (Spec X-3). Shipping ORGS_ENABLED = true while any of those remain
 * would export org users' data without their org membership, and migrate an org
 * drive as a personal drive. This test fails in exactly that state.
 */
import { describe, it, expect } from 'vitest';
import { ORGS_ENABLED } from '../../packages/lib/src/organizations/orgs-enabled';
import { EXCLUDED_TABLES } from '../../packages/lib/src/compliance/export/gdpr-export-coverage';
import { TENANT_EXPORT_COLUMNS } from '../lib/tenant-export-columns';

interface ExportExclusions {
  gdprExcludedTables: Readonly<Record<string, string>>;
  tenantDriveExcludedColumns: Readonly<Record<string, string>>;
}

/** The temporary org exclusions still present; empty once Phase 6 has removed them. */
function temporaryOrgExclusions({ gdprExcludedTables, tenantDriveExcludedColumns }: ExportExclusions): string[] {
  const found: string[] = [];
  for (const table of ['organizations', 'org_members', 'drive_join_requests']) {
    const reason = gdprExcludedTables[table];
    if (reason !== undefined && /\bX-2\b/.test(reason) && /temporary/i.test(reason)) {
      found.push(`gdpr EXCLUDED_TABLES.${table}`);
    }
  }
  const orgIdReason = tenantDriveExcludedColumns.orgId;
  if (orgIdReason !== undefined && /\bX-3\b/.test(orgIdReason)) {
    found.push('tenant export drives.excluded.orgId');
  }
  return found;
}

const current: ExportExclusions = {
  gdprExcludedTables: EXCLUDED_TABLES,
  tenantDriveExcludedColumns: TENANT_EXPORT_COLUMNS.drives.excluded ?? {},
};

describe('ORGS_ENABLED export precondition', () => {
  it('X-2 (partial) ORGS_ENABLED cannot be true while org tables are excluded from GDPR export', () => {
    const blocking = temporaryOrgExclusions(current);
    expect(
      { orgsEnabled: ORGS_ENABLED, blocking: ORGS_ENABLED ? blocking : [] },
      `remove the temporary X-2/X-3 export exclusions (leaf yfmlkdchehmberwthwu6g7vt) before enabling orgs: ${blocking.join(', ')}`,
    ).toEqual({ orgsEnabled: ORGS_ENABLED, blocking: [] });
  });

  it('the detector flags each temporary exclusion shape and ignores permanent ones, so the guard is not vacuous', () => {
    expect(
      temporaryOrgExclusions({
        gdprExcludedTables: {
          organizations: 'Temporary under Spec X-2: removed by Phase 6.',
          org_members: 'Temporary under Spec X-2: removed by Phase 6.',
          org_invitations: 'Permanent Art 15(4) boundary.',
        },
        tenantDriveExcludedColumns: { orgId: 'Temporary under Spec X-3.' },
      }),
    ).toEqual([
      'gdpr EXCLUDED_TABLES.organizations',
      'gdpr EXCLUDED_TABLES.org_members',
      'tenant export drives.excluded.orgId',
    ]);
    expect(
      temporaryOrgExclusions({
        gdprExcludedTables: { org_invitations: 'Permanent Art 15(4) boundary.' },
        tenantDriveExcludedColumns: {},
      }),
    ).toEqual([]);
  });

  it('reads the real registries (B1 exclusions present until Phase 6)', () => {
    // Not asserting the list: Phase 6 empties it. Only that the registries resolve.
    expect(Array.isArray(temporaryOrgExclusions(current))).toBe(true);
  });
});
