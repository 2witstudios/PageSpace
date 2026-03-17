import { describe, test, expect, vi } from 'vitest'
import { createTenantRepository } from '../tenant-repository'

// Factory for tenant test data
function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-id-123',
    slug: 'test-tenant',
    name: 'Test Tenant',
    status: 'provisioning' as const,
    tier: 'pro',
    ownerEmail: 'owner@test.com',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    dockerProject: null,
    encryptedSecrets: null,
    resourceLimits: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    provisionedAt: null,
    lastHealthCheck: null,
    healthStatus: 'unknown' as const,
    ...overrides,
  }
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-id-1',
    tenantId: 'test-id-123',
    eventType: 'provisioned',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  }
}

// Creates a chainable mock that mimics Drizzle's builder pattern.
// Uses a real Promise as the base so the chain is natively thenable.
function createChainMock(resolvedValue: unknown[] = []) {
  const promise = Promise.resolve(resolvedValue)
  const chain: Record<string, unknown> = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  }
  for (const method of ['from', 'where', 'set', 'values', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }
  chain.returning = vi.fn().mockResolvedValue(resolvedValue)
  return chain
}

function createMockDb(resolvedValue: unknown[] = []) {
  const chain = createChainMock(resolvedValue)
  return {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    _chain: chain,
  }
}

