import type { ShellExecutor } from './shell-executor'

type TenantRepo = {
  getTenantBySlug(slug: string): Promise<unknown | null>
  createTenant(input: { slug: string; name: string; ownerEmail: string; tier: string }): Promise<{ id: string; slug: string }>
  updateTenantStatus(id: string, status: string): Promise<unknown>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}

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

export type ProvisioningDeps = {
  repo: TenantRepo
  executor: ShellExecutor
  fs: FsLike
  seeder: AdminSeeder
  pollHealth: (slug: string) => Promise<{ healthy: boolean }>
  basePath: string
  scriptsPath: string
  composePath: string
}

type ProvisionRequest = {
  slug: string
  ownerEmail: string
  tier: string
}

export function createProvisioningEngine(deps: ProvisioningDeps) {
  const { repo, executor, fs, seeder, pollHealth, basePath, scriptsPath, composePath } = deps

  return {
    async provision(request: ProvisionRequest) {
      // Step 1: Check for duplicate slug
      const existing = await repo.getTenantBySlug(request.slug)
      if (existing) {
        throw new Error(`Tenant slug "${request.slug}" conflict: already exists`)
      }

      // Step 2: Create tenant record with provisioning status
      const tenant = await repo.createTenant({
        slug: request.slug,
        name: request.slug,
        ownerEmail: request.ownerEmail,
        tier: request.tier,
      })

      let composedUp = false

      try {
        // Step 3: Generate env file via shell script
        const envResult = await executor.exec(
          `${scriptsPath}/generate-tenant-env.sh ${request.slug}`,
          { cwd: scriptsPath }
        )
        if (envResult.exitCode !== 0) {
          throw Object.assign(new Error(`Env generation failed: ${envResult.stderr}`), { step: 'generate-env' })
        }

        // Step 4: Write env to tenants/{slug}/.env
        const tenantDir = `${basePath}/${request.slug}`
        await fs.mkdir(tenantDir, { recursive: true })
        await fs.writeFile(`${tenantDir}/.env`, envResult.stdout)

        // Step 5: Docker compose up
        const composeCmd = `docker compose -p ps-${request.slug} -f ${composePath} --env-file ${tenantDir}/.env up -d`
        const composeResult = await executor.exec(composeCmd, { cwd: basePath })
        if (composeResult.exitCode !== 0) {
          composedUp = true
          throw Object.assign(new Error(`Docker compose up failed: ${composeResult.stderr}`), { step: 'compose-up' })
        }
        composedUp = true

        // Step 6: Poll health
        await pollHealth(request.slug)

        // Step 7: Seed admin user
        const envContent = await fs.readFile(`${tenantDir}/.env`)
        const dbUrlMatch = envContent.match(/DATABASE_URL=(.+)/)
        const databaseUrl = dbUrlMatch ? dbUrlMatch[1] : `postgres://localhost/ps_${request.slug}`

        const seedResult = await seeder.seed({
          slug: request.slug,
          ownerEmail: request.ownerEmail,
          databaseUrl,
        })

        // Step 8: Update status to active
        await repo.updateTenantStatus(tenant.id, 'active')

        // Step 9: Record provisioned event
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
        // On failure: update status to failed, record error event
        const step = (error as { step?: string }).step ?? 'unknown'
        const message = (error as Error).message

        try {
          await repo.updateTenantStatus(tenant.id, 'failed')
          await repo.recordEvent(tenant.id, 'provisioning_failed', { step, error: message })
        } catch {
          // Best-effort status update
        }

        // If compose was started, attempt cleanup
        if (composedUp) {
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
