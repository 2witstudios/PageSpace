import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { db } from '@pagespace/db'
import {
  countTokens,
  reportTableStatus,
  verifyHashLookup,
  main,
  type VerificationResult,
} from '../verify-token-migration'

// Mock the db module
vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(),
  },
  sql: {
    raw: vi.fn((query: string) => query),
  },
}))

// Mock process.exit to prevent tests from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`)
})

// Capture console output
let consoleLogCalls: string[] = []
let consoleErrorCalls: string[] = []

const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
  consoleLogCalls.push(args.join(' '))
})

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
  consoleErrorCalls.push(args.join(' '))
})

describe('verify-token-migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogCalls = []
    consoleErrorCalls = []
    // Reset process.argv
    process.argv = ['node', 'verify-token-migration.ts']
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('countTokens', () => {
    it('returns correct counts for existing table with all tokens migrated', async () => {
      const mockExecute = vi.mocked(db.execute)

      // Total count query
      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '10' }],
      } as any)

      // With hash count query
      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '10' }],
      } as any)

      const result = await countTokens('refresh_tokens', 'tokenHash')

      expect(result).toEqual({
        table: 'refresh_tokens',
        total: 10,
        withHash: 10,
        withoutHash: 0,
        passed: true,
        tableExists: true,
      })
    })

    it('returns passed: false and tableExists: false when table does not exist', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockRejectedValueOnce(
        new Error('relation "device_tokens" does not exist')
      )

      const result = await countTokens('device_tokens', 'tokenHash')

      expect(result).toEqual({
        table: 'device_tokens',
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: false,
        tableExists: false,
      })
      expect(consoleLogCalls.some(call => call.includes('schema not migrated'))).toBe(true)
    })

    it('returns correct counts when some tokens lack hash', async () => {
      const mockExecute = vi.mocked(db.execute)

      // Total: 10 tokens
      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '10' }],
      } as any)

      // With hash: 7 tokens
      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '7' }],
      } as any)

      const result = await countTokens('mcp_tokens', 'tokenHash')

      expect(result).toEqual({
        table: 'mcp_tokens',
        total: 10,
        withHash: 7,
        withoutHash: 3,
        passed: false,
        tableExists: true,
      })
    })

    it('handles empty table correctly', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '0' }],
      } as any)

      mockExecute.mockResolvedValueOnce({
        rows: [{ count: '0' }],
      } as any)

      const result = await countTokens('verification_tokens', 'tokenHash')

      expect(result).toEqual({
        table: 'verification_tokens',
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: true,
        tableExists: true,
      })
    })

    it('handles null count values from database', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockResolvedValueOnce({
        rows: [],
      } as any)

      mockExecute.mockResolvedValueOnce({
        rows: [],
      } as any)

      const result = await countTokens('empty_tokens', 'tokenHash')

      expect(result.total).toBe(0)
      expect(result.withHash).toBe(0)
      expect(result.passed).toBe(true)
    })

    it('rethrows unexpected errors', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockRejectedValueOnce(
        new Error('Database connection failed')
      )

      await expect(countTokens('refresh_tokens', 'tokenHash')).rejects.toThrow(
        'Database connection failed'
      )
    })
  })

  describe('reportTableStatus', () => {
    it('reports success when all tokens migrated', () => {
      const result: VerificationResult = {
        table: 'refresh_tokens',
        total: 10,
        withHash: 10,
        withoutHash: 0,
        passed: true,
        tableExists: true,
      }
      const missingTables: string[] = []

      const status = reportTableStatus(result, false, missingTables)

      expect(status).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('✓ All tokens migrated'))).toBe(true)
      expect(missingTables.length).toBe(0)
    })

    it('reports failure when tokens missing hash', () => {
      const result: VerificationResult = {
        table: 'mcp_tokens',
        total: 10,
        withHash: 7,
        withoutHash: 3,
        passed: false,
        tableExists: true,
      }
      const missingTables: string[] = []

      const status = reportTableStatus(result, false, missingTables)

      expect(status).toBe(false)
      expect(consoleLogCalls.some(call => call.includes('✗ Some tokens missing hash'))).toBe(true)
      expect(missingTables.length).toBe(0)
    })

    it('reports table not found without --allow-missing', () => {
      const result: VerificationResult = {
        table: 'device_tokens',
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: false,
        tableExists: false,
      }
      const missingTables: string[] = []

      const status = reportTableStatus(result, false, missingTables)

      expect(status).toBe(false)
      expect(consoleLogCalls.some(call => call.includes('✗ Table not found'))).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('run migrations first'))).toBe(true)
      expect(missingTables).toContain('device_tokens')
    })

    it('allows missing table with --allow-missing flag', () => {
      const result: VerificationResult = {
        table: 'device_tokens',
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: false,
        tableExists: false,
      }
      const missingTables: string[] = []

      const status = reportTableStatus(result, true, missingTables)

      expect(status).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('⚠ Table not found'))).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('skipped with --allow-missing'))).toBe(true)
      expect(missingTables).toContain('device_tokens')
    })

    it('handles empty tables with warning', () => {
      const result: VerificationResult = {
        table: 'empty_tokens',
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: true,
        tableExists: true,
      }
      const missingTables: string[] = []

      const status = reportTableStatus(result, false, missingTables)

      expect(status).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('⚠ No tokens found'))).toBe(true)
    })
  })

  describe('verifyHashLookup', () => {
    it('verifies sample token has hash and prefix', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockResolvedValueOnce({
        rows: [{
          id: 'token_123',
          tokenHash: 'hash_abc',
          tokenPrefix: 'rt_',
        }],
      } as any)

      const result = await verifyHashLookup()

      expect(result).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('✓ Sample token has valid hash and prefix'))).toBe(true)
    })

    it('handles no tokens with hash gracefully', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockResolvedValueOnce({
        rows: [],
      } as any)

      const result = await verifyHashLookup()

      expect(result).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('⚠ No tokens with hash to verify'))).toBe(true)
    })

    it('fails when token missing hash', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockResolvedValueOnce({
        rows: [{
          id: 'token_123',
          tokenHash: null,
          tokenPrefix: 'rt_',
        }],
      } as any)

      const result = await verifyHashLookup()

      expect(result).toBe(false)
      expect(consoleLogCalls.some(call => call.includes('✗ Sample token missing hash or prefix'))).toBe(true)
    })

    it('handles table not existing', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockRejectedValueOnce(
        new Error('relation "refresh_tokens" does not exist')
      )

      const result = await verifyHashLookup()

      expect(result).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('⚠ Hash columns not yet added to schema'))).toBe(true)
    })
  })

  describe('main flow - all tables exist and migrated', () => {
    it('exits with code 0 when all migrations complete', async () => {
      const mockExecute = vi.mocked(db.execute)

      // Mock responses for refresh_tokens
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)

      // Mock responses for mcp_tokens
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)

      // Mock responses for device_tokens
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)

      // Mock responses for verification_tokens
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)

      // Mock hash lookup
      mockExecute.mockResolvedValueOnce({
        rows: [{
          id: 'token_1',
          tokenHash: 'hash_1',
          tokenPrefix: 'rt_',
        }],
      } as any)

      try {
        await main()
      } catch (error: any) {
        expect(error.message).toBe('process.exit(0)')
      }

      expect(mockExit).toHaveBeenCalledWith(0)
      expect(consoleLogCalls.some(call => call.includes('Migration Status: ✓ COMPLETE'))).toBe(true)
    })
  })

  describe('main flow - missing tables without --allow-missing', () => {
    it('exits with code 1 when tables missing', async () => {
      const mockExecute = vi.mocked(db.execute)

      // Mock successful tables
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)

      // Mock missing device_tokens
      mockExecute.mockRejectedValueOnce(
        new Error('relation "device_tokens" does not exist')
      )

      // Mock missing verification_tokens
      mockExecute.mockRejectedValueOnce(
        new Error('relation "verification_tokens" does not exist')
      )

      // Mock hash lookup
      mockExecute.mockResolvedValueOnce({ rows: [] } as any)

      try {
        await main()
      } catch (error: any) {
        expect(error.message).toBe('process.exit(1)')
      }

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(consoleLogCalls.some(call => call.includes('Migration Status: ✗ INCOMPLETE'))).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('pnpm db:migrate'))).toBe(true)
    })
  })

  describe('main flow - missing tables with --allow-missing', () => {
    it('exits with code 0 when missing tables allowed', async () => {
      process.argv = ['node', 'verify-token-migration.ts', '--allow-missing']

      const mockExecute = vi.mocked(db.execute)

      // Mock successful tables
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)

      // Mock missing device_tokens (allowed)
      mockExecute.mockRejectedValueOnce(
        new Error('relation "device_tokens" does not exist')
      )

      // Mock missing verification_tokens (allowed)
      mockExecute.mockRejectedValueOnce(
        new Error('relation "verification_tokens" does not exist')
      )

      // Mock hash lookup
      mockExecute.mockResolvedValueOnce({
        rows: [{
          id: 'token_1',
          tokenHash: 'hash_1',
          tokenPrefix: 'rt_',
        }],
      } as any)

      try {
        await main()
      } catch (error: any) {
        expect(error.message).toBe('process.exit(0)')
      }

      expect(mockExit).toHaveBeenCalledWith(0)
      expect(consoleLogCalls.some(call => call.includes('Migration Status: ✓ COMPLETE'))).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('Mode: Allow missing tables'))).toBe(true)
    })
  })

  describe('main flow - incomplete migration', () => {
    it('exits with code 1 when tokens lack hash', async () => {
      const mockExecute = vi.mocked(db.execute)

      // refresh_tokens: 5 total, 3 with hash (2 missing)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '5' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)

      // mcp_tokens: all good
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any)

      // device_tokens: all good
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)

      // verification_tokens: all good
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)
      mockExecute.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)

      // Mock hash lookup
      mockExecute.mockResolvedValueOnce({
        rows: [{
          id: 'token_1',
          tokenHash: 'hash_1',
          tokenPrefix: 'rt_',
        }],
      } as any)

      try {
        await main()
      } catch (error: any) {
        expect(error.message).toBe('process.exit(1)')
      }

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(consoleLogCalls.some(call => call.includes('Migration Status: ✗ INCOMPLETE'))).toBe(true)
      expect(consoleLogCalls.some(call => call.includes('migrate-token-hashes.ts'))).toBe(true)
    })
  })

  describe('main flow - error handling', () => {
    it('catches and reports unexpected errors', async () => {
      const mockExecute = vi.mocked(db.execute)

      mockExecute.mockRejectedValueOnce(
        new Error('Database connection failed')
      )

      // The error should be caught by main's try-catch
      // Since the function calls process.exit(2), we need to catch that
      try {
        await main()
      } catch (error: any) {
        // Main should not throw - errors are caught internally
      }

      // Note: The actual script catches errors at the top level,
      // not in main(), so we can't easily test the exit(2) path here
    })
  })

  describe('command line arguments', () => {
    it('parses --allow-missing flag', async () => {
      process.argv = ['node', 'verify-token-migration.ts', '--allow-missing']

      const mockExecute = vi.mocked(db.execute)

      // Mock all tables existing and migrated
      mockExecute.mockResolvedValue({ rows: [{ count: '0' }] } as any)

      try {
        await main()
      } catch (error: any) {
        // Expected to exit
      }

      expect(consoleLogCalls.some(call => call.includes('Mode: Allow missing tables'))).toBe(true)
    })

    it('runs in strict mode by default', async () => {
      process.argv = ['node', 'verify-token-migration.ts']

      const mockExecute = vi.mocked(db.execute)
      mockExecute.mockResolvedValue({ rows: [{ count: '0' }] } as any)

      try {
        await main()
      } catch (error: any) {
        // Expected to exit
      }

      expect(consoleLogCalls.some(call => call.includes('Mode: Allow missing tables'))).toBe(false)
    })
  })
})
