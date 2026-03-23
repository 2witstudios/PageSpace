import type { ShellExecutor, ExecOptions } from '../services/shell-executor'
import type { TenantInfraProvider, InfraExecResult } from './types'

type FsLike = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  writeFile(path: string, data: string): Promise<void>
}

export type DockerComposeProviderDeps = {
  executor: ShellExecutor
  fs: FsLike
  composePath: string
  basePath: string
  healthPollMaxAttempts?: number
  healthPollDelayMs?: number
}

const APP_SERVICES = ['web', 'realtime', 'processor', 'cron']

export function createDockerComposeProvider(deps: DockerComposeProviderDeps): TenantInfraProvider {
  const {
    executor,
    fs,
    composePath,
    basePath,
    healthPollMaxAttempts = 30,
    healthPollDelayMs = 2000,
  } = deps

  function composeCmd(slug: string, action: string): string {
    return `docker compose -p ps-${slug} -f ${composePath} --env-file ${basePath}/${slug}/.env ${action}`
  }

  async function execOrFail(command: string, step: string, options?: ExecOptions): Promise<InfraExecResult> {
    const result = await executor.exec(command, options)
    if (result.exitCode !== 0) {
      throw new Error(`${step} failed (exit ${result.exitCode}): ${result.stderr}`)
    }
    return result
  }

  return {
    async provision(slug, envContent) {
      const tenantDir = `${basePath}/${slug}`
      await fs.mkdir(tenantDir, { recursive: true })
      await fs.writeFile(`${tenantDir}/.env`, envContent)

      const cmd = `docker compose -p ps-${slug} -f ${composePath} --env-file ${tenantDir}/.env up -d`
      await execOrFail(cmd, 'compose-up', { cwd: basePath })
    },

    async destroy(slug, opts) {
      if (opts?.backup) {
        await execOrFail(
          `${composeCmd(slug, 'exec -T postgres pg_dump -U pagespace -d pagespace')} > ${basePath}/${slug}/backup.sql`,
          'backup',
          { cwd: basePath }
        )
      }

      await execOrFail(
        composeCmd(slug, 'down --volumes'),
        'destroy',
        { cwd: basePath }
      )
    },

    async suspend(slug) {
      const services = APP_SERVICES.join(' ')
      await execOrFail(
        composeCmd(slug, `stop ${services}`),
        'suspend',
        { cwd: basePath }
      )
    },

    async resume(slug) {
      const services = APP_SERVICES.join(' ')
      await execOrFail(
        composeCmd(slug, `start ${services}`),
        'resume',
        { cwd: basePath }
      )
    },

    async upgrade(slug, imageTag) {
      await execOrFail(
        composeCmd(slug, `pull ${APP_SERVICES.join(' ')}`),
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
    },

    async healthCheck(slug) {
      for (let i = 0; i < healthPollMaxAttempts; i++) {
        try {
          const res = await fetch(`http://ps-${slug}-web:3000/api/health`, {
            signal: AbortSignal.timeout(5000),
          })
          if (res.ok) return { healthy: true }
        } catch {
          // Service not ready yet
        }
        await new Promise((r) => setTimeout(r, healthPollDelayMs))
      }
      return { healthy: false }
    },

    async exec(slug, command) {
      return executor.exec(
        composeCmd(slug, `exec -T ${command}`),
        { cwd: basePath }
      )
    },
  }
}
