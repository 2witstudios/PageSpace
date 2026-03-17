import type { ShellExecutor } from './shell-executor'

type Tenant = {
  id: string
  slug: string
  status: string
}

type LifecycleRepo = {
  getTenantBySlug(slug: string): Promise<Tenant | null>
  updateTenantStatus(id: string, status: string): Promise<unknown>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}

export type LifecycleDeps = {
  repo: LifecycleRepo
  executor: ShellExecutor
  pollHealth: (slug: string) => Promise<{ healthy: boolean }>
  composePath: string
  basePath: string
}

const APP_SERVICES = ['web', 'realtime', 'processor', 'cron']

export function createTenantLifecycle(deps: LifecycleDeps) {
  const { repo, executor, pollHealth, composePath, basePath } = deps

  async function requireTenant(slug: string): Promise<Tenant> {
    const tenant = await repo.getTenantBySlug(slug)
    if (!tenant) throw new Error(`Tenant "${slug}" not found`)
    return tenant
  }

  function composeCmd(slug: string, action: string): string {
    return `docker compose -p ps-${slug} -f ${composePath} --env-file ${basePath}/${slug}/.env ${action}`
  }

  return {
    async suspend(slug: string) {
      const tenant = await requireTenant(slug)

      const services = APP_SERVICES.join(' ')
      await executor.exec(
        composeCmd(slug, `stop ${services}`),
        { cwd: basePath }
      )

      await repo.updateTenantStatus(tenant.id, 'suspended')
      await repo.recordEvent(tenant.id, 'suspended', { slug })
    },

    async resume(slug: string) {
      const tenant = await requireTenant(slug)

      const services = APP_SERVICES.join(' ')
      await executor.exec(
        composeCmd(slug, `start ${services}`),
        { cwd: basePath }
      )

      await pollHealth(slug)
      await repo.updateTenantStatus(tenant.id, 'active')
      await repo.recordEvent(tenant.id, 'resumed', { slug })
    },

    async upgrade(slug: string, imageTag: string) {
      const tenant = await requireTenant(slug)

      // Pull new images
      await executor.exec(
        composeCmd(slug, 'pull web realtime processor'),
        { cwd: basePath, env: { IMAGE_TAG: imageTag } }
      )

      // Rolling recreate: one service at a time
      for (const service of ['processor', 'web', 'realtime']) {
        await executor.exec(
          composeCmd(slug, `up -d --no-deps ${service}`),
          { cwd: basePath, env: { IMAGE_TAG: imageTag } }
        )
      }

      await repo.recordEvent(tenant.id, 'upgraded', { slug, imageTag })
    },

    async destroy(slug: string) {
      const tenant = await requireTenant(slug)

      // Transition to destroying
      await repo.updateTenantStatus(tenant.id, 'destroying')

      // Backup database first
      await executor.exec(
        `docker compose -p ps-${slug} exec -T postgres pg_dump -U postgres > ${basePath}/${slug}/backup.sql`,
        { cwd: basePath }
      )

      // Stop all containers and remove volumes
      await executor.exec(
        composeCmd(slug, 'down --volumes'),
        { cwd: basePath }
      )

      // Transition to destroyed
      await repo.updateTenantStatus(tenant.id, 'destroyed')
      await repo.recordEvent(tenant.id, 'destroyed', { slug })
    },
  }
}
