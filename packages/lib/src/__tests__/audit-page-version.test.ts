/**
 * Unit tests for page versioning
 *
 * Tests the create-page-version module which handles page snapshots and version history.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import {
  createPageVersion,
  getPageVersions,
  getPageVersion,
  getLatestPageVersion,
  comparePageVersions,
  restorePageVersion,
  getPageVersionStats,
} from '../audit/create-page-version'
import { createAuditEvent } from '../audit/create-audit-event'
import { factories } from '@pagespace/db/test/factories'
import { db, users, pages, eq } from '@pagespace/db'

describe('createPageVersion', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id, {
      content: 'Initial content',
      title: 'Initial title',
    })
  })

  test('with basic page snapshot', async () => {
    const given = 'valid page ID and user ID'
    const should = 'create first version snapshot'

    const actual = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      changeSummary: 'Initial version',
      changeType: 'user_edit',
    })

    expect(actual).toMatchObject({
      pageId: testPage.id,
      versionNumber: 1,
      title: testPage.title,
      pageType: testPage.type,
      createdBy: testUser.id,
      isAiGenerated: false,
      changeSummary: 'Initial version',
      changeType: 'user_edit',
    })
    expect(actual.content).toBeTruthy()
    expect(actual.contentSize).toBeGreaterThan(0)
  })

  test('with sequential versions', async () => {
    const given = 'multiple versions created in sequence'
    const should = 'increment version number for each snapshot'

    const v1 = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    const v2 = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    const v3 = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    expect(v1.versionNumber).toBe(1)
    expect(v2.versionNumber).toBe(2)
    expect(v3.versionNumber).toBe(3)
  })

  test('with AI-generated version', async () => {
    const given = 'AI-generated page version'
    const should = 'mark version as AI-generated'

    const actual = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      isAiGenerated: true,
      changeSummary: 'AI improved content',
      changeType: 'ai_edit',
    })

    expect(actual.isAiGenerated).toBe(true)
    expect(actual.changeType).toBe('ai_edit')
  })

  test('with audit event link', async () => {
    const given = 'version created with audit event reference'
    const should = 'link version to audit event'

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      auditEventId: auditEvent.id,
    })

    expect(actual.auditEventId).toBe(auditEvent.id)
  })

  test('with page metadata snapshot', async () => {
    const given = 'page with AI configuration and file metadata'
    const should = 'snapshot all metadata fields'

    // Create page with metadata
    const pageWithMeta = await factories.createPage(testDrive.id, {
      aiProvider: 'openai',
      aiModel: 'gpt-4',
      systemPrompt: 'You are a helpful assistant',
      enabledTools: ['search', 'calculator'],
    })

    const actual = await createPageVersion({
      pageId: pageWithMeta.id,
      userId: testUser.id,
    })

    expect(actual.metadata).toMatchObject({
      aiProvider: 'openai',
      aiModel: 'gpt-4',
      systemPrompt: 'You are a helpful assistant',
      enabledTools: ['search', 'calculator'],
    })
  })

  test('with non-existent page', async () => {
    const given = 'non-existent page ID'
    const should = 'throw error'

    await expect(
      createPageVersion({
        pageId: 'non-existent',
        userId: testUser.id,
      })
    ).rejects.toThrow('Page not found')
  })

  test('with major change type', async () => {
    const given = 'version with major change type'
    const should = 'record change type as major'

    const actual = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      changeSummary: 'Complete rewrite',
      changeType: 'major',
    })

    expect(actual.changeType).toBe('major')
  })

  test('with content size calculation', async () => {
    const given = 'page with known content length'
    const should = 'calculate and store content size in bytes'

    const actual = await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    const expectedSize = Buffer.byteLength(testPage.content || '', 'utf8')
    expect(actual.contentSize).toBe(expectedSize)
  })
})

describe('getPageVersions', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with multiple versions', async () => {
    const given = 'page with 3 versions'
    const should = 'return all versions in descending order'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await getPageVersions(testPage.id)

    expect(actual).toHaveLength(3)
    expect(actual[0].versionNumber).toBe(3)
    expect(actual[1].versionNumber).toBe(2)
    expect(actual[2].versionNumber).toBe(1)
  })

  test('with limit parameter', async () => {
    const given = 'page with 5 versions and limit of 3'
    const should = 'return only 3 most recent versions'

    for (let i = 0; i < 5; i++) {
      await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    }

    const actual = await getPageVersions(testPage.id, 3)

    expect(actual).toHaveLength(3)
    expect(actual[0].versionNumber).toBe(5)
    expect(actual[2].versionNumber).toBe(3)
  })

  test('with no versions', async () => {
    const given = 'page with no versions'
    const should = 'return empty array'

    const actual = await getPageVersions(testPage.id)

    expect(actual).toEqual([])
  })

  test('with user and audit event relations', async () => {
    const given = 'version with user and audit event'
    const should = 'include related user and event data'

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      description: 'Test update',
    })

    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      auditEventId: auditEvent.id,
    })

    const actual = await getPageVersions(testPage.id)

    expect(actual[0].createdByUser).toMatchObject({
      id: testUser.id,
      name: testUser.name,
    })
    expect(actual[0].auditEvent).toMatchObject({
      actionType: 'PAGE_UPDATE',
      description: 'Test update',
    })
  })
})

describe('getPageVersion', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with valid version number', async () => {
    const given = 'page with specific version number'
    const should = 'return that version'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    const v3 = await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await getPageVersion(testPage.id, 2)

    expect(actual?.versionNumber).toBe(2)
  })

  test('with non-existent version', async () => {
    const given = 'version number that does not exist'
    const should = 'return null'

    const actual = await getPageVersion(testPage.id, 999)

    expect(actual).toBeNull()
  })
})

describe('getLatestPageVersion', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with multiple versions', async () => {
    const given = 'page with multiple versions'
    const should = 'return highest version number'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    const latest = await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await getLatestPageVersion(testPage.id)

    expect(actual?.versionNumber).toBe(3)
    expect(actual?.id).toBe(latest.id)
  })

  test('with no versions', async () => {
    const given = 'page with no versions'
    const should = 'return null'

    const actual = await getLatestPageVersion(testPage.id)

    expect(actual).toBeNull()
  })
})

describe('comparePageVersions', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with two valid versions', async () => {
    const given = 'two versions to compare'
    const should = 'return both version objects'

    const v1 = await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    const v2 = await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await comparePageVersions(testPage.id, 1, 2)

    expect(actual.from.id).toBe(v1.id)
    expect(actual.to.id).toBe(v2.id)
  })

  test('with non-existent version', async () => {
    const given = 'one version does not exist'
    const should = 'throw error'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    await expect(
      comparePageVersions(testPage.id, 1, 999)
    ).rejects.toThrow('Version not found')
  })
})

describe('restorePageVersion', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id, {
      content: 'Initial content',
      title: 'Initial title',
    })
  })

  test('with valid version', async () => {
    const given = 'valid version to restore'
    const should = 'update page to version content and title'

    // Create first version
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    // Update page
    await db.update(pages).set({
      content: 'Updated content',
      title: 'Updated title',
    }).where(eq(pages.id, testPage.id))

    // Create second version
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    // Restore to version 1
    const actual = await restorePageVersion(testPage.id, 1, testUser.id)

    expect(actual.content).toBe('Initial content')
    expect(actual.title).toBe('Initial title')
  })

  test('with audit event creation', async () => {
    const given = 'version restoration'
    const should = 'create audit event for restoration'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    await db.update(pages).set({
      content: 'Updated content',
    }).where(eq(pages.id, testPage.id))

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    // Restore creates audit event internally
    await restorePageVersion(testPage.id, 1, testUser.id)

    // Verify by checking versions - should have a new version created
    const versions = await getPageVersions(testPage.id)
    expect(versions.length).toBeGreaterThan(2)
  })

  test('with non-existent version', async () => {
    const given = 'version number that does not exist'
    const should = 'throw error'

    await expect(
      restorePageVersion(testPage.id, 999, testUser.id)
    ).rejects.toThrow('not found')
  })

  test('with non-existent page', async () => {
    const given = 'non-existent page ID'
    const should = 'throw error'

    await expect(
      restorePageVersion('non-existent', 1, testUser.id)
    ).rejects.toThrow('Page not found')
  })
})

describe('getPageVersionStats', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with mixed AI and human edits', async () => {
    const given = 'page with AI and human versions'
    const should = 'count both types correctly'

    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      isAiGenerated: false,
    })
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      isAiGenerated: true,
    })
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      isAiGenerated: true,
    })

    const actual = await getPageVersionStats(testPage.id)

    expect(actual.totalVersions).toBe(3)
    expect(actual.aiGeneratedCount).toBe(2)
    expect(actual.humanEditedCount).toBe(1)
  })

  test('with no versions', async () => {
    const given = 'page with no versions'
    const should = 'return zero counts'

    const actual = await getPageVersionStats(testPage.id)

    expect(actual.totalVersions).toBe(0)
    expect(actual.aiGeneratedCount).toBe(0)
    expect(actual.humanEditedCount).toBe(0)
    expect(actual.totalSize).toBe(0)
  })

  test('with size aggregation', async () => {
    const given = 'multiple versions with content'
    const should = 'calculate total and average size'

    await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await getPageVersionStats(testPage.id)

    expect(actual.totalSize).toBeGreaterThan(0)
    expect(actual.averageSize).toBeGreaterThan(0)
    expect(actual.averageSize).toBe(Math.round(actual.totalSize / actual.totalVersions))
  })

  test('with date range', async () => {
    const given = 'versions created over time'
    const should = 'return oldest and newest dates'

    const v1 = await createPageVersion({ pageId: testPage.id, userId: testUser.id })
    await new Promise(resolve => setTimeout(resolve, 10))
    const v2 = await createPageVersion({ pageId: testPage.id, userId: testUser.id })

    const actual = await getPageVersionStats(testPage.id)

    expect(actual.oldestVersionDate).toEqual(v1.createdAt)
    expect(actual.newestVersionDate).toEqual(v2.createdAt)
  })
})