describe('createTenantRepository', () => {
  describe('createTenant', () => {
    test('given valid tenant data, should return tenant with status provisioning', async () => {
      const expected = makeTenant()
      const db = createMockDb([expected])
      const repo = createTenantRepository(db as never)

      const result = await repo.createTenant({
        slug: 'test-tenant',
        name: 'Test Tenant',
        ownerEmail: 'owner@test.com',
        tier: 'pro',
      })

      expect(result).toEqual(expected)
      expect(result.status).toBe('provisioning')
    })

    test('given valid tenant data, should call db.insert', async () => {
      const expected = makeTenant()
      const db = createMockDb([expected])
      const repo = createTenantRepository(db as never)

      await repo.createTenant({
        slug: 'test-tenant',
        name: 'Test Tenant',
        ownerEmail: 'owner@test.com',
        tier: 'pro',
      })

      expect(db.insert).toHaveBeenCalled()
      expect(db._chain.values).toHaveBeenCalled()
      expect(db._chain.returning).toHaveBeenCalled()
    })
  })

  describe('getTenantBySlug', () => {
    test('given an existing slug, should return the tenant', async () => {
      const expected = makeTenant({ slug: 'acme' })
      const db = createMockDb([expected])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantBySlug('acme')

      expect(result).toEqual(expected)
    })

    test('given a nonexistent slug, should return null', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantBySlug('ghost')

      expect(result).toBeNull()
    })
  })

  describe('getTenantById', () => {
    test('given an existing id, should return the tenant', async () => {
      const expected = makeTenant({ id: 'abc-123' })
      const db = createMockDb([expected])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantById('abc-123')

      expect(result).toEqual(expected)
    })

    test('given a nonexistent id, should return null', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantById('missing')

      expect(result).toBeNull()
    })
  })

  describe('listTenants', () => {
    test('given no filters, should call db.select and return tenants', async () => {
      const tenants = [makeTenant({ slug: 'one' }), makeTenant({ slug: 'two' })]
      const db = createMockDb(tenants)
      const repo = createTenantRepository(db as never)

      const result = await repo.listTenants()

      expect(result).toEqual(tenants)
      expect(db.select).toHaveBeenCalled()
    })

    test('given status filter, should call where on the chain', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await repo.listTenants({ status: 'active' })

      expect(db._chain.where).toHaveBeenCalled()
    })

    test('given tier filter, should call where on the chain', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await repo.listTenants({ tier: 'enterprise' })

      expect(db._chain.where).toHaveBeenCalled()
    })

    test('given limit and offset, should apply pagination', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await repo.listTenants({ limit: 10, offset: 20 })

      expect(db._chain.limit).toHaveBeenCalledWith(10)
      expect(db._chain.offset).toHaveBeenCalledWith(20)
    })
  })

  describe('updateTenantStatus', () => {
    test('given a valid transition (provisioning -> active), should return updated tenant', async () => {
      const current = makeTenant({ status: 'provisioning' })
      const updated = makeTenant({ status: 'active' })

      const selectChain = createChainMock([current])
      const updateChain = createChainMock([updated])
      const db = {
        select: vi.fn().mockReturnValue(selectChain),
        update: vi.fn().mockReturnValue(updateChain),
        insert: vi.fn(),
        delete: vi.fn(),
      }
      const repo = createTenantRepository(db as never)

      const result = await repo.updateTenantStatus('test-id-123', 'active')

      expect(result.status).toBe('active')
      expect(db.update).toHaveBeenCalled()
    })

    test('given an invalid transition (destroyed -> active), should throw', async () => {
      const current = makeTenant({ status: 'destroyed' })
      const selectChain = createChainMock([current])
      const db = {
        select: vi.fn().mockReturnValue(selectChain),
        update: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
      }
      const repo = createTenantRepository(db as never)

      await expect(repo.updateTenantStatus('test-id-123', 'active'))
        .rejects.toThrow('Invalid transition')
    })

    test('given a nonexistent tenant, should throw', async () => {
      const selectChain = createChainMock([])
      const db = {
        select: vi.fn().mockReturnValue(selectChain),
        update: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
      }
      const repo = createTenantRepository(db as never)

      await expect(repo.updateTenantStatus('missing', 'active'))
        .rejects.toThrow('Tenant not found')
    })
  })

  describe('updateHealthStatus', () => {
    test('given a valid health status, should return updated tenant', async () => {
      const updated = makeTenant({ healthStatus: 'healthy', lastHealthCheck: new Date() })
      const db = createMockDb([updated])
      const repo = createTenantRepository(db as never)

      const result = await repo.updateHealthStatus('test-id-123', 'healthy')

      expect(result.healthStatus).toBe('healthy')
      expect(db.update).toHaveBeenCalled()
    })

    test('given a health update, should set lastHealthCheck', async () => {
      const db = createMockDb([makeTenant()])
      const repo = createTenantRepository(db as never)

      await repo.updateHealthStatus('test-id-123', 'unhealthy')

      expect(db._chain.set).toHaveBeenCalled()
      const setArg = (db._chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(setArg).toHaveProperty('healthStatus', 'unhealthy')
      expect(setArg).toHaveProperty('lastHealthCheck')
    })

    test('given a nonexistent tenant, should throw', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await expect(repo.updateHealthStatus('missing', 'healthy'))
        .rejects.toThrow('Tenant not found')
    })
  })

  describe('deleteTenant', () => {
    test('given a tenant id, should call db.delete', async () => {
      const db = createMockDb()
      const repo = createTenantRepository(db as never)

      await repo.deleteTenant('test-id-123')

      expect(db.delete).toHaveBeenCalled()
      expect(db._chain.where).toHaveBeenCalled()
    })
  })

  describe('recordEvent', () => {
    test('given event data, should call db.insert', async () => {
      const db = createMockDb()
      const repo = createTenantRepository(db as never)

      await repo.recordEvent('test-id-123', 'provisioned', { duration: 30 })

      expect(db.insert).toHaveBeenCalled()
      expect(db._chain.values).toHaveBeenCalled()
    })

    test('given event data, should pass correct tenantId and eventType', async () => {
      const db = createMockDb()
      const repo = createTenantRepository(db as never)

      await repo.recordEvent('tenant-abc', 'status_changed', { from: 'active', to: 'suspended' })

      const valuesArg = (db._chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(valuesArg).toMatchObject({
        tenantId: 'tenant-abc',
        eventType: 'status_changed',
      })
    })
  })

  describe('getRecentEvents', () => {
    test('given a tenant id, should return events ordered by createdAt desc', async () => {
      const events = [
        makeEvent({ eventType: 'latest' }),
        makeEvent({ eventType: 'older' }),
      ]
      const db = createMockDb(events)
      const repo = createTenantRepository(db as never)

      const result = await repo.getRecentEvents('test-id-123')

      expect(result).toEqual(events)
      expect(db.select).toHaveBeenCalled()
      expect(db._chain.orderBy).toHaveBeenCalled()
    })

    test('given a limit, should apply it to the query', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await repo.getRecentEvents('test-id-123', 5)

      expect(db._chain.limit).toHaveBeenCalledWith(5)
    })

    test('given no limit, should default to 50', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await repo.getRecentEvents('test-id-123')

      expect(db._chain.limit).toHaveBeenCalledWith(50)
    })
  })

  describe('getTenantByStripeSubscription', () => {
    test('given an existing subscription id, should return the tenant', async () => {
      const expected = makeTenant({ stripeSubscriptionId: 'sub_abc123' })
      const db = createMockDb([expected])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantByStripeSubscription('sub_abc123')

      expect(result).toEqual(expected)
      expect(db.select).toHaveBeenCalled()
      expect(db._chain.where).toHaveBeenCalled()
    })

    test('given a nonexistent subscription id, should return null', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      const result = await repo.getTenantByStripeSubscription('sub_missing')

      expect(result).toBeNull()
    })
  })

  describe('updateTenantStripeIds', () => {
    test('given valid ids, should return updated tenant', async () => {
      const updated = makeTenant({ stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_new' })
      const db = createMockDb([updated])
      const repo = createTenantRepository(db as never)

      const result = await repo.updateTenantStripeIds('test-id-123', 'cus_new', 'sub_new')

      expect(result).toEqual(updated)
      expect(db.update).toHaveBeenCalled()
    })

    test('given valid ids, should pass correct fields to db.update.set', async () => {
      const db = createMockDb([makeTenant()])
      const repo = createTenantRepository(db as never)

      await repo.updateTenantStripeIds('test-id-123', 'cus_abc', 'sub_abc')

      expect(db._chain.set).toHaveBeenCalled()
      const setArg = (db._chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(setArg).toMatchObject({
        stripeCustomerId: 'cus_abc',
        stripeSubscriptionId: 'sub_abc',
      })
      expect(setArg).toHaveProperty('updatedAt')
    })

    test('given nonexistent tenant, should throw', async () => {
      const db = createMockDb([])
      const repo = createTenantRepository(db as never)

      await expect(repo.updateTenantStripeIds('missing', 'cus_x', 'sub_x'))
        .rejects.toThrow('Tenant not found')
    })
  })
})
