/**
 * Machine Workspaces Schema Unit Tests
 *
 * Validates the `machine_workspaces` table definition: columns, constraints,
 * relations, and indexes. Runs without a database connection.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { machineWorkspaces, machineWorkspacesRelations } from '../machine-workspaces';

const columns = getTableColumns(machineWorkspaces);

describe('Machine Workspaces Schema', () => {
  describe('table columns', () => {
    it('exports all expected columns', () => {
      const expectedColumns = [
        'id', 'ownerId', 'machineId', 'scope', 'projectName', 'branchName',
        'name', 'layout', 'createdAt', 'updatedAt',
      ];
      for (const col of expectedColumns) {
        expect(columns).toHaveProperty(col);
      }
    });

    it('has id as a primary key, client-supplied (no default generator)', () => {
      expect(columns.id.dataType).toBe('string');
      expect(columns.id.primary).toBe(true);
      expect(columns.id.hasDefault).toBe(false);
    });

    it('has ownerId and machineId as not null', () => {
      expect(columns.ownerId.notNull).toBe(true);
      expect(columns.machineId.notNull).toBe(true);
    });

    it('has scope as a not null discriminant column', () => {
      expect(columns.scope.notNull).toBe(true);
      expect(columns.scope.dataType).toBe('string');
    });

    it('has projectName and branchName as nullable', () => {
      expect(columns.projectName.notNull).toBe(false);
      expect(columns.branchName.notNull).toBe(false);
    });

    it('has name as not null with no uniqueness constraint', () => {
      expect(columns.name.notNull).toBe(true);
      expect(columns.name.isUnique).toBeFalsy();
    });

    it('has layout as a not null jsonb column', () => {
      expect(columns.layout.notNull).toBe(true);
      expect(columns.layout.dataType).toBe('json');
    });

    it('has createdAt with a default and updatedAt not null', () => {
      expect(columns.createdAt.notNull).toBe(true);
      expect(columns.createdAt.hasDefault).toBe(true);
      expect(columns.updatedAt.notNull).toBe(true);
    });
  });

  describe('indexes', () => {
    it('has an index on machineId, and no name-uniqueness index', () => {
      const { indexes } = getTableConfig(machineWorkspaces);
      expect(indexes.some((index) => index.config.name === 'machine_workspaces_machine_id_idx')).toBe(true);
      expect(indexes.every((index) => !index.config.unique)).toBe(true);
    });
  });

  describe('relations', () => {
    it('exports machineWorkspacesRelations', () => {
      expect(machineWorkspacesRelations).toBeDefined();
    });
  });
});
