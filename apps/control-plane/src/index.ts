import { createApp } from './app'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import Stripe from 'stripe'
import { createTenantRepository, type TenantDb } from './repositories/tenant-repository'
import { createProvisioningEngine, createTenantLifecycle, createShellExecutor, createAdminSeeder } from './services'
import { mkdir, writeFile, readFile } from 'node:fs/promises'

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

  const fsAdapter = {
    async mkdir(path: string, options?: { recursive?: boolean }) {
      await mkdir(path, options)
    },
    writeFile,
    readFile: (path: string) => readFile(path, 'utf-8'),
  }

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

  async function pollHealth(slug: string): Promise<{ healthy: boolean }> {
    const maxAttempts = 30
    const delayMs = 2000
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://ps-${slug}-web:3000/api/health`, {
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) return { healthy: true }
      } catch {
        // Service not ready yet
      }
      await new Promise((r) => setTimeout(r, delayMs))
    }
    return { healthy: false }
  }

  const provisioningEngine = createProvisioningEngine({
    repo, executor, fs: fsAdapter, seeder, pollHealth,
    basePath, scriptsPath, composePath,
  })

  const lifecycle = createTenantLifecycle({
    repo, executor, pollHealth,
    composePath, basePath,
  })

  // Stripe client — optional, only if STRIPE_SECRET_KEY is configured
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  const stripe = stripeSecretKey
    ? new Stripe(stripeSecretKey, { apiVersion: '2025-12-15.clover' })
    : undefined

  // Map tier names to real Stripe price IDs from environment
  const priceMap: Record<string, string> = {}
  if (process.env.STRIPE_PRICE_FREE) priceMap.free = process.env.STRIPE_PRICE_FREE
  if (process.env.STRIPE_PRICE_PRO) priceMap.pro = process.env.STRIPE_PRICE_PRO
  if (process.env.STRIPE_PRICE_BUSINESS) priceMap.business = process.env.STRIPE_PRICE_BUSINESS
  if (process.env.STRIPE_PRICE_ENTERPRISE) priceMap.enterprise = process.env.STRIPE_PRICE_ENTERPRISE

  const app = createApp({
    logger: true,
    repo,
    provisioningEngine,
    lifecycle,
    stripe,
    priceMap,
  })

  // Verify database connectivity before accepting traffic
  await sql`SELECT 1`

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Control plane listening on port ${PORT}`)
}

start().catch((err) => {
  console.error('Failed to start control plane:', err)
  process.exit(1)
})
