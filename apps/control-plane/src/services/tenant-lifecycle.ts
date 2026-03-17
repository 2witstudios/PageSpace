import type { ShellExecutor, ExecOptions, ExecResult } from './shell-executor'
import type { Tenant, TenantRepo } from './types'
import { canTransition, type TenantStatus } from '../validation/status-transitions'
import { validateSlug } from '../validation/tenant-validation'

export type LifecycleDeps = {
  repo: TenantRepo
  executor: ShellExecutor
  pollHealth: (slug: string) => Promise<{ healthy: boolean }>
  composePath: string
  basePath: string
}

const APP_SERVICES = ['web', 'realtime', 'processor', 'cron']

export function createTenantLifecycle(deps: LifecycleDeps) {
  const { repo, executor, pollHealth, composePath, basePath } = deps

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

  function composeCmd(slug: string, action: string): string {
    return `docker compose -p ps-${slug} -f ${composePath} --env-file ${basePath}/${slug}/.env ${action}`
  }

  async function execOrFail(command: string, step: string, options?: ExecOptions): Promise<ExecResult> {
    const result = await executor.exec(command, options)
    if (result.exitCode !== 0) {
      throw new Error(`${step} failed (exit ${result.exitCode}): ${result.stderr}`)
    }
    return result
  }

  return {
    async suspend(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'suspended')

      const services = APP_SERVICES.join(' ')
      await execOrFail(
        composeCmd(slug, `stop ${services}`),
        'suspend',
        { cwd: basePath }
      )

      await repo.updateTenantStatus(tenant.id, 'suspended')
      await repo.recordEvent(tenant.id, 'suspended', { slug })
    },

    async resume(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'active')

      const services = APP_SERVICES.join(' ')
      await execOrFail(
        composeCmd(slug, `start ${services}`),
        'resume',
        { cwd: basePath }
      )

      await pollHealth(slug)
      await repo.updateTenantStatus(tenant.id, 'active')
      await repo.recordEvent(tenant.id, 'resumed', { slug })
    },

    async upgrade(slug: string, imageTag: string) {
      const tenant = await requireTenant(slug)

      await execOrFail(
        composeCmd(slug, 'pull web realtime processor cron'),
        'upgrade-pull',
        { cwd: basePath, env: { IMAGE_TAG: imageTag } }
      )

      for (const service of ['processor', 'web', 'realtime', 'cron']) {
        await execOrFail(
          composeCmd(slug, `up -d --no-deps ${service}`),
          `upgrade-recreate-${service}`,
          { cwd: basePath, env: { IMAGE_TAG: imageTag } }
        )
      }

      await repo.recordEvent(tenant.id, 'upgraded', { slug, imageTag })
    },

    async destroy(slug: string) {
      const tenant = await requireTenant(slug)
      requireTransition(tenant, 'destroying')

      await repo.updateTenantStatus(tenant.id, 'destroying')

      await execOrFail(
        `${composeCmd(slug, 'exec -T postgres pg_dump -U pagespace -d pagespace')} > ${basePath}/${slug}/backup.sql`,
        'backup',
        { cwd: basePath }
      )

      await execOrFail(
        composeCmd(slug, 'down --volumes'),
        'destroy',
        { cwd: basePath }
      )

      await repo.updateTenantStatus(tenant.id, 'destroyed')
      await repo.recordEvent(tenant.id, 'destroyed', { slug })
    },
  }
}
