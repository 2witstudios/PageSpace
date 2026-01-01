import { beforeAll, afterAll, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../index'

// Encryption environment variables (required for migration tests)
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-required-length'
process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'test-encryption-salt-for-backward-compatibility'

beforeAll(async () => {
  // Test database should be running
  console.log('Test database ready')
})

afterEach(async () => {
  // Clean up test data after each test
  await db.execute(sql`TRUNCATE TABLE chat_messages, page_permissions, pages, drives, users CASCADE`)
})

afterAll(async () => {
  // Close database connection
  console.log('Test suite completed')
})