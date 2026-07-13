/**
 * Machine Workspace Bootstraps Schema Unit Tests
 *
 * Validates the `machine_workspace_bootstraps` table — the one-row-per-machine
 * claim record for the workspace-history seeding race (#2048). Runs without a
 * database connection.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { machineWorkspaceBootstraps, machineWorkspaceBootstrapsRelations } from '../machine-workspace-bootstraps';

const columns = getTableColumns(machineWorkspaceBootstraps);

describe('Machine Workspace Bootstraps Schema', () => {
  describe('table columns', () => {
    it('exports all expected columns', () => {
      expect(columns).toHaveProperty('machineId');
      expect(columns).toHaveProperty('bootstrappedByUserId');
      expect(columns).toHaveProperty('bootstrappedAt');
    });

    it('has machineId as the primary key — one claim row per machine, ever', () => {
      expect(columns.machineId.primary).toBe(true);
      expect(columns.machineId.dataType).toBe('string');
    });

    it('has bootstrappedByUserId as not null (audit only)', () => {
      expect(columns.bootstrappedByUserId.notNull).toBe(true);
    });

    it('has bootstrappedAt with a default', () => {
      expect(columns.bootstrappedAt.notNull).toBe(true);
      expect(columns.bootstrappedAt.hasDefault).toBe(true);
    });
  });

  describe('foreign keys', () => {
    it('references pages and users, both cascading on delete', () => {
      const { foreignKeys } = getTableConfig(machineWorkspaceBootstraps);
      expect(foreignKeys).toHaveLength(2);
      for (const fk of foreignKeys) {
        expect(fk.onDelete).toBe('cascade');
      }
    });
  });

  describe('relations', () => {
    it('exports machineWorkspaceBootstrapsRelations', () => {
      expect(machineWorkspaceBootstrapsRelations).toBeDefined();
    });
  });
});
