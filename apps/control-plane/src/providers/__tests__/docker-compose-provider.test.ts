import { describe, test, expect, vi } from 'vitest'
import { createDockerComposeProvider, type DockerComposeProviderDeps } from '../docker-compose-provider'

function makeMockExecutor() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    history: [] as Array<{ command: string; exitCode: number }>,
  }
}

function makeMockFs() {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDeps(overrides: Partial<DockerComposeProviderDeps> = {}): DockerComposeProviderDeps {
  return {
    executor: makeMockExecutor(),
    fs: makeMockFs(),
    composePath: '/opt/infrastructure/docker-compose.tenant.yml',
    basePath: '/data/tenants',
    healthPollMaxAttempts: 1,
    healthPollDelayMs: 0,
    ...overrides,
  }
}

describe('DockerComposeProvider', () => {
  describe('provision', () => {
    test('given slug and env content, should write env file to tenant directory', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.provision('acme', 'FOO=bar\nBAZ=qux')

      expect(deps.fs.mkdir).toHaveBeenCalledWith('/data/tenants/acme', { recursive: true })
      expect(deps.fs.writeFile).toHaveBeenCalledWith('/data/tenants/acme/.env', 'FOO=bar\nBAZ=qux')
    })

    test('given slug and env content, should run docker compose up with correct project name', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.provision('acme', 'FOO=bar')

      const composeCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('docker compose')
      )
      expect(composeCall).toBeDefined()
      expect(composeCall![0]).toContain('-p ps-acme')
      expect(composeCall![0]).toContain('up -d')
      expect(composeCall![0]).toContain('--env-file /data/tenants/acme/.env')
    })

    test('given docker compose up fails, should throw', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'compose error', exitCode: 1,
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.provision('acme', 'FOO=bar')).rejects.toThrow('compose-up failed')
    })
  })

  describe('destroy', () => {
    test('given a slug without backup, should run docker compose down --volumes', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.destroy('acme')

      const downCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('down --volumes')
      )
      expect(downCall).toBeDefined()
      expect(downCall![0]).toContain('ps-acme')
    })

    test('given a slug with backup, should run pg_dump before down', async () => {
      const deps = makeDeps()
      const callOrder: string[] = []
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        if (cmd.includes('pg_dump')) callOrder.push('backup')
        if (cmd.includes('down --volumes')) callOrder.push('down')
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const provider = createDockerComposeProvider(deps)

      await provider.destroy('acme', { backup: true })

      expect(callOrder).toEqual(['backup', 'down'])
    })

    test('given backup failure, should throw and not proceed to down', async () => {
      const deps = makeDeps()
      const callOrder: string[] = []
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        if (cmd.includes('pg_dump')) {
          callOrder.push('backup')
          return { stdout: '', stderr: 'pg_dump error', exitCode: 1 }
        }
        if (cmd.includes('down --volumes')) callOrder.push('down')
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.destroy('acme', { backup: true })).rejects.toThrow('backup failed')
      expect(callOrder).not.toContain('down')
    })

    test('given docker compose down fails, should throw', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'down error', exitCode: 1,
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.destroy('acme')).rejects.toThrow('destroy failed')
    })
  })

  describe('suspend', () => {
    test('given a slug, should stop app services', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.suspend('acme')

      const stopCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(stopCall[0]).toContain('ps-acme')
      expect(stopCall[0]).toContain('stop')
      for (const svc of ['web', 'realtime', 'processor', 'cron']) {
        expect(stopCall[0]).toContain(svc)
      }
    })

    test('given a slug, should not stop postgres or redis', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.suspend('acme')

      const stopCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(stopCall[0]).not.toMatch(/\bpostgres\b/)
      expect(stopCall[0]).not.toMatch(/\bredis\b/)
    })

    test('given docker compose stop fails, should throw', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'stop error', exitCode: 1,
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.suspend('acme')).rejects.toThrow('suspend failed')
    })
  })

  describe('resume', () => {
    test('given a slug, should start app services', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.resume('acme')

      const startCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(startCall[0]).toContain('ps-acme')
      expect(startCall[0]).toContain('start')
      for (const svc of ['web', 'realtime', 'processor', 'cron']) {
        expect(startCall[0]).toContain(svc)
      }
    })

    test('given docker compose start fails, should throw', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'start error', exitCode: 1,
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.resume('acme')).rejects.toThrow('resume failed')
    })
  })

  describe('upgrade', () => {
    test('given a slug and image tag, should pull new images', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.upgrade('acme', 'v1.2.3')

      const pullCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('pull')
      )
      expect(pullCall).toBeDefined()
      expect(pullCall![0]).toContain('web realtime processor cron')
      expect(pullCall![1]).toEqual(expect.objectContaining({ env: { IMAGE_TAG: 'v1.2.3' } }))
    })

    test('given a slug and image tag, should recreate all 4 app services', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.upgrade('acme', 'v1.2.3')

      const upCalls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('up -d') && (call[0] as string).includes('--no-deps')
      )
      expect(upCalls).toHaveLength(4)
    })

    test('given a slug and image tag, should pass IMAGE_TAG env to all exec calls', async () => {
      const deps = makeDeps()
      const provider = createDockerComposeProvider(deps)

      await provider.upgrade('acme', 'v1.2.3')

      const calls = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls
      for (const call of calls) {
        expect(call[1]).toEqual(expect.objectContaining({ env: { IMAGE_TAG: 'v1.2.3' } }))
      }
    })

    test('given docker compose pull fails, should throw', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'pull error', exitCode: 1,
      })
      const provider = createDockerComposeProvider(deps)

      await expect(provider.upgrade('acme', 'v1.2.3')).rejects.toThrow('upgrade-pull failed')
    })
  })

  describe('exec', () => {
    test('given a slug and command, should run via docker compose exec', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: 'command output', stderr: '', exitCode: 0,
      })
      const provider = createDockerComposeProvider(deps)

      const result = await provider.exec('acme', 'postgres psql -U pagespace')

      expect(result.stdout).toBe('command output')
      expect(result.exitCode).toBe(0)
      const execCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(execCall[0]).toContain('exec -T postgres psql -U pagespace')
      expect(execCall[0]).toContain('ps-acme')
    })
  })

  describe('healthCheck', () => {
    test('given fetch returns ok, should return healthy', async () => {
      const deps = makeDeps()
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', mockFetch)
      const provider = createDockerComposeProvider(deps)

      const result = await provider.healthCheck('acme')

      expect(result).toEqual({ healthy: true })
      expect(mockFetch).toHaveBeenCalledWith(
        'http://ps-acme-web:3000/api/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      vi.unstubAllGlobals()
    })

    test('given fetch always fails, should return unhealthy after max attempts', async () => {
      const deps = makeDeps({ healthPollMaxAttempts: 2, healthPollDelayMs: 0 })
      const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
      vi.stubGlobal('fetch', mockFetch)
      const provider = createDockerComposeProvider(deps)

      const result = await provider.healthCheck('acme')

      expect(result).toEqual({ healthy: false })
      expect(mockFetch).toHaveBeenCalledTimes(2)
      vi.unstubAllGlobals()
    })
  })
})
