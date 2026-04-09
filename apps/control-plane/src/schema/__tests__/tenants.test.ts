import { describe, it, expect } from 'vitest'
import {
  tenants,
  tenantStatusEnum,
  healthStatusEnum,
} from '../tenants'
import { tenantEvents } from '../tenant-events'
import { tenantBackups, backupStatusEnum } from '../tenant-backups'
import { getTableColumns } from 'drizzle-orm'

describe('tenantStatusEnum', () => {
  it('should include all valid statuses', () => {
    expect(tenantStatusEnum.enumValues).toEqual([
      'provisioning',
      'active',
      'suspended',
      'destroying',
      'destroyed',
      'failed',
    ])
  })
})

describe('healthStatusEnum', () => {
  it('should include healthy, unhealthy, and unknown', () => {
    expect(healthStatusEnum.enumValues).toEqual([
      'healthy',
      'unhealthy',
      'unknown',
    ])
  })
})

describe('backupStatusEnum', () => {
  it('should include all valid backup statuses', () => {
    expect(backupStatusEnum.enumValues).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
    ])
  })
})

describe('tenants table', () => {
  /** @scaffold - suite-shape: verifying schema column presence */
  it('should have all required columns', () => {
    const columns = getTableColumns(tenants)
    const columnNames = Object.keys(columns)

    expect(columnNames).toContain('id')
    expect(columnNames).toContain('slug')
    expect(columnNames).toContain('name')
    expect(columnNames).toContain('status')
    expect(columnNames).toContain('tier')
    expect(columnNames).toContain('stripeCustomerId')
    expect(columnNames).toContain('stripeSubscriptionId')
    expect(columnNames).toContain('ownerEmail')
    expect(columnNames).toContain('dockerProject')
    expect(columnNames).toContain('encryptedSecrets')
    expect(columnNames).toContain('resourceLimits')
    expect(columnNames).toContain('createdAt')
    expect(columnNames).toContain('updatedAt')
    expect(columnNames).toContain('provisionedAt')
    expect(columnNames).toContain('lastHealthCheck')
    expect(columnNames).toContain('healthStatus')
  })

  it('should use text for id column (CUID2)', () => {
    const columns = getTableColumns(tenants)
    expect(columns.id.dataType).toBe('string')
    expect(columns.id.columnType).toBe('PgText')
  })

  it('should have slug as unique', () => {
    const columns = getTableColumns(tenants)
    expect(columns.slug.isUnique).toBe(true)
  })

  it('should default status to provisioning', () => {
    const columns = getTableColumns(tenants)
    expect(columns.status.hasDefault).toBe(true)
  })

  it('should default healthStatus to unknown', () => {
    const columns = getTableColumns(tenants)
    expect(columns.healthStatus.hasDefault).toBe(true)
  })
})

describe('tenantEvents table', () => {
  /** @scaffold - suite-shape: verifying schema column presence */
  it('should have all required columns', () => {
    const columns = getTableColumns(tenantEvents)
    const columnNames = Object.keys(columns)

    expect(columnNames).toContain('id')
    expect(columnNames).toContain('tenantId')
    expect(columnNames).toContain('eventType')
    expect(columnNames).toContain('metadata')
    expect(columnNames).toContain('createdAt')
  })

  it('should use text for id column (CUID2)', () => {
    const columns = getTableColumns(tenantEvents)
    expect(columns.id.dataType).toBe('string')
    expect(columns.id.columnType).toBe('PgText')
  })
})

describe('tenantBackups table', () => {
  /** @scaffold - suite-shape: verifying schema column presence */
  it('should have all required columns', () => {
    const columns = getTableColumns(tenantBackups)
    const columnNames = Object.keys(columns)

    expect(columnNames).toContain('id')
    expect(columnNames).toContain('tenantId')
    expect(columnNames).toContain('backupPath')
    expect(columnNames).toContain('sizeBytes')
    expect(columnNames).toContain('status')
    expect(columnNames).toContain('startedAt')
    expect(columnNames).toContain('completedAt')
  })

  it('should use text for id column (CUID2)', () => {
    const columns = getTableColumns(tenantBackups)
    expect(columns.id.dataType).toBe('string')
    expect(columns.id.columnType).toBe('PgText')
  })

  it('should default backup status to pending', () => {
    const columns = getTableColumns(tenantBackups)
    expect(columns.status.hasDefault).toBe(true)
  })
})
