import { describe, test, expect, vi } from 'vitest'
import { createTenantLifecycle, type LifecycleDeps } from '../tenant-lifecycle'

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-123',
    slug: 'acme',
    name: 'acme',
    status: 'active',
    tier: 'business',
    ownerEmail: 'owner@acme.com',
    ...overrides,
  }
}

function makeMockRepo(tenant = makeTenant()) {
  return {
    getTenantBySlug: vi.fn().mockResolvedValue(tenant),
    updateTenantStatus: vi.fn().mockResolvedValue({ ...tenant, status: 'suspended' }),
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

function makeDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    repo: makeMockRepo(),
    executor: makeMockExecutor(),
    pollHealth: makeMockHealthPoller(),
    composePath: '/opt/infrastructure/docker-compose.tenant.yml',
    basePath: '/data/tenants',
    ...overrides,
  }
}

describe('TenantLifecycle', () => {
  describe('suspend', () => {
    test('given an active tenant, should stop web, realtime, and processor containers', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.suspend('acme')

      const stopCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('stop')
      )
      expect(stopCall).toBeDefined()
      expect(stopCall![0]).toContain('ps-acme')
      for (const svc of ['web', 'realtime', 'processor']) {
        expect(stopCall![0]).toContain(svc)
      }
    })

    test('given an active tenant, should keep postgres and redis running', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.suspend('acme')

      const stopCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('stop')
      )
      expect(stopCall![0]).not.toContain('postgres')
      expect(stopCall![0]).not.toContain('redis')
    })

    test('given an active tenant, should update status to suspended', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.suspend('acme')

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'suspended')
    })

    test('given an active tenant, should record a suspended event', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.suspend('acme')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123', 'suspended', expect.any(Object)
      )
    })

    test('given an already suspended tenant, should throw conflict error', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      // Make updateTenantStatus throw for invalid transition
      ;(deps.repo.updateTenantStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Invalid transition: suspended -> suspended')
      )
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.suspend('acme')).rejects.toThrow('Invalid transition')
    })

    test('given a nonexistent tenant, should throw not found error', async () => {
      const deps = makeDeps({
        repo: {
          ...makeMockRepo(),
          getTenantBySlug: vi.fn().mockResolvedValue(null),
        },
      })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.suspend('ghost')).rejects.toThrow('not found')
    })
  })

  describe('resume', () => {
    test('given a suspended tenant, should start stopped containers', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      const startCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('start')
      )
      expect(startCall).toBeDefined()
      expect(startCall![0]).toContain('ps-acme')
    })

    test('given a suspended tenant, should poll health after starting', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      expect(deps.pollHealth).toHaveBeenCalledWith('acme')
    })

    test('given a suspended tenant, should update status to active', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'active')
    })

    test('given a suspended tenant, should record a resumed event', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123', 'resumed', expect.any(Object)
      )
    })
  })

  describe('upgrade', () => {
    test('given an active tenant and image tag, should pull new images', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.upgrade('acme', 'v1.2.3')

      const pullCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('pull')
      )
      expect(pullCall).toBeDefined()
    })

    test('given an active tenant, should recreate containers one at a time (rolling)', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.upgrade('acme', 'v1.2.3')

      const upCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('up -d') && (call[0] as string).includes('--no-deps')
      )
      expect(upCalls.length).toBeGreaterThanOrEqual(3) // web, realtime, processor
    })

    test('given an upgrade, should record an upgraded event', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.upgrade('acme', 'v1.2.3')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123', 'upgraded', expect.objectContaining({ imageTag: 'v1.2.3' })
      )
    })
  })

  describe('destroy', () => {
    test('given an active tenant, should run backup before destroying', async () => {
      const deps = makeDeps()
      const callOrder: string[] = []
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        if (cmd.includes('pg_dump')) callOrder.push('backup')
        if (cmd.includes('down --volumes')) callOrder.push('down')
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      expect(callOrder[0]).toBe('backup')
      expect(callOrder).toContain('down')
    })

    test('given an active tenant, should stop all containers and remove volumes', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      const downCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('down --volumes')
      )
      expect(downCall).toBeDefined()
      expect(downCall![0]).toContain('ps-acme')
    })

    test('given an active tenant, should transition through destroying to destroyed', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      const statusCalls = (deps.repo.updateTenantStatus as ReturnType<typeof vi.fn>).mock.calls
      expect(statusCalls[0]).toEqual(['tenant-123', 'destroying'])
      expect(statusCalls[1]).toEqual(['tenant-123', 'destroyed'])
    })

    test('given an active tenant, should record a destroyed event', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123', 'destroyed', expect.any(Object)
      )
    })

    test('given a nonexistent tenant, should throw not found error', async () => {
      const deps = makeDeps({
        repo: {
          ...makeMockRepo(),
          getTenantBySlug: vi.fn().mockResolvedValue(null),
        },
      })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.destroy('ghost')).rejects.toThrow('not found')
    })
  })
})
