import { beforeAll, afterAll, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../index'

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