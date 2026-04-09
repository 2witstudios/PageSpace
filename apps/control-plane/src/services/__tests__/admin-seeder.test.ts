import { describe, test, expect, vi } from 'vitest'
import { createAdminSeeder, type TenantDbConnection } from '../admin-seeder'

function makeMockDb(existingUser: Record<string, unknown> | null = null): TenantDbConnection {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT')) {
        return existingUser ? [existingUser] : []
      }
      if (sql.includes('INSERT')) {
        return [{ id: 'new-user-id', email: 'owner@test.com', role: 'admin' }]
      }
      return []
    }),
    end: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockDbConnector(db: TenantDbConnection) {
  return vi.fn().mockResolvedValue(db)
}

describe('AdminSeeder', () => {
  describe('seed admin user', () => {
    test('given a newly provisioned tenant, should create admin user with owner email', async () => {
      const db = makeMockDb(null)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      const result = await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(result.email).toBe('owner@acme.com')
      expect(result.alreadyExisted).toBe(false)
    })

    test('given a new user, should insert into db without password', async () => {
      const db = makeMockDb(null)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      const insertCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('INSERT')
      )
      expect(insertCall).toBeDefined()
      expect(insertCall![0]).not.toContain('password')
      expect(insertCall![1]).toHaveLength(4) // id, email, role, name
    })

    test('given the seeder, should connect using the tenant database URL', async () => {
      const db = makeMockDb(null)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(connect).toHaveBeenCalledWith('postgres://localhost/ps_acme')
    })

    test('given the seeder, should close the db connection after seeding', async () => {
      const db = makeMockDb(null)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(db.end).toHaveBeenCalled()
    })
  })

  describe('CUID2 id generation', () => {
    test('given a new user, should include id column in INSERT with a generated CUID2', async () => {
      const db = makeMockDb(null)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      const insertCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('INSERT')
      )
      expect(insertCall![0]).toContain('id')
      expect(insertCall![1]).toHaveLength(4) // id, email, role, name
      expect(typeof insertCall![1][0]).toBe('string')
      expect(insertCall![1][0].length).toBeGreaterThan(0)
    })
  })

  describe('idempotent seeding', () => {
    test('given an existing user with that email, should skip insert and return existing info', async () => {
      const existingUser = { id: 'existing-id', email: 'owner@acme.com', role: 'admin' }
      const db = makeMockDb(existingUser)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      const result = await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(result.email).toBe('owner@acme.com')
      expect(result.alreadyExisted).toBe(true)
    })

    test('given an existing user, should not call db insert', async () => {
      const existingUser = { id: 'existing-id', email: 'owner@acme.com', role: 'admin' }
      const db = makeMockDb(existingUser)
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      const insertCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('INSERT')
      )
      expect(insertCall).toBeUndefined()
    })
  })

  describe('error handling', () => {
    test('given a db connection failure, should still attempt to close connection', async () => {
      const db = makeMockDb(null)
      ;(db.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection refused'))
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ connect })

      await expect(seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })).rejects.toThrow('connection refused')

      expect(db.end).toHaveBeenCalled()
    })
  })
})
