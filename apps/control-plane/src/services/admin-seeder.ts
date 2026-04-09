import { createId } from '@paralleldrive/cuid2'

export type TenantDbConnection = {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
  end(): Promise<void>
}

export type SeedInput = {
  slug: string
  ownerEmail: string
  databaseUrl: string
}

export type SeedResult = {
  email: string
  alreadyExisted: boolean
}

type AdminSeederDeps = {
  connect: (databaseUrl: string) => Promise<TenantDbConnection>
}

export function createAdminSeeder(deps: AdminSeederDeps) {
  return {
    async seed(input: SeedInput): Promise<SeedResult> {
      const db = await deps.connect(input.databaseUrl)
      try {
        const existing = await db.query(
          'SELECT id, email FROM users WHERE email = $1 LIMIT 1',
          [input.ownerEmail]
        )

        if (existing.length > 0) {
          return { email: input.ownerEmail, alreadyExisted: true }
        }

        const id = createId()

        await db.query(
          'INSERT INTO users (id, email, role, name) VALUES ($1, $2, $3, $4) RETURNING id, email, role',
          [id, input.ownerEmail, 'admin', 'Admin']
        )

        return { email: input.ownerEmail, alreadyExisted: false }
      } finally {
        await db.end()
      }
    },
  }
}
