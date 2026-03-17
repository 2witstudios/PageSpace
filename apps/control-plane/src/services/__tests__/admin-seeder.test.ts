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

function makeMockBcrypt(hash = '$2a$12$hashedpassword') {
  return {
    hash: vi.fn().mockResolvedValue(hash),
  }
}

function makeMockPasswordGenerator(password = 'TempPass123!') {
  return vi.fn().mockReturnValue(password)
}

function makeMockDbConnector(db: TenantDbConnection) {
  return vi.fn().mockResolvedValue(db)
}

describe('AdminSeeder', () => {
  describe('seed admin user', () => {
    test('given a newly provisioned tenant, should create admin user with owner email', async () => {
      const db = makeMockDb(null)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator('TempPass123!')
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      const result = await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(result.email).toBe('owner@acme.com')
      expect(result.temporaryPassword).toBe('TempPass123!')
    })

    test('given a new user, should hash password with bcrypt using 12 salt rounds', async () => {
      const db = makeMockDb(null)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator('MyPass!')
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(bcrypt.hash).toHaveBeenCalledWith('MyPass!', 12)
    })

    test('given a new user, should insert into db with hashed password', async () => {
      const db = makeMockDb(null)
      const bcrypt = makeMockBcrypt('$2a$12$hashed')
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      const insertCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('INSERT')
      )
      expect(insertCall).toBeDefined()
      expect(insertCall![1]).toContain('$2a$12$hashed')
    })

    test('given the seeder, should connect using the tenant database URL', async () => {
      const db = makeMockDb(null)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(connect).toHaveBeenCalledWith('postgres://localhost/ps_acme')
    })

    test('given the seeder, should close the db connection after seeding', async () => {
      const db = makeMockDb(null)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(db.end).toHaveBeenCalled()
    })
  })

  describe('idempotent seeding', () => {
    test('given an existing user with that email, should skip insert and return existing info', async () => {
      const existingUser = { id: 'existing-id', email: 'owner@acme.com', role: 'admin' }
      const db = makeMockDb(existingUser)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      const result = await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(result.email).toBe('owner@acme.com')
      expect(result.alreadyExisted).toBe(true)
    })

    test('given an existing user, should not call bcrypt hash', async () => {
      const existingUser = { id: 'existing-id', email: 'owner@acme.com', role: 'admin' }
      const db = makeMockDb(existingUser)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })

      expect(bcrypt.hash).not.toHaveBeenCalled()
    })

    test('given an existing user, should not call db insert', async () => {
      const existingUser = { id: 'existing-id', email: 'owner@acme.com', role: 'admin' }
      const db = makeMockDb(existingUser)
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

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
      const bcrypt = makeMockBcrypt()
      const generatePassword = makeMockPasswordGenerator()
      const connect = makeMockDbConnector(db)
      const seeder = createAdminSeeder({ bcrypt, generatePassword, connect })

      await expect(seeder.seed({
        slug: 'acme',
        ownerEmail: 'owner@acme.com',
        databaseUrl: 'postgres://localhost/ps_acme',
      })).rejects.toThrow('connection refused')

      expect(db.end).toHaveBeenCalled()
    })
  })
})
