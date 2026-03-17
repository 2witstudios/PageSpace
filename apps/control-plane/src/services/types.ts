import type { TenantStatus } from '../validation/status-transitions'

export type Tenant = {
  id: string
  slug: string
  status: TenantStatus
  ownerEmail: string
}

export type TenantRepo = {
  getTenantBySlug(slug: string): Promise<Tenant | null>
  createTenant(input: { slug: string; name: string; ownerEmail: string; tier: string }): Promise<Tenant>
  updateTenantStatus(id: string, status: TenantStatus): Promise<Tenant>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}
