import type { ShellExecutor } from './shell-executor'
import type { TenantRepo } from './types'
import { validateSlug } from '../validation/tenant-validation'

type FsLike = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  readFile(path: string): Promise<string>
}

type AdminSeeder = {
  seed(input: { slug: string; ownerEmail: string; databaseUrl: string }): Promise<{
    email: string
    temporaryPassword?: string
    alreadyExisted: boolean
  }>
}

type ProvisioningEmailData = {
  loginUrl: string
  adminEmail: string
  temporaryPassword?: string
}

export type ProvisioningDeps = {
  repo: TenantRepo
  executor: ShellExecutor
  fs: FsLike
  seeder: AdminSeeder
  pollHealth: (slug: string) => Promise<{ healthy: boolean }>
  sendProvisioningEmail?: (data: ProvisioningEmailData) => Promise<void>
  basePath: string
  scriptsPath: string
  composePath: string
}

type ProvisionRequest = {
  slug: string
  name?: string
  ownerEmail: string
  tier: string
}

function getEnvVar(envContent: string, name: string): string | undefined {
  const match = envContent.match(new RegExp(`^${name}=(.+)$`, 'm'))
  return match?.[1]
}

export function createProvisioningEngine(deps: ProvisioningDeps) {
  const {
    repo, executor, fs, seeder, pollHealth,
    sendProvisioningEmail = async () => { console.warn('sendProvisioningEmail not configured — skipping provisioning email') },
    basePath, scriptsPath, composePath,
  } = deps

  return {
    async provision(request: ProvisionRequest) {
      // Step 1: Validate slug (defense-in-depth)
      const slugResult = validateSlug(request.slug)
      if (!slugResult.valid) {
        throw new Error(`Invalid slug: ${slugResult.error}`)
      }

      // Step 2: Check for duplicate slug
      const existing = await repo.getTenantBySlug(request.slug)
      if (existing) {
        throw new Error(`Tenant slug "${request.slug}" conflict: already exists`)
      }

      // Step 3: Create tenant record with provisioning status
      const tenant = await repo.createTenant({
        slug: request.slug,
        name: request.name ?? request.slug,
        ownerEmail: request.ownerEmail,
        tier: request.tier,
      })

      let composeStarted = false

      try {
        // Step 4: Generate env file via shell script
        const envResult = await executor.exec(
          `${scriptsPath}/generate-tenant-env.sh ${request.slug}`,
          { cwd: scriptsPath }
        )
        if (envResult.exitCode !== 0) {
          throw Object.assign(new Error(`Env generation failed: ${envResult.stderr}`), { step: 'generate-env' })
        }

        // Step 5: Write env to tenants/{slug}/.env
        const tenantDir = `${basePath}/${request.slug}`
        await fs.mkdir(tenantDir, { recursive: true })
        await fs.writeFile(`${tenantDir}/.env`, envResult.stdout)

        // Step 6: Docker compose up
        const composeCmd = `docker compose -p ps-${request.slug} -f ${composePath} --env-file ${tenantDir}/.env up -d`
        const composeResult = await executor.exec(composeCmd, { cwd: basePath })
        if (composeResult.exitCode !== 0) {
          composeStarted = true
          throw Object.assign(new Error(`Docker compose up failed: ${composeResult.stderr}`), { step: 'compose-up' })
        }
        composeStarted = true

        // Step 7: Poll health
        const healthResult = await pollHealth(request.slug)
        if (!healthResult.healthy) {
          throw Object.assign(new Error('Health check failed: services not healthy'), { step: 'poll-health' })
        }

        // Step 8: Seed admin user
        const envContent = await fs.readFile(`${tenantDir}/.env`)
        const pgUser = getEnvVar(envContent, 'POSTGRES_USER') ?? 'pagespace'
        const pgPassword = getEnvVar(envContent, 'POSTGRES_PASSWORD') ?? ''
        const pgDb = getEnvVar(envContent, 'POSTGRES_DB') ?? 'pagespace'
        const databaseUrl = `postgresql://${pgUser}:${pgPassword}@postgres:5432/${pgDb}`

        const seedResult = await seeder.seed({
          slug: request.slug,
          ownerEmail: request.ownerEmail,
          databaseUrl,
        })

        // Step 9: Send provisioning email (fire-and-forget — must not fail provisioning)
        try {
          await sendProvisioningEmail({
            loginUrl: `https://${request.slug}.pagespace.ai`,
            adminEmail: request.ownerEmail,
            ...(!seedResult.alreadyExisted && seedResult.temporaryPassword
              ? { temporaryPassword: seedResult.temporaryPassword }
              : {}),
          })
        } catch {
          // Email failure must NOT fail provisioning
        }

        // Step 10: Update status to active
        await repo.updateTenantStatus(tenant.id, 'active')

        // Step 11: Record provisioned event
        await repo.recordEvent(tenant.id, 'provisioned', {
          ownerEmail: request.ownerEmail,
          tier: request.tier,
        })

        return {
          tenantId: tenant.id,
          email: seedResult.email,
          temporaryPassword: seedResult.temporaryPassword,
        }
      } catch (error) {
        const step = (error as { step?: string }).step ?? 'unknown'
        const message = (error as Error).message

        try {
          await repo.updateTenantStatus(tenant.id, 'failed')
          await repo.recordEvent(tenant.id, 'provisioning_failed', { step, error: message })
        } catch {
          // Best-effort status update
        }

        if (composeStarted) {
          try {
            await executor.exec(
              `docker compose -p ps-${request.slug} -f ${composePath} down --volumes`,
              { cwd: basePath }
            )
          } catch {
            // Best-effort cleanup
          }
        }

        throw error
      }
    },
  }
}
