import { createApp } from './app'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { createTenantRepository, type TenantDb } from './repositories/tenant-repository'
import { createProvisioningEngine, createTenantLifecycle, createShellExecutor, createAdminSeeder } from './services'
import { createDockerComposeProvider } from './providers'
import { mkdir, writeFile } from 'node:fs/promises'

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '3010', 10)

if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid CONTROL_PLANE_PORT: ${process.env.CONTROL_PLANE_PORT}`)
  process.exit(1)
}

const DATABASE_URL = process.env.CONTROL_PLANE_DATABASE_URL
if (!DATABASE_URL) {
  console.error('CONTROL_PLANE_DATABASE_URL is required')
  process.exit(1)
}

async function start() {
  const sql = postgres(DATABASE_URL!)
  const db = drizzle(sql)
  const repo = createTenantRepository(db as unknown as TenantDb)
  const executor = createShellExecutor()

  const basePath = process.env.TENANTS_BASE_PATH || '/opt/pagespace/tenants'
  const scriptsPath = process.env.SCRIPTS_PATH || '/opt/pagespace/scripts'
  const composePath = process.env.COMPOSE_PATH || '/opt/pagespace/docker-compose.tenant.yml'

  const infraProvider = process.env.INFRA_PROVIDER || 'docker'

  const fsAdapter = {
    async mkdir(path: string, options?: { recursive?: boolean }) {
      await mkdir(path, options)
    },
    writeFile,
  }

  if (infraProvider !== 'docker') {
    console.error(`Unsupported INFRA_PROVIDER: ${infraProvider}. Only "docker" is currently supported.`)
    process.exit(1)
  }

  const provider = createDockerComposeProvider({
    executor,
    fs: fsAdapter,
    composePath,
    basePath,
  })

  const seeder = createAdminSeeder({
    connect: async (databaseUrl: string) => {
      const conn = postgres(databaseUrl)
      return {
        async query(sqlStr: string, params?: unknown[]) {
          return conn.unsafe(sqlStr, params as string[])
        },
        async end() {
          await conn.end()
        },
      }
    },
  })

  const provisioningEngine = createProvisioningEngine({
    repo, provider, executor, seeder,
    scriptsPath,
  })

  const lifecycle = createTenantLifecycle({
    repo, provider,
  })

  const app = createApp({
    logger: true,
    repo,
    provisioningEngine,
    lifecycle,
  })

  // Verify database connectivity before accepting traffic
  await sql`SELECT 1`

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Control plane listening on port ${PORT} (infra provider: ${infraProvider})`)
}

start().catch((err) => {
  console.error('Failed to start control plane:', err)
  process.exit(1)
})
