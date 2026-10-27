/**
 * Sessions Schema Unit Tests
 *
 * Validates sessions table schema definition: columns, constraints,
 * relations, and indexes. Runs without a database connection.
 */
import { describe, it, expect } from 'vitest';
import { sessions, sessionsRelations } from '../schema/sessions';
import { getTableColumns } from 'drizzle-orm';

const columns = getTableColumns(sessions);

describe('Sessions Schema', () => {
  describe('table columns', () => {
    it('exports all expected columns', () => {
      const expectedColumns = [
        'id', 'tokenHash', 'tokenPrefix', 'userId',
        'type', 'scopes', 'resourceType', 'resourceId', 'driveId',
        'tokenVersion', 'adminRoleVersion', 'createdByService', 'createdByIp',
        'expiresAt', 'lastUsedAt', 'lastUsedIp', 'revokedAt', 'revokedReason',
        'createdAt',
      ];

      for (const col of expectedColumns) {
        expect(columns).toHaveProperty(col);
      }
    });

    it('has id as primary key with text type', () => {
      expect(columns.id.dataType).toBe('string');
      expect(columns.id.primary).toBe(true);
    });

    it('has tokenHash as unique and not null', () => {
      expect(columns.tokenHash.notNull).toBe(true);
      expect(columns.tokenHash.isUnique).toBe(true);
    });

    it('has tokenPrefix as not null', () => {
      expect(columns.tokenPrefix.notNull).toBe(true);
    });

    it('has userId as not null', () => {
      expect(columns.userId.notNull).toBe(true);
    });

    it('has type as not null text enum', () => {
      expect(columns.type.notNull).toBe(true);
      expect(columns.type.dataType).toBe('string');
    });

    it('has scopes as not null array', () => {
      expect(columns.scopes.notNull).toBe(true);
    });

    it('has tokenVersion as not null', () => {
      expect(columns.tokenVersion.notNull).toBe(true);
    });

    it('has expiresAt as not null', () => {
      expect(columns.expiresAt.notNull).toBe(true);
    });

    it('has optional resource binding columns (nullable)', () => {
      expect(columns.resourceType.notNull).toBe(false);
      expect(columns.resourceId.notNull).toBe(false);
      expect(columns.driveId.notNull).toBe(false);
    });

    it('has optional lifecycle columns (nullable)', () => {
      expect(columns.lastUsedAt.notNull).toBe(false);
      expect(columns.lastUsedIp.notNull).toBe(false);
      expect(columns.revokedAt.notNull).toBe(false);
      expect(columns.revokedReason.notNull).toBe(false);
    });

    it('has createdAt with default now', () => {
      expect(columns.createdAt.notNull).toBe(true);
      expect(columns.createdAt.hasDefault).toBe(true);
    });
  });

  describe('relations', () => {
    it('exports sessionsRelations', () => {
      expect(sessionsRelations).toBeDefined();
    });
  });
});
