import type { ShellExecutor } from './shell-executor'

type UpgradeRepo = {
  listActiveTenants(): Promise<Array<{ id: string; slug: string; status: string }>>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}

export type UpgradeDeps = {
  repo: UpgradeRepo
  executor: ShellExecutor
  pollHealth: (slug: string) => Promise<{ healthy: boolean }>
  composePath: string
  basePath: string
}

type UpgradeOptions = {
  imageTag: string
  continueOnError?: boolean
  dryRun?: boolean
}

type TenantRef = { id: string; slug: string }

type UpgradeResult = {
  succeeded: TenantRef[]
  failed: Array<TenantRef & { error: string }>
  planned: TenantRef[]
}

const UPGRADE_ORDER = ['processor', 'web', 'realtime', 'cron'] as const

export function createUpgradeService(deps: UpgradeDeps) {
  const { repo, executor, pollHealth, composePath, basePath } = deps

  function composeCmd(slug: string, action: string): string {
    return `docker compose -p ps-${slug} -f ${composePath} --env-file ${basePath}/${slug}/.env ${action}`
  }

  async function upgradeTenant(tenant: TenantRef, imageTag: string): Promise<void> {
    const envOpts = { cwd: basePath, env: { IMAGE_TAG: imageTag } }

    // Pull new images
    const pullResult = await executor.exec(
      composeCmd(tenant.slug, `pull ${UPGRADE_ORDER.join(' ')}`),
      envOpts
    )
    if (pullResult.exitCode !== 0) {
      throw new Error(`Pull failed: ${pullResult.stderr}`)
    }

    // Run database migrations before recreating app containers
    const migrateResult = await executor.exec(
      composeCmd(tenant.slug, 'run --rm migrate'),
      envOpts
    )
    if (migrateResult.exitCode !== 0) {
      throw new Error(`Migration failed: ${migrateResult.stderr}`)
    }

    // Recreate services one at a time, health check after each
    for (const service of UPGRADE_ORDER) {
      const result = await executor.exec(
        composeCmd(tenant.slug, `up -d --no-deps ${service}`),
        envOpts
      )
      if (result.exitCode !== 0) {
        throw new Error(`Recreate ${service} failed: ${result.stderr}`)
      }
      const health = await pollHealth(tenant.slug)
      if (!health.healthy) {
        throw new Error(`Health check failed after recreating ${service}`)
      }
    }
  }

  return {
    async upgradeAll(options: UpgradeOptions): Promise<UpgradeResult> {
      const { imageTag, continueOnError = false, dryRun = false } = options
      const tenants = await repo.listActiveTenants()
      const refs = tenants.map(t => ({ id: t.id, slug: t.slug }))

      if (dryRun) {
        return { succeeded: [], failed: [], planned: refs }
      }

      const succeeded: TenantRef[] = []
      const failed: Array<TenantRef & { error: string }> = []

      for (const tenant of refs) {
        await repo.recordEvent(tenant.id, 'upgrade_started', { imageTag })

        try {
          await upgradeTenant(tenant, imageTag)
          await repo.recordEvent(tenant.id, 'upgrade_completed', { imageTag })
          succeeded.push(tenant)
        } catch (error) {
          const message = (error as Error).message
          await repo.recordEvent(tenant.id, 'upgrade_failed', { imageTag, error: message })
          failed.push({ ...tenant, error: message })

          if (!continueOnError) break
        }
      }

      return { succeeded, failed, planned: [] }
    },
  }
}
