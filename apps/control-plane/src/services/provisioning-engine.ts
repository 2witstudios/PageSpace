import type { ShellExecutor } from './shell-executor'
import type { TenantRepo } from './types'
import type { TenantInfraProvider } from '../providers/types'
import { validateSlug } from '../validation/tenant-validation'

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
  provider: TenantInfraProvider
  executor: ShellExecutor
  seeder: AdminSeeder
  sendProvisioningEmail?: (data: ProvisioningEmailData) => Promise<void>
  tenantBaseDomain?: string
  scriptsPath: string
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
    repo, provider, executor, seeder,
    sendProvisioningEmail = async () => { console.warn('sendProvisioningEmail not configured — skipping provisioning email') },
    tenantBaseDomain = 'pagespace.ai',
    scriptsPath,
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

      let infraStarted = false

      try {
        // Step 4: Generate env file via shell script
        const envResult = await executor.exec(
          `${scriptsPath}/generate-tenant-env.sh ${request.slug}`,
          { cwd: scriptsPath }
        )
        if (envResult.exitCode !== 0) {
          throw Object.assign(new Error(`Env generation failed: ${envResult.stderr}`), { step: 'generate-env' })
        }

        const envContent = envResult.stdout

        // Step 5: Provision infrastructure (provider writes env + starts services)
        await provider.provision(request.slug, envContent)
        infraStarted = true

        // Step 6: Poll health
        const healthResult = await provider.healthCheck(request.slug)
        if (!healthResult.healthy) {
          throw Object.assign(new Error('Health check failed: services not healthy'), { step: 'poll-health' })
        }

        // Step 7: Seed admin user (extract DB URL from in-memory env content)
        const pgUser = getEnvVar(envContent, 'POSTGRES_USER') ?? 'pagespace'
        const pgPassword = getEnvVar(envContent, 'POSTGRES_PASSWORD') ?? ''
        const pgDb = getEnvVar(envContent, 'POSTGRES_DB') ?? 'pagespace'
        const databaseUrl = `postgresql://${pgUser}:${pgPassword}@postgres:5432/${pgDb}`

        const seedResult = await seeder.seed({
          slug: request.slug,
          ownerEmail: request.ownerEmail,
          databaseUrl,
        })

        // Step 8: Send provisioning email (fire-and-forget — must not fail provisioning)
        try {
          await sendProvisioningEmail({
            loginUrl: `https://${request.slug}.${tenantBaseDomain}`,
            adminEmail: request.ownerEmail,
            ...(!seedResult.alreadyExisted && seedResult.temporaryPassword
              ? { temporaryPassword: seedResult.temporaryPassword }
              : {}),
          })
        } catch {
          // Email failure must NOT fail provisioning
        }

        // Step 9: Update status to active
        await repo.updateTenantStatus(tenant.id, 'active')

        // Step 10: Record provisioned event
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

        if (infraStarted) {
          try {
            await provider.destroy(request.slug)
          } catch {
            // Best-effort cleanup
          }
        }

        throw error
      }
    },
  }
}
