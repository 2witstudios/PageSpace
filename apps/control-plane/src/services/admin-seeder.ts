import { randomBytes } from 'crypto'
import { hash as bcryptHash } from 'bcryptjs'

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
  temporaryPassword?: string
  alreadyExisted: boolean
}

type BcryptLike = {
  hash(data: string, saltRounds: number): Promise<string>
}

type AdminSeederDeps = {
  bcrypt?: BcryptLike
  generatePassword?: () => string
  connect: (databaseUrl: string) => Promise<TenantDbConnection>
}

function defaultGeneratePassword(): string {
  return randomBytes(16).toString('base64url')
}

export function createAdminSeeder(deps: AdminSeederDeps) {
  const bcrypt = deps.bcrypt ?? { hash: bcryptHash }
  const generatePassword = deps.generatePassword ?? defaultGeneratePassword

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

        const temporaryPassword = generatePassword()
        const hashedPassword = await bcrypt.hash(temporaryPassword, 12)

        await db.query(
          'INSERT INTO users (email, password, role, name) VALUES ($1, $2, $3, $4) RETURNING id, email, role',
          [input.ownerEmail, hashedPassword, 'admin', 'Admin']
        )

        return { email: input.ownerEmail, temporaryPassword, alreadyExisted: false }
      } finally {
        await db.end()
      }
    },
  }
}
