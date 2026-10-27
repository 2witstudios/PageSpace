import { describe, test, expect, vi } from 'vitest'
import { createProvisioningEngine, type ProvisioningDeps } from '../provisioning-engine'

const REALISTIC_ENV = [
  'TENANT_SLUG=acme',
  'POSTGRES_DB=pagespace',
  'POSTGRES_USER=pagespace',
  'POSTGRES_PASSWORD=abc123secret',
  'DEPLOYMENT_MODE=tenant',
].join('\n')

function makeMockRepo() {
  return {
    getTenantBySlug: vi.fn().mockResolvedValue(null),
    createTenant: vi.fn().mockResolvedValue({
      id: 'tenant-123',
      slug: 'acme',
      name: 'acme',
      status: 'provisioning',
      ownerEmail: 'owner@acme.com',
      tier: 'business',
    }),
    updateTenantStatus: vi.fn().mockResolvedValue({ status: 'active' }),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockExecutor() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: REALISTIC_ENV, stderr: '', exitCode: 0 }),
    history: [] as Array<{ command: string; exitCode: number }>,
  }
}

function makeMockFs() {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(REALISTIC_ENV),
  }
}

function makeMockSeeder() {
  return {
    seed: vi.fn().mockResolvedValue({
      email: 'owner@acme.com',
      alreadyExisted: false,
    }),
  }
}

function makeMockHealthPoller() {
  return vi.fn().mockResolvedValue({ healthy: true })
}

function makeMockEmailSender() {
  return vi.fn().mockResolvedValue(undefined)
}

function makeDeps(overrides: Partial<ProvisioningDeps> = {}): ProvisioningDeps {
  return {
    repo: makeMockRepo(),
    executor: makeMockExecutor(),
    fs: makeMockFs(),
    seeder: makeMockSeeder(),
    pollHealth: makeMockHealthPoller(),
    sendProvisioningEmail: makeMockEmailSender(),
    basePath: '/data/tenants',
    scriptsPath: '/opt/infrastructure/scripts',
    composePath: '/opt/infrastructure/docker-compose.tenant.yml',
    ...overrides,
  }
}

