import type { Tenant, TenantRepo } from './types'
import type { TenantInfraProvider } from '../providers/types'
import { canTransition, type TenantStatus } from '../validation/status-transitions'
import { validateSlug } from '../validation/tenant-validation'

export type LifecycleDeps = {
  repo: TenantRepo
  provider: TenantInfraProvider
}

export function createTenantLifecycle(deps: LifecycleDeps) {
  const { repo, provider } = deps

  async function requireTenant(slug: string): Promise<Tenant> {
    const slugResult = validateSlug(slug)
    if (!slugResult.valid) {
      throw new Error(`Invalid slug: "${slug}"`)
    }
    const tenant = await repo.getTenantBySlug(slug)
    if (!tenant) throw new Error(`Tenant "${slug}" not found`)
    return tenant
  }

  function requireTransition(tenant: Tenant, to: TenantStatus) {
    if (!canTransition(tenant.status, to)) {
      throw new Error(`Cannot transition from ${tenant.status} to ${to}`)
    }
  }

  return {
    async suspend(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'suspended')

      await provider.suspend(slug)

      await repo.updateTenantStatus(tenant.id, 'suspended')
      await repo.recordEvent(tenant.id, 'suspended', { slug })
    },

    async resume(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'active')

      await provider.resume(slug)

      const healthResult = await provider.healthCheck(slug)
      if (!healthResult.healthy) {
        throw new Error(`Resume failed: services not healthy after starting`)
      }
      await repo.updateTenantStatus(tenant.id, 'active')
      await repo.recordEvent(tenant.id, 'resumed', { slug })
    },

    async upgrade(slug: string, imageTag: string) {
      const tenant = await requireTenant(slug)

      await provider.upgrade(slug, imageTag)

      await repo.recordEvent(tenant.id, 'upgraded', { slug, imageTag })
    },

    async destroy(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'destroying')

      await repo.updateTenantStatus(tenant.id, 'destroying')

      await provider.destroy(slug, { backup: true })

      await repo.updateTenantStatus(tenant.id, 'destroyed')
      await repo.recordEvent(tenant.id, 'destroyed', { slug })
    },
  }
}
