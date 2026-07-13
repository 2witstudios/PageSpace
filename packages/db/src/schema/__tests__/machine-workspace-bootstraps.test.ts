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

    // Regression (CodeRabbit): nullable + `set null`, NOT `notNull` + cascade —
    // this row's mere EXISTENCE is the load-bearing invariant (it closes the
    // duplicate-bootstrap race), so deleting the winning user's account must
    // never cascade-delete the claim itself. See the schema file's doc comment.
    it('has bootstrappedByUserId as nullable (audit only, survives user deletion)', () => {
      expect(columns.bootstrappedByUserId.notNull).toBe(false);
    });

    it('has bootstrappedAt with a default', () => {
      expect(columns.bootstrappedAt.notNull).toBe(true);
      expect(columns.bootstrappedAt.hasDefault).toBe(true);
    });
  });

  describe('foreign keys', () => {
    it('cascades on machineId (page deletion) but only set-nulls on bootstrappedByUserId (user deletion)', () => {
      const { foreignKeys } = getTableConfig(machineWorkspaceBootstraps);
      expect(foreignKeys).toHaveLength(2);
      const byColumn = new Map(
        foreignKeys.map((fk) => [fk.reference().columns[0].name, fk.onDelete]),
      );
      expect(byColumn.get('machineId')).toBe('cascade');
      expect(byColumn.get('bootstrappedByUserId')).toBe('set null');
    });
  });

  describe('relations', () => {
    it('exports machineWorkspaceBootstrapsRelations', () => {
      expect(machineWorkspaceBootstrapsRelations).toBeDefined();
    });
  });
});
