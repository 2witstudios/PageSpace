import { eq, and, desc } from 'drizzle-orm'
import { tenants, tenantEvents } from '../schema'
import { canTransition, type TenantStatus } from '../validation/status-transitions'

type CreateTenantInput = {
  slug: string
  name: string
  ownerEmail: string
  tier: string
}

type ListTenantsOptions = {
  status?: TenantStatus
  tier?: string
  limit?: number
  offset?: number
}

// Minimal interface for the Drizzle db methods used by the repository.
// Keeps the factory testable with mock objects without importing full Drizzle types.
export interface TenantDb {
  select: (...args: unknown[]) => any
  insert: (...args: unknown[]) => any
  update: (...args: unknown[]) => any
  delete: (...args: unknown[]) => any
}

export function createTenantRepository(db: TenantDb) {
  return {
    async createTenant(input: CreateTenantInput) {
      const [tenant] = await db.insert(tenants).values({
        slug: input.slug,
        name: input.name,
        ownerEmail: input.ownerEmail,
        tier: input.tier,
      }).returning()
      return tenant
    },

    async getTenantBySlug(slug: string) {
      const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug))
      return tenant ?? null
    },

    async getTenantById(id: string) {
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id))
      return tenant ?? null
    },

    async listTenants(options: ListTenantsOptions = {}) {
      const { status, tier, limit = 50, offset = 0 } = options
      const conditions = []

      if (status) conditions.push(eq(tenants.status, status))
      if (tier) conditions.push(eq(tenants.tier, tier))

      let query = db.select().from(tenants)

      if (conditions.length > 0) {
        query = query.where(
          conditions.length === 1 ? conditions[0] : and(...conditions)
        )
      }

      return query.limit(limit).offset(offset)
    },

    async updateTenantStatus(id: string, newStatus: TenantStatus) {
      const [current] = await db.select().from(tenants).where(eq(tenants.id, id))
      if (!current) throw new Error('Tenant not found')

      if (!canTransition(current.status, newStatus)) {
        throw new Error(`Invalid transition: ${current.status} -> ${newStatus}`)
      }

      // Optimistic lock: only update if status hasn't changed since we read it
      const [updated] = await db.update(tenants).set({
        status: newStatus,
        updatedAt: new Date(),
      }).where(and(eq(tenants.id, id), eq(tenants.status, current.status))).returning()

      if (!updated) throw new Error('Concurrent status change detected')
      return updated
    },

    async updateHealthStatus(id: string, healthStatus: string) {
      const [updated] = await db.update(tenants).set({
        healthStatus,
        lastHealthCheck: new Date(),
      }).where(eq(tenants.id, id)).returning()
      if (!updated) throw new Error('Tenant not found')
      return updated
    },

    async deleteTenant(id: string) {
      await db.delete(tenants).where(eq(tenants.id, id))
    },

    async recordEvent(tenantId: string, eventType: string, metadata?: unknown) {
      await db.insert(tenantEvents).values({ tenantId, eventType, metadata })
    },

    async getRecentEvents(tenantId: string, limit = 50) {
      return db.select().from(tenantEvents)
        .where(eq(tenantEvents.tenantId, tenantId))
        .orderBy(desc(tenantEvents.createdAt))
        .limit(limit)
    },
  }
}