describe('ProvisioningEngine', () => {
  describe('provision', () => {
    test('given a valid request, should create tenant with provisioning status', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.repo.createTenant).toHaveBeenCalledWith({
        slug: 'acme',
        name: 'acme',
        ownerEmail: 'owner@acme.com',
        tier: 'business',
      })
    })

    test('given a valid request, should generate env file via shell script', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.executor.exec).toHaveBeenCalledWith(
        expect.stringContaining('generate-tenant-env.sh acme'),
        expect.any(Object)
      )
    })

    test('given a valid request, should write env to tenants/{slug}/.env', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.fs.mkdir).toHaveBeenCalledWith('/data/tenants/acme', { recursive: true })
      expect(deps.fs.writeFile).toHaveBeenCalledWith(
        '/data/tenants/acme/.env',
        expect.any(String)
      )
    })

    test('given a valid request, should run docker compose up with correct project name', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      const composeCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('docker compose')
      )
      expect(composeCall).toBeDefined()
      expect(composeCall![0]).toContain('-p ps-acme')
      expect(composeCall![0]).toContain('up -d')
      expect(composeCall![0]).toContain('--env-file /data/tenants/acme/.env')
    })

    test('given a valid request, should poll health after docker compose up', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.pollHealth).toHaveBeenCalledWith('acme')
    })

    test('given a valid request, should seed admin user after health check passes', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.seeder.seed).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'acme',
          ownerEmail: 'owner@acme.com',
        })
      )
    })

    test('given a valid request, should update status to active at the end', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'active')
    })

    test('given a valid request, should record a provisioned event', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123',
        'provisioned',
        expect.any(Object)
      )
    })

    test('given a valid request, should return seed result with email', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      const result = await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(result.email).toBe('owner@acme.com')
    })
  })

  describe('DATABASE_URL construction', () => {
    test('given generated env with POSTGRES_* vars, should build DATABASE_URL for seeder', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.seeder.seed).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseUrl: 'postgresql://pagespace:abc123secret@postgres:5432/pagespace',
        })
      )
    })

    test('given env without POSTGRES_* vars, should use pagespace defaults', async () => {
      const deps = makeDeps()
      ;(deps.fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue('DEPLOYMENT_MODE=tenant')
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.seeder.seed).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseUrl: 'postgresql://pagespace:@postgres:5432/pagespace',
        })
      )
    })
  })

  describe('slug validation', () => {
    test('given an invalid slug, should reject without calling shell', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: '; rm -rf /', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow('Invalid slug')

      expect(deps.executor.exec).not.toHaveBeenCalled()
      expect(deps.repo.getTenantBySlug).not.toHaveBeenCalled()
    })

    test('given a reserved slug, should reject', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'admin', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow('Invalid slug')
    })
  })

  describe('duplicate slug rejection', () => {
    test('given a slug that already exists, should reject with conflict error', async () => {
      const deps = makeDeps()
      ;(deps.repo.getTenantBySlug as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'existing',
        slug: 'acme',
        status: 'active',
      })
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow('conflict')

      expect(deps.executor.exec).not.toHaveBeenCalled()
    })
  })

  describe('failure handling', () => {
    test('given env generation failure, should update status to failed with step info', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        stdout: '', stderr: 'script error', exitCode: 1,
      })
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow()

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'failed')
      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123',
        'provisioning_failed',
        expect.objectContaining({ step: expect.any(String) })
      )
    })

    test('given docker compose up failure, should attempt cleanup with docker compose down', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ stdout: REALISTIC_ENV, stderr: '', exitCode: 0 }) // env gen
        .mockResolvedValueOnce({ stdout: '', stderr: 'compose error', exitCode: 1 }) // compose up fails
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // compose down cleanup
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow()

      const downCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('down --volumes')
      )
      expect(downCall).toBeDefined()
    })

    test('given health poll timeout, should update status to failed', async () => {
      const deps = makeDeps()
      ;(deps.pollHealth as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('health check timeout')
      )
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow('health check timeout')

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'failed')
    })

    test('given health poll timeout after compose up, should attempt cleanup', async () => {
      const deps = makeDeps()
      ;(deps.pollHealth as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('health check timeout')
      )
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow()

      const downCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('down --volumes')
      )
      expect(downCall).toBeDefined()
    })

    test('given health poll returns unhealthy, should update status to failed and not seed', async () => {
      const deps = makeDeps()
      ;(deps.pollHealth as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: false })
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow()

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'failed')
      expect(deps.seeder.seed).not.toHaveBeenCalled()
    })

    test('given seeder failure, should update status to failed', async () => {
      const deps = makeDeps()
      ;(deps.seeder.seed as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('seeder failed')
      )
      const engine = createProvisioningEngine(deps)

      await expect(
        engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })
      ).rejects.toThrow('seeder failed')

      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'failed')
    })
  })

  describe('provisioning email', () => {
    test('given no sendProvisioningEmail dep, should provision successfully without sending email', async () => {
      const { sendProvisioningEmail: _, ...depsWithoutEmail } = makeDeps()
      const engine = createProvisioningEngine(depsWithoutEmail)

      const result = await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(result.tenantId).toBe('tenant-123')
    })

    test('given a new admin user, should send provisioning email', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.sendProvisioningEmail).toHaveBeenCalledWith({
        loginUrl: 'https://acme.pagespace.ai',
        adminEmail: 'owner@acme.com',
      })
    })

    test('given a custom tenantBaseDomain, should use it in the login URL', async () => {
      const deps = makeDeps()
      const engine = createProvisioningEngine({ ...deps, tenantBaseDomain: 'example.com' })

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.sendProvisioningEmail).toHaveBeenCalledWith(
        expect.objectContaining({ loginUrl: 'https://acme.example.com' })
      )
    })

    test('given an existing admin user, should still send provisioning email', async () => {
      const deps = makeDeps()
      ;(deps.seeder.seed as ReturnType<typeof vi.fn>).mockResolvedValue({
        email: 'owner@acme.com',
        alreadyExisted: true,
      })
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.sendProvisioningEmail).toHaveBeenCalledWith({
        loginUrl: 'https://acme.pagespace.ai',
        adminEmail: 'owner@acme.com',
      })
    })

    test('given email send failure, should not fail provisioning', async () => {
      const deps = makeDeps()
      ;(deps.sendProvisioningEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('SMTP connection refused')
      )
      const engine = createProvisioningEngine(deps)

      const result = await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(result.tenantId).toBe('tenant-123')
      expect(deps.repo.updateTenantStatus).toHaveBeenCalledWith('tenant-123', 'active')
    })

    test('given email send failure, should still record provisioned event', async () => {
      const deps = makeDeps()
      ;(deps.sendProvisioningEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('SMTP connection refused')
      )
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-123',
        'provisioned',
        expect.any(Object)
      )
    })
  })

  describe('step ordering', () => {
    test('given a valid request, should execute steps in the correct order', async () => {
      const callOrder: string[] = []

      const repo = {
        getTenantBySlug: vi.fn().mockImplementation(async () => {
          callOrder.push('check-slug')
          return null
        }),
        createTenant: vi.fn().mockImplementation(async () => {
          callOrder.push('create-tenant')
          return { id: 'tenant-123', slug: 'acme' }
        }),
        updateTenantStatus: vi.fn().mockImplementation(async () => {
          callOrder.push('update-status')
          return { status: 'active' }
        }),
        recordEvent: vi.fn().mockImplementation(async () => {
          callOrder.push('record-event')
        }),
      }

      const executor = {
        exec: vi.fn().mockImplementation(async (cmd: string) => {
          if (cmd.includes('generate-tenant-env')) callOrder.push('generate-env')
          if (cmd.includes('up -d')) callOrder.push('compose-up')
          return { stdout: REALISTIC_ENV, stderr: '', exitCode: 0 }
        }),
        history: [],
      }

      const fs = {
        mkdir: vi.fn().mockImplementation(async () => { callOrder.push('mkdir') }),
        writeFile: vi.fn().mockImplementation(async () => { callOrder.push('write-env') }),
        readFile: vi.fn().mockResolvedValue(REALISTIC_ENV),
      }

      const seeder = {
        seed: vi.fn().mockImplementation(async () => {
          callOrder.push('seed-admin')
          return { email: 'owner@acme.com', alreadyExisted: false }
        }),
      }

      const pollHealth = vi.fn().mockImplementation(async () => {
        callOrder.push('poll-health')
        return { healthy: true }
      })

      const sendProvisioningEmail = vi.fn().mockImplementation(async () => {
        callOrder.push('send-email')
      })

      const deps = makeDeps({ repo, executor, fs, seeder, pollHealth, sendProvisioningEmail })
      const engine = createProvisioningEngine(deps)

      await engine.provision({ slug: 'acme', ownerEmail: 'owner@acme.com', tier: 'business' })

      expect(callOrder).toEqual([
        'check-slug',
        'create-tenant',
        'generate-env',
        'mkdir',
        'write-env',
        'compose-up',
        'poll-health',
        'seed-admin',
        'send-email',
        'update-status',
        'record-event',
      ])
    })
  })
})
