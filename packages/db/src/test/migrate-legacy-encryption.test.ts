/**
 * Tests for the legacy encryption migration script.
 *
 * Verifies that the migration script correctly:
 * - Identifies legacy format entries
 * - Runs in dry-run mode without modifying data
 * - Reports accurate counts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { scrypt, randomBytes, createCipheriv } from 'crypto'
import { promisify } from 'util'
import { db } from '../index'
import { userAiSettings } from '../schema/ai'
import { factories } from './factories'
import { createId } from '@paralleldrive/cuid2'
import { migrateLegacyEncryption } from '../../scripts/migrate-legacy-encryption'
import { encrypt, isLegacyFormat } from '../../../lib/src/encryption'

const scryptAsync = promisify(scrypt)

/**
 * Helper function to create legacy-format encrypted data for testing.
 * This mimics the old encryption format: "iv:authTag:ciphertext" (3-part format)
 */
async function createLegacyEncrypted(text: string): Promise<string> {
  const ALGORITHM = 'aes-256-gcm'
  const IV_LENGTH = 16
  const KEY_LENGTH = 32

  const masterKey = process.env.ENCRYPTION_KEY!
  const legacySalt = process.env.ENCRYPTION_SALT || 'a-secure-static-salt-for-everyone'

  const iv = randomBytes(IV_LENGTH)
  const key = (await scryptAsync(masterKey, legacySalt, KEY_LENGTH)) as Buffer
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

describe('migrate-legacy-encryption script', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>

  beforeEach(async () => {
    // Create a test user for AI settings
    testUser = await factories.createUser({
      email: 'testuser@example.com',
      name: 'Test User',
    })
  })

  afterEach(async () => {
    // Clean up test data - user_ai_settings will cascade with users
    await db.execute(sql`TRUNCATE TABLE user_ai_settings, chat_messages, page_permissions, pages, drive_members, drives, users CASCADE`)
  })

  describe('dry-run mode', () => {
    it('should identify legacy entries without modifying data', async () => {
      // Create legacy format encrypted API keys
      const legacyApiKey1 = await createLegacyEncrypted('sk-test-api-key-1234567890')
      const legacyApiKey2 = await createLegacyEncrypted('sk-another-api-key-abcdef')

      // Verify these are legacy format
      expect(isLegacyFormat(legacyApiKey1)).toBe(true)
      expect(isLegacyFormat(legacyApiKey2)).toBe(true)

      // Insert legacy format entries
      const entry1Id = createId()
      const entry2Id = createId()

      await db.insert(userAiSettings).values([
        {
          id: entry1Id,
          userId: testUser.id,
          provider: 'openai',
          encryptedApiKey: legacyApiKey1,
        },
        {
          id: entry2Id,
          userId: testUser.id,
          provider: 'anthropic',
          encryptedApiKey: legacyApiKey2,
        },
      ])

      // Run migration in dry-run mode
      const stats = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      // Verify correct counts reported
      expect(stats.total).toBe(2)
      expect(stats.legacy).toBe(2)
      expect(stats.migrated).toBe(2) // Would migrate count
      expect(stats.skipped).toBe(0)
      expect(stats.errors).toBe(0)

      // Verify entries were NOT modified
      const entriesAfter = await db
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, testUser.id))

      expect(entriesAfter).toHaveLength(2)

      const entry1After = entriesAfter.find(e => e.id === entry1Id)
      const entry2After = entriesAfter.find(e => e.id === entry2Id)

      // Encrypted keys should remain unchanged (still legacy format)
      expect(entry1After?.encryptedApiKey).toBe(legacyApiKey1)
      expect(entry2After?.encryptedApiKey).toBe(legacyApiKey2)

      // Verify they are still legacy format
      expect(isLegacyFormat(entry1After!.encryptedApiKey!)).toBe(true)
      expect(isLegacyFormat(entry2After!.encryptedApiKey!)).toBe(true)
    })

    it('should correctly distinguish between legacy and current format entries', async () => {
      // Create one legacy and one current format entry
      const legacyApiKey = await createLegacyEncrypted('sk-legacy-key-12345')
      const currentApiKey = await encrypt('sk-current-key-67890')

      // Verify formats
      expect(isLegacyFormat(legacyApiKey)).toBe(true)
      expect(isLegacyFormat(currentApiKey)).toBe(false)

      const legacyEntryId = createId()
      const currentEntryId = createId()

      await db.insert(userAiSettings).values([
        {
          id: legacyEntryId,
          userId: testUser.id,
          provider: 'openai',
          encryptedApiKey: legacyApiKey,
        },
        {
          id: currentEntryId,
          userId: testUser.id,
          provider: 'anthropic',
          encryptedApiKey: currentApiKey,
        },
      ])

      // Run migration in dry-run mode
      const stats = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      // Verify correct counts
      expect(stats.total).toBe(2)
      expect(stats.legacy).toBe(1)
      expect(stats.migrated).toBe(1) // Only legacy entry would be migrated
      expect(stats.skipped).toBe(0)
      expect(stats.errors).toBe(0)

      // Verify both entries remain unchanged
      const entriesAfter = await db
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, testUser.id))

      const legacyEntryAfter = entriesAfter.find(e => e.id === legacyEntryId)
      const currentEntryAfter = entriesAfter.find(e => e.id === currentEntryId)

      expect(legacyEntryAfter?.encryptedApiKey).toBe(legacyApiKey)
      expect(currentEntryAfter?.encryptedApiKey).toBe(currentApiKey)
    })

    it('should report zero legacy entries when all entries use current format', async () => {
      // Create only current format entries
      const currentApiKey1 = await encrypt('sk-current-key-1')
      const currentApiKey2 = await encrypt('sk-current-key-2')

      await db.insert(userAiSettings).values([
        {
          id: createId(),
          userId: testUser.id,
          provider: 'openai',
          encryptedApiKey: currentApiKey1,
        },
        {
          id: createId(),
          userId: testUser.id,
          provider: 'anthropic',
          encryptedApiKey: currentApiKey2,
        },
      ])

      // Run migration in dry-run mode
      const stats = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      expect(stats.total).toBe(2)
      expect(stats.legacy).toBe(0)
      expect(stats.migrated).toBe(0)
      expect(stats.skipped).toBe(0)
      expect(stats.errors).toBe(0)
    })

    it('should handle empty database gracefully', async () => {
      // No entries in the database
      const stats = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      expect(stats.total).toBe(0)
      expect(stats.legacy).toBe(0)
      expect(stats.migrated).toBe(0)
      expect(stats.skipped).toBe(0)
      expect(stats.errors).toBe(0)
    })

    it('should handle entries with null encryptedApiKey', async () => {
      // Create entry without encrypted API key (e.g., Ollama uses baseUrl instead)
      await db.insert(userAiSettings).values({
        id: createId(),
        userId: testUser.id,
        provider: 'ollama',
        encryptedApiKey: null,
        baseUrl: 'http://localhost:11434',
      })

      // Also add a legacy entry
      const legacyApiKey = await createLegacyEncrypted('sk-legacy-key')
      await db.insert(userAiSettings).values({
        id: createId(),
        userId: testUser.id,
        provider: 'openai',
        encryptedApiKey: legacyApiKey,
      })

      const stats = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      expect(stats.total).toBe(2)
      expect(stats.legacy).toBe(1) // Only the OpenAI entry with legacy format
      expect(stats.migrated).toBe(1)
    })
  })

  describe('live migration vs dry-run comparison', () => {
    it('should modify entries in live mode but not in dry-run', async () => {
      // Create a legacy entry
      const legacyApiKey = await createLegacyEncrypted('sk-test-key-for-comparison')
      const entryId = createId()

      await db.insert(userAiSettings).values({
        id: entryId,
        userId: testUser.id,
        provider: 'openai',
        encryptedApiKey: legacyApiKey,
      })

      // First, verify dry-run doesn't modify
      await migrateLegacyEncryption({ dryRun: true, quiet: true })

      const afterDryRun = await db
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.id, entryId))

      expect(afterDryRun[0].encryptedApiKey).toBe(legacyApiKey)
      expect(isLegacyFormat(afterDryRun[0].encryptedApiKey!)).toBe(true)

      // Now run live migration
      const stats = await migrateLegacyEncryption({ dryRun: false, quiet: true })

      expect(stats.migrated).toBe(1)

      // Verify entry was modified
      const afterLive = await db
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.id, entryId))

      expect(afterLive[0].encryptedApiKey).not.toBe(legacyApiKey)
      expect(isLegacyFormat(afterLive[0].encryptedApiKey!)).toBe(false)

      // Verify it's now 4-part format
      const parts = afterLive[0].encryptedApiKey!.split(':')
      expect(parts.length).toBe(4)
    })
  })

  describe('idempotency', () => {
    it('should be safe to run dry-run multiple times', async () => {
      const legacyApiKey = await createLegacyEncrypted('sk-idempotent-test-key')
      const entryId = createId()

      await db.insert(userAiSettings).values({
        id: entryId,
        userId: testUser.id,
        provider: 'openai',
        encryptedApiKey: legacyApiKey,
      })

      // Run dry-run multiple times
      const stats1 = await migrateLegacyEncryption({ dryRun: true, quiet: true })
      const stats2 = await migrateLegacyEncryption({ dryRun: true, quiet: true })
      const stats3 = await migrateLegacyEncryption({ dryRun: true, quiet: true })

      // All runs should report the same counts
      expect(stats1).toEqual(stats2)
      expect(stats2).toEqual(stats3)

      // Entry should remain unchanged
      const entry = await db
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.id, entryId))

      expect(entry[0].encryptedApiKey).toBe(legacyApiKey)
    })
  })
})
