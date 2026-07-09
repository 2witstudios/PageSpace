import { createId } from '@paralleldrive/cuid2'
import {
  prepareUserWrite,
  getUserIndexKey,
  userEmailLookupTargets,
} from '@pagespace/lib/auth/user-repository'

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
        const email = input.ownerEmail.toLowerCase().trim()

        // Look up by blind index first (the canonical email key), falling back
        // to the plaintext `email` column for the no-key / not-yet-encrypted
        // rollout state. Mirrors `buildUserEmailMatch` in the web app so a
        // ciphertext-stored email is still found here.
        const lookup = userEmailLookupTargets(email, getUserIndexKey())
        const existing = lookup.emailBidx
          ? await db.query(
              'SELECT id FROM users WHERE "emailBidx" = $1 OR email = $2 LIMIT 1',
              [lookup.emailBidx, lookup.email]
            )
          : await db.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [lookup.email])

        if (existing.length > 0) {
          return { email, alreadyExisted: true }
        }

        // Route through the shared write preparer so the seeded admin gets a
        // blind-index (`emailBidx`) and PII encryption consistent with every
        // other user-create site. Passwordless by design — the admin enrolls a
        // passkey or uses a magic link on first sign-in. Degrades to plaintext
        // + no emailBidx when the encryption env is absent.
        const values = await prepareUserWrite({
          id: createId(),
          email,
          name: 'Admin',
          role: 'admin' as const,
          emailVerified: new Date(),
        })

        await db.query(
          `INSERT INTO users (id, email, name, role, "emailBidx", "emailVerified")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            values.id,
            values.email,
            values.name,
            values.role,
            values.emailBidx ?? null,
            values.emailVerified,
          ]
        )

        return { email, alreadyExisted: false }
      } finally {
        await db.end()
      }
    },
  }
}
