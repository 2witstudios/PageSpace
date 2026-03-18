import { describe, test, expect, vi } from 'vitest'
import { createHealthMonitor, type HealthMonitorDeps } from '../health-monitor'

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-1',
    slug: 'acme',
    status: 'active' as string,
    healthStatus: 'healthy' as string,
    ...overrides,
  }
}

function makeMockRepo() {
  return {
    listTenants: vi.fn().mockResolvedValue([makeTenant()]),
    updateHealthStatus: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockHttpClient() {
  return {
    get: vi.fn().mockResolvedValue({ status: 200 }),
  }
}

function makeDeps(overrides: Partial<HealthMonitorDeps> = {}): HealthMonitorDeps {
  return {
    repo: makeMockRepo(),
    httpClient: makeMockHttpClient(),
    onAlert: vi.fn(),
    tenantUrl: (slug: string) => `https://${slug}.pagespace.ai`,
    consecutiveFailureThreshold: 3,
    ...overrides,
  }
}

describe('HealthMonitor', () => {
  describe('checkAll', () => {
    test('given 3 active tenants, should make 3 health check requests', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
        makeTenant({ id: 't3', slug: 'gamma' }),
      ])
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.httpClient.get).toHaveBeenCalledTimes(3)
      expect(deps.httpClient.get).toHaveBeenCalledWith(
        'https://alpha.pagespace.ai/api/health',
        expect.objectContaining({ timeout: expect.any(Number) })
      )
      expect(deps.httpClient.get).toHaveBeenCalledWith(
        'https://beta.pagespace.ai/api/health',
        expect.objectContaining({ timeout: expect.any(Number) })
      )
      expect(deps.httpClient.get).toHaveBeenCalledWith(
        'https://gamma.pagespace.ai/api/health',
        expect.objectContaining({ timeout: expect.any(Number) })
      )
    })

    test('given healthy response (200), should call updateHealthStatus with healthy', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 })
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.repo.updateHealthStatus).toHaveBeenCalledWith('tenant-1', 'healthy')
    })

    test('given unhealthy response (non-200), should update to unhealthy', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 503 })
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.repo.updateHealthStatus).toHaveBeenCalledWith('tenant-1', 'unhealthy')
    })

    test('given request timeout (rejected promise), should update to unhealthy', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.repo.updateHealthStatus).toHaveBeenCalledWith('tenant-1', 'unhealthy')
    })

    test('given suspended tenant in list, should skip without making request', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'active-one', status: 'active' }),
        makeTenant({ id: 't2', slug: 'suspended-one', status: 'suspended' }),
      ])
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.httpClient.get).toHaveBeenCalledTimes(1)
      expect(deps.httpClient.get).toHaveBeenCalledWith(
        'https://active-one.pagespace.ai/api/health',
        expect.any(Object)
      )
    })

    test('given tenant recovering (unhealthy -> healthy), should record recovered event', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ healthStatus: 'unhealthy' }),
      ])
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 })
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'recovered',
        expect.objectContaining({ slug: 'acme' })
      )
    })

    test('given tenant healthy and was already healthy, should NOT record recovered event', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ healthStatus: 'healthy' }),
      ])
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 })
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.repo.recordEvent).not.toHaveBeenCalled()
    })

    test('given checkAll, should return results for each checked tenant', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
      ])
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 500 })
      const monitor = createHealthMonitor(deps)

      const results = await monitor.checkAll()

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({ tenantId: 't1', slug: 'alpha', healthy: true })
      expect(results[1]).toEqual({ tenantId: 't2', slug: 'beta', healthy: false })
    })

    test('given destroyed tenant in list, should skip without making request', async () => {
      const deps = makeDeps()
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alive', status: 'active' }),
        makeTenant({ id: 't2', slug: 'gone', status: 'destroyed' }),
        makeTenant({ id: 't3', slug: 'failing', status: 'failed' }),
      ])
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()

      expect(deps.httpClient.get).toHaveBeenCalledTimes(1)
    })
  })

  describe('consecutive failure alerting', () => {
    test('given unhealthy response 3 times in a row, should trigger alert callback', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 })
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'healthy' })])
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'unhealthy' })])
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'unhealthy' })])
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll() // failure 1
      await monitor.checkAll() // failure 2
      await monitor.checkAll() // failure 3

      expect(deps.onAlert).toHaveBeenCalledTimes(1)
      expect(deps.onAlert).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'tenant-1',
        slug: 'acme',
        consecutiveFailures: 3,
      }))
    })

    test('given 2 consecutive failures then healthy, should reset counter and not alert', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 200 })
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'healthy' })])
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'unhealthy' })])
        .mockResolvedValueOnce([makeTenant({ healthStatus: 'unhealthy' })])
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()
      await monitor.checkAll()
      await monitor.checkAll()

      expect(deps.onAlert).not.toHaveBeenCalled()
    })

    test('given 2 failures, recovery, then 2 more failures, should not alert (counter resets)', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ status: 500 }) // fail 1
        .mockResolvedValueOnce({ status: 500 }) // fail 2
        .mockResolvedValueOnce({ status: 200 }) // recover
        .mockResolvedValueOnce({ status: 500 }) // fail 1 (reset)
        .mockResolvedValueOnce({ status: 500 }) // fail 2
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue(
        [makeTenant({ healthStatus: 'unhealthy' })]
      )
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()
      await monitor.checkAll()
      await monitor.checkAll()
      await monitor.checkAll()
      await monitor.checkAll()

      expect(deps.onAlert).not.toHaveBeenCalled()
    })

    test('given continued failures beyond threshold, should alert on each Nth failure', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 })
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue(
        [makeTenant({ healthStatus: 'unhealthy' })]
      )
      const monitor = createHealthMonitor(deps)

      // 6 consecutive failures with threshold=3
      for (let i = 0; i < 6; i++) {
        await monitor.checkAll()
      }

      // Should alert at failure 3 and failure 6
      expect(deps.onAlert).toHaveBeenCalledTimes(2)
    })

    test('given failure count tracking, getFailureCount should return current count', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 })
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue(
        [makeTenant({ healthStatus: 'healthy' })]
      )
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()
      await monitor.checkAll()

      expect(monitor.getFailureCount('tenant-1')).toBe(2)
    })

    test('given recovery, getFailureCount should return 0', async () => {
      const deps = makeDeps()
      ;(deps.httpClient.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 200 })
      ;(deps.repo.listTenants as ReturnType<typeof vi.fn>).mockResolvedValue(
        [makeTenant({ healthStatus: 'unhealthy' })]
      )
      const monitor = createHealthMonitor(deps)

      await monitor.checkAll()
      await monitor.checkAll()

      expect(monitor.getFailureCount('tenant-1')).toBe(0)
    })
  })
})
