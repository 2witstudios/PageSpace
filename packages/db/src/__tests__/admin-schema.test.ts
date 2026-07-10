/**
 * Admin PG schema barrel tests (#890 Phase 1, leaf 3).
 *
 * The barrel selects which tables belong to the trust plane. Contract:
 *   - EXACTLY securityAuditLog + siemDeliveryCursors + siemDeliveryReceipts
 *     + securityAuditIngest (Phase 2 emission queue, trust-plane only —
 *     analytics tables go to ClickHouse in Phase 3, activityLogs in Phase 5).
 *   - Single source of truth: the SIEM tables are the same objects as the
 *     main schema's; securityAuditLog shares one column/index definition via
 *     the defineSecurityAuditLogTable factory.
 *   - The admin instance carries NO cross-plane FK — `users` lives in the app
 *     plane only, and a cross-database FK is impossible. The main instance
 *     keeps its FK (dropping it there is Phase 2+).
 */
import { describe, it, expect } from 'vitest';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as adminSchema from '../admin-schema';
import { securityAuditLog as mainSecurityAuditLog } from '../schema/security-audit';
import {
  siemDeliveryCursors as mainSiemDeliveryCursors,
  siemDeliveryReceipts as mainSiemDeliveryReceipts,
} from '../schema/monitoring';
import type { AdminDatabase } from '../admin-db';

const exportedTables = Object.entries(adminSchema).filter(([, value]) =>
  is(value, PgTable),
);

describe('admin-schema barrel', () => {
  it('should export exactly the four trust-plane tables', () => {
    expect(exportedTables.map(([key]) => key).sort()).toEqual([
      'securityAuditIngest',
      'securityAuditLog',
      'siemDeliveryCursors',
      'siemDeliveryReceipts',
    ]);
  });

  it('should re-export the SIEM tables as the same objects as the main schema (no fork)', () => {
    expect(adminSchema.siemDeliveryCursors).toBe(mainSiemDeliveryCursors);
    expect(adminSchema.siemDeliveryReceipts).toBe(mainSiemDeliveryReceipts);
  });

  describe('securityAuditLog admin instance', () => {
    it('should target the same table name as the main instance', () => {
      expect(getTableName(adminSchema.securityAuditLog)).toBe(
        getTableName(mainSecurityAuditLog),
      );
      expect(getTableName(adminSchema.securityAuditLog)).toBe('security_audit_log');
    });

    it('should have the identical column set as the main instance (single source of truth)', () => {
      const adminColumns = getTableColumns(adminSchema.securityAuditLog);
      const mainColumns = getTableColumns(mainSecurityAuditLog);
      expect(Object.keys(adminColumns)).toEqual(Object.keys(mainColumns));
      for (const key of Object.keys(mainColumns)) {
        expect(adminColumns[key as keyof typeof adminColumns].name).toBe(
          mainColumns[key as keyof typeof mainColumns].name,
        );
        expect(adminColumns[key as keyof typeof adminColumns].columnType).toBe(
          mainColumns[key as keyof typeof mainColumns].columnType,
        );
      }
    });

    it('should have the identical index set as the main instance', () => {
      const indexNames = (table: typeof mainSecurityAuditLog) =>
        getTableConfig(table)
          .indexes.map((index) => index.config.name)
          .sort();
      expect(indexNames(adminSchema.securityAuditLog)).toEqual(
        indexNames(mainSecurityAuditLog),
      );
    });

    it('should carry NO foreign keys — the trust plane has no users table to reference', () => {
      expect(getTableConfig(adminSchema.securityAuditLog).foreignKeys).toHaveLength(0);
    });

    it('main instance keeps its users FK (dropping it from the app plane is Phase 2+)', () => {
      expect(getTableConfig(mainSecurityAuditLog).foreignKeys).toHaveLength(1);
    });
  });

  describe('securityAuditIngest (Phase 2 emission queue)', () => {
    it('should target security_audit_ingest and exist ONLY in the admin barrel (never the main schema)', async () => {
      expect(getTableName(adminSchema.securityAuditIngest)).toBe('security_audit_ingest');
      const mainSchema = await import('../schema');
      expect(Object.keys(mainSchema)).not.toContain('securityAuditIngest');
    });

    it('should carry no foreign keys and no chain columns (emission_hash/emitted_at instead)', () => {
      expect(getTableConfig(adminSchema.securityAuditIngest).foreignKeys).toHaveLength(0);
      const columns = getTableColumns(adminSchema.securityAuditIngest);
      expect(Object.keys(columns)).not.toContain('chainSeq');
      expect(Object.keys(columns)).not.toContain('previousHash');
      expect(Object.keys(columns)).not.toContain('eventHash');
      expect(columns.emissionHash.notNull).toBe(true);
      expect(columns.emittedAt.notNull).toBe(true);
    });

    it('should mirror security_audit_log event-column shapes exactly (encryption columns included)', () => {
      const ingestColumns = getTableColumns(adminSchema.securityAuditIngest);
      const chainColumns = getTableColumns(mainSecurityAuditLog);
      const eventColumnKeys = Object.keys(chainColumns).filter(
        (key) => !['chainSeq', 'previousHash', 'eventHash'].includes(key),
      );
      for (const key of eventColumnKeys) {
        const ingest = ingestColumns[key as keyof typeof ingestColumns];
        const chain = chainColumns[key as keyof typeof chainColumns];
        expect(ingest, `missing event column ${key}`).toBeDefined();
        expect(ingest.name).toBe(chain.name);
        expect(ingest.columnType).toBe(chain.columnType);
      }
    });
  });

  describe('SIEM tables carry no cross-plane FKs', () => {
    it('siemDeliveryCursors has no foreign keys', () => {
      expect(getTableConfig(adminSchema.siemDeliveryCursors).foreignKeys).toHaveLength(0);
    });

    it('siemDeliveryReceipts has no foreign keys', () => {
      expect(getTableConfig(adminSchema.siemDeliveryReceipts).foreignKeys).toHaveLength(0);
    });
  });

  describe('AdminDatabase type binding (compile-time)', () => {
    it('adminDb.query surface is exactly the admin barrel tables', () => {
      // Fails `bun run typecheck` if AdminDatabase is not bound to the barrel
      // (Record<string, never> ⇒ keyof query is never ⇒ excess properties) or
      // if the barrel gains/loses a table without this contract being updated.
      const querySurface: Record<keyof AdminDatabase['query'], true> = {
        securityAuditIngest: true,
        securityAuditLog: true,
        siemDeliveryCursors: true,
        siemDeliveryReceipts: true,
      };
      expect(Object.keys(querySurface)).toHaveLength(4);
    });
  });
});
