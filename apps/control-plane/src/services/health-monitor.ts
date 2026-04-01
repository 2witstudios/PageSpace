export type HealthMonitorRepo = {
  listTenants(): Promise<Array<{ id: string; slug: string; status: string; healthStatus: string }>>
  updateHealthStatus(id: string, healthStatus: string): Promise<void>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}

export type HttpClient = {
  get(url: string, options?: { timeout?: number }): Promise<{ status: number }>
}

export type HealthMonitorDeps = {
  repo: HealthMonitorRepo
  httpClient: HttpClient
  onAlert: (alert: { tenantId: string; slug: string; consecutiveFailures: number }) => void | Promise<void>
  tenantUrl: (slug: string) => string
  consecutiveFailureThreshold?: number
}

type CheckResult = { tenantId: string; slug: string; healthy: boolean }

export function createHealthMonitor(deps: HealthMonitorDeps) {
  const {
    repo,
    httpClient,
    onAlert,
    tenantUrl,
    consecutiveFailureThreshold = 3,
  } = deps

  const failureCounts = new Map<string, number>()

  return {
    async checkAll(): Promise<CheckResult[]> {
      const tenants = await repo.listTenants()
      const active = tenants.filter(t => t.status === 'active')
      const results: CheckResult[] = []

      for (const tenant of active) {
        let healthy = false
        try {
          const response = await httpClient.get(
            `${tenantUrl(tenant.slug)}/api/health`,
            { timeout: 10_000 }
          )
          healthy = response.status === 200
        } catch {
          healthy = false
        }

        const previousHealth = tenant.healthStatus
        const newHealth = healthy ? 'healthy' : 'unhealthy'

        await repo.updateHealthStatus(tenant.id, newHealth)

        if (healthy) {
          if (previousHealth === 'unhealthy') {
            await repo.recordEvent(tenant.id, 'recovered', { slug: tenant.slug })
          }
          failureCounts.delete(tenant.id)
        } else {
          const count = (failureCounts.get(tenant.id) ?? 0) + 1
          failureCounts.set(tenant.id, count)

          if (count % consecutiveFailureThreshold === 0) {
            await onAlert({
              tenantId: tenant.id,
              slug: tenant.slug,
              consecutiveFailures: count,
            })
          }
        }

        results.push({ tenantId: tenant.id, slug: tenant.slug, healthy })
      }

      return results
    },

    getFailureCount(tenantId: string): number {
      return failureCounts.get(tenantId) ?? 0
    },
  }
}
