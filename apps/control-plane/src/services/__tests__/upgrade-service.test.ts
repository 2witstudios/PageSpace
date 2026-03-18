import { describe, test, expect, vi } from 'vitest'
import { createUpgradeService, type UpgradeDeps } from '../upgrade-service'

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-1',
    slug: 'acme',
    status: 'active' as string,
    ...overrides,
  }
}

function makeMockRepo() {
  return {
    listActiveTenants: vi.fn().mockResolvedValue([makeTenant()]),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockExecutor() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    history: [] as Array<{ command: string; exitCode: number }>,
  }
}

function makeMockHealthPoller() {
  return vi.fn().mockResolvedValue({ healthy: true })
}

function makeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    repo: makeMockRepo(),
    executor: makeMockExecutor(),
    pollHealth: makeMockHealthPoller(),
    composePath: '/opt/infrastructure/docker-compose.tenant.yml',
    basePath: '/data/tenants',
    ...overrides,
  }
}

describe('UpgradeService', () => {
  describe('upgradeAll', () => {
    test('given 3 tenants and successful upgrades, should call docker compose for each in sequence', async () => {
      const deps = makeDeps()
      ;(deps.repo.listActiveTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
        makeTenant({ id: 't3', slug: 'gamma' }),
      ])
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      // Each tenant: pull + 4 service recreations = 5 calls per tenant = 15 total
      // Plus health check after each service recreation
      const pullCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('pull')
      )
      expect(pullCalls).toHaveLength(3)

      // Verify order: alpha before beta before gamma
      const allCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as string
      )
      const alphaIdx = allCalls.findIndex(c => c.includes('ps-alpha') && c.includes('pull'))
      const betaIdx = allCalls.findIndex(c => c.includes('ps-beta') && c.includes('pull'))
      const gammaIdx = allCalls.findIndex(c => c.includes('ps-gamma') && c.includes('pull'))
      expect(alphaIdx).toBeLessThan(betaIdx)
      expect(betaIdx).toBeLessThan(gammaIdx)
    })

    test('given each tenant upgrade, should pull then recreate services one at a time', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      const calls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as string
      )

      // Should pull first
      expect(calls[0]).toContain('pull')
      // Then recreate services one at a time
      const recreateCalls = calls.filter(c => c.includes('up -d --no-deps'))
      expect(recreateCalls.length).toBeGreaterThanOrEqual(4)
    })

    test('given each tenant upgrade, should pass IMAGE_TAG env to docker compose', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      const pullCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('pull')
      )
      expect(pullCall![1]).toEqual(expect.objectContaining({
        env: expect.objectContaining({ IMAGE_TAG: 'v2.0.0' }),
      }))
    })

    test('given successful upgrade, should record upgrade_completed event', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'upgrade_completed',
        expect.objectContaining({ imageTag: 'v2.0.0' })
      )
    })

    test('given upgrade starts, should record upgrade_started event', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'upgrade_started',
        expect.objectContaining({ imageTag: 'v2.0.0' })
      )
    })

    test('given successful upgrade, should poll health after each service recreation', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      // 4 services per tenant, 1 health check per service
      expect(deps.pollHealth).toHaveBeenCalledTimes(4)
      expect(deps.pollHealth).toHaveBeenCalledWith('acme')
    })
  })

  describe('failure handling', () => {
    test('given 2nd tenant fails, should stop and not upgrade 3rd (default behavior)', async () => {
      const deps = makeDeps()
      ;(deps.repo.listActiveTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
        makeTenant({ id: 't3', slug: 'gamma' }),
      ])
      // alpha succeeds, beta pull fails
      ;(deps.executor.exec as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) // default success
      let callCount = 0
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        callCount++
        if ((cmd as string).includes('ps-beta') && (cmd as string).includes('pull')) {
          return { stdout: '', stderr: 'pull failed', exitCode: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const service = createUpgradeService(deps)

      const result = await service.upgradeAll({ imageTag: 'v2.0.0' })

      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].slug).toBe('beta')
      // Should NOT have gamma calls after beta failure
      const gammaCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('ps-gamma')
      )
      expect(gammaCalls).toHaveLength(0)
    })

    test('given --continue-on-error and 2nd tenant fails, should continue to 3rd', async () => {
      const deps = makeDeps()
      ;(deps.repo.listActiveTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
        makeTenant({ id: 't3', slug: 'gamma' }),
      ])
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        if ((cmd as string).includes('ps-beta') && (cmd as string).includes('pull')) {
          return { stdout: '', stderr: 'pull failed', exitCode: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const service = createUpgradeService(deps)

      const result = await service.upgradeAll({ imageTag: 'v2.0.0', continueOnError: true })

      expect(result.failed).toHaveLength(1)
      expect(result.succeeded).toHaveLength(2)
      // Should have gamma calls
      const gammaCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('ps-gamma')
      )
      expect(gammaCalls.length).toBeGreaterThan(0)
    })

    test('given tenant upgrade failure, should record upgrade_failed event', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'pull failed', exitCode: 1,
      })
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0' })

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'upgrade_failed',
        expect.objectContaining({ error: expect.any(String) })
      )
    })
  })

  describe('dry run', () => {
    test('given dry-run, should return plan without calling any docker commands', async () => {
      const deps = makeDeps()
      ;(deps.repo.listActiveTenants as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTenant({ id: 't1', slug: 'alpha' }),
        makeTenant({ id: 't2', slug: 'beta' }),
      ])
      const service = createUpgradeService(deps)

      const result = await service.upgradeAll({ imageTag: 'v2.0.0', dryRun: true })

      expect(deps.executor.exec).not.toHaveBeenCalled()
      expect(result.planned).toHaveLength(2)
      expect(result.planned[0].slug).toBe('alpha')
      expect(result.planned[1].slug).toBe('beta')
    })

    test('given dry-run, should not record any events', async () => {
      const deps = makeDeps()
      const service = createUpgradeService(deps)

      await service.upgradeAll({ imageTag: 'v2.0.0', dryRun: true })

      expect(deps.repo.recordEvent).not.toHaveBeenCalled()
    })
  })
})
