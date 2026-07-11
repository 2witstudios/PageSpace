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
        const email = input.ownerEmail.toLowerCase().trim()

        // Seed PLAINTEXT deliberately, and do NOT compute `emailBidx` here.
        //
        // This runs in the control-plane process but writes into the *tenant*
        // database, whose `ENCRYPTION_KEY` is generated per-tenant and lives in
        // the tenant web service — the control-plane doesn't have it. Deriving a
        // blind index / ciphertext from the control-plane's own env would write
        // values keyed to the wrong key, and the tenant app could then neither
        // match by `emailBidx` nor decrypt the email (silent admin lockout).
        // Plaintext + NULL `emailBidx` is safe: the tenant app's dual-lookup
        // (`buildUserEmailMatch`) falls back to the plaintext `email` column, and
        // it (re)computes `emailBidx`/ciphertext with the correct tenant key on
        // the next write to this user. Passwordless by design — the admin enrolls
        // a passkey or uses a magic link on first sign-in.
        // Match case-insensitively (`lower(email)`) so re-runs stay idempotent
        // even for tenants whose admin row was seeded before this normalization
        // landed — the old seeder inserted `ownerEmail` verbatim, so a legacy row
        // may hold mixed case (e.g. `Owner@ACME.com`). Postgres `text` equality is
        // case-sensitive, so a plain `email = $1` on the lowercased value would
        // miss that row and insert a duplicate admin.
        const existing = await db.query(
          'SELECT id FROM users WHERE lower(email) = $1 LIMIT 1',
          [email]
        )

        if (existing.length > 0) {
          return { email, alreadyExisted: true }
        }

        await db.query(
          `INSERT INTO users (id, email, name, role, "emailVerified")
           VALUES ($1, $2, $3, $4, $5)`,
          [createId(), email, 'Admin', 'admin', new Date()]
        )

        return { email, alreadyExisted: false }
      } finally {
        await db.end()
      }
    },
  }
}
