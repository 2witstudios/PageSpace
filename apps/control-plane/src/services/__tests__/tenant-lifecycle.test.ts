import { describe, test, expect, vi } from 'vitest'
import { createTenantLifecycle, type LifecycleDeps } from '../tenant-lifecycle'
import type { TenantInfraProvider } from '../../providers/types'

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-123',
    slug: 'acme',
    name: 'acme',
    status: 'active' as const,
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

function makeMockProvider(): TenantInfraProvider {
  return {
    provision: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    upgrade: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  }
}

function makeDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    repo: makeMockRepo(),
    provider: makeMockProvider(),
    ...overrides,
  }
}

describe('TenantLifecycle', () => {
  describe('suspend', () => {
    test('given an active tenant, should call provider.suspend', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.suspend('acme')

      expect(deps.provider.suspend).toHaveBeenCalledWith('acme')
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

    test('given an already suspended tenant, should throw transition error', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.suspend('acme')).rejects.toThrow('Cannot transition')
      expect(deps.provider.suspend).not.toHaveBeenCalled()
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

    test('given an invalid slug, should reject without calling provider', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.suspend('INVALID!')).rejects.toThrow('Invalid slug')
      expect(deps.provider.suspend).not.toHaveBeenCalled()
      expect(deps.repo.getTenantBySlug).not.toHaveBeenCalled()
    })

    test('given provider.suspend fails, should throw error', async () => {
      const deps = makeDeps()
      ;(deps.provider.suspend as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('suspend failed (exit 1): compose error')
      )
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.suspend('acme')).rejects.toThrow('suspend failed')
    })
  })

  describe('resume', () => {
    test('given a suspended tenant, should call provider.resume', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      expect(deps.provider.resume).toHaveBeenCalledWith('acme')
    })

    test('given a suspended tenant, should call provider.healthCheck after resuming', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.resume('acme')

      expect(deps.provider.healthCheck).toHaveBeenCalledWith('acme')
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

    test('given health check returns unhealthy, should throw and not mark active', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      ;(deps.provider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: false })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.resume('acme')).rejects.toThrow()
      expect(deps.repo.updateTenantStatus).not.toHaveBeenCalled()
    })

    test('given an active tenant, should throw transition error', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'active' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.resume('acme')).rejects.toThrow('Cannot transition')
      expect(deps.provider.resume).not.toHaveBeenCalled()
    })

    test('given provider.resume fails, should throw error', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      ;(deps.provider.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('resume failed (exit 1): start error')
      )
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.resume('acme')).rejects.toThrow('resume failed')
    })
  })

  describe('upgrade', () => {
    test('given an active tenant and image tag, should call provider.upgrade', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.upgrade('acme', 'v1.2.3')

      expect(deps.provider.upgrade).toHaveBeenCalledWith('acme', 'v1.2.3')
    })

    test('given an upgrade, should record an upgraded event', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.upgrade('acme', 'v1.2.3')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123', 'upgraded', expect.objectContaining({ imageTag: 'v1.2.3' })
      )
    })

    test('given provider.upgrade fails, should throw error', async () => {
      const deps = makeDeps()
      ;(deps.provider.upgrade as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('upgrade-pull failed (exit 1): pull error')
      )
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.upgrade('acme', 'v1.2.3')).rejects.toThrow('upgrade-pull failed')
    })

    test('given a destroyed tenant, should throw not found', async () => {
      const deps = makeDeps({
        repo: {
          ...makeMockRepo(),
          getTenantBySlug: vi.fn().mockResolvedValue(null),
        },
      })
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.upgrade('ghost', 'v1.0.0')).rejects.toThrow('not found')
    })
  })

  describe('destroy', () => {
    test('given an active tenant, should call provider.destroy with backup option', async () => {
      const deps = makeDeps()
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      expect(deps.provider.destroy).toHaveBeenCalledWith('acme', { backup: true })
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

    test('given provider.destroy fails (backup failure), should throw and not transition to destroyed', async () => {
      const deps = makeDeps()
      ;(deps.provider.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('backup failed (exit 1): pg_dump error')
      )
      const lifecycle = createTenantLifecycle(deps)

      await expect(lifecycle.destroy('acme')).rejects.toThrow('backup failed')

      // Should have transitioned to destroying but NOT to destroyed
      const statusCalls = (deps.repo.updateTenantStatus as ReturnType<typeof vi.fn>).mock.calls
      expect(statusCalls).toHaveLength(1)
      expect(statusCalls[0]).toEqual(['tenant-123', 'destroying'])
    })

    test('given a suspended tenant, should be destroyable', async () => {
      const deps = makeDeps({
        repo: makeMockRepo(makeTenant({ status: 'suspended' })),
      })
      const lifecycle = createTenantLifecycle(deps)

      await lifecycle.destroy('acme')

      const statusCalls = (deps.repo.updateTenantStatus as ReturnType<typeof vi.fn>).mock.calls
      expect(statusCalls[0]).toEqual(['tenant-123', 'destroying'])
    })
  })
})
