import { beforeAll, afterAll } from 'vitest'

// Encryption environment variables
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-required-length'

beforeAll(async () => {
  // Test database should be running
  console.log('Test database ready')
})

// NOTE: Global afterEach cleanup removed intentionally.
// Each test file has its own cleanup in afterEach to properly handle its specific data.
// A global truncate was causing FK constraint failures in @pagespace/lib tests
// because Turbo runs tests for different packages in parallel, and the global
// truncate was deleting users that lib tests had just created.

afterAll(async () => {
  // Close database connection
  console.log('Test suite completed')
})