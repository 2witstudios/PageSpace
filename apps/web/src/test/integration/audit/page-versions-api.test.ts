/**
 * Integration tests for page versions API routes
 *
 * Tests the /api/pages/[pageId]/versions endpoints including GET and POST (restore).
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { factories } from '@pagespace/db/test/factories'
import { db, users } from '@pagespace/db'
import { createPageVersion } from '@pagespace/lib/audit'
import { generateToken } from '@/lib/auth'

/**
 * Helper to make authenticated API requests
 */
async function makeAuthenticatedRequest(
  url: string,
  userId: string,
  options: RequestInit = {}
) {
  const token = await generateToken({ userId, type: 'access' })

  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
}

describe('GET /api/pages/[pageId]/versions', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>
  const BASE_URL = 'http://localhost:3000'

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id, {
      content: 'Initial content',
      title: 'Initial title',
    })
  })

  test('with view permission', async () => {
    const given = 'user with view permission on page'
    const should = 'return version history'

    // Create some versions
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      changeSummary: 'Version 1',
    })
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      changeSummary: 'Version 2',
    })

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id
    )

    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data.pageId).toBe(testPage.id)
    expect(data.versions).toBeInstanceOf(Array)
    expect(data.versions.length).toBe(2)
    expect(data.versions[0].versionNumber).toBe(2)
    expect(data.versions[1].versionNumber).toBe(1)
  })

  test('with limit parameter', async () => {
    const given = 'page with multiple versions and limit query param'
    const should = 'return limited number of versions'

    // Create 5 versions
    for (let i = 1; i <= 5; i++) {
      await createPageVersion({
        pageId: testPage.id,
        userId: testUser.id,
        changeSummary: `Version ${i}`,
      })
    }

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions?limit=3`,
      testUser.id
    )

    const data = await response.json()
    expect(data.versions).toHaveLength(3)
    expect(data.versions[0].versionNumber).toBe(5)
    expect(data.versions[2].versionNumber).toBe(3)
  })

  test('without view permission', async () => {
    const given = 'user without view permission'
    const should = 'return 403 Forbidden'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      otherUser.id
    )

    expect(response.status).toBe(403)

    const data = await response.json()
    expect(data.error).toBe('Permission denied')
  })

  test('without authentication', async () => {
    const given = 'request without authentication token'
    const should = 'return 401 Unauthorized'

    const response = await fetch(
      `${BASE_URL}/api/pages/${testPage.id}/versions`
    )

    expect(response.status).toBe(401)
  })

  test('with non-existent page', async () => {
    const given = 'non-existent page ID'
    const should = 'return 403 (no permission on non-existent page)'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/non-existent-page/versions`,
      testUser.id
    )

    expect(response.status).toBe(403)
  })

  test('with version metadata', async () => {
    const given = 'versions with user and audit event data'
    const should = 'include related metadata in response'

    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      changeSummary: 'Test version',
      changeType: 'user_edit',
      isAiGenerated: false,
    })

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id
    )

    const data = await response.json()
    expect(data.versions[0]).toMatchObject({
      versionNumber: 1,
      changeSummary: 'Test version',
      changeType: 'user_edit',
      isAiGenerated: false,
    })
    expect(data.versions[0].createdBy).toMatchObject({
      id: testUser.id,
      name: testUser.name,
    })
  })
})

describe('POST /api/pages/[pageId]/versions', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>
  const BASE_URL = 'http://localhost:3000'

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id, {
      content: 'Initial content',
      title: 'Initial title',
    })
  })

  test('with valid version restoration', async () => {
    const given = 'user with edit permission restoring valid version'
    const should = 'restore page to that version'

    // Create version 1
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    // Update page content using Drizzle
    const { pages, eq } = await import('@pagespace/db')
    await db.update(pages).set({
      content: 'Updated content',
      title: 'Updated title',
    }).where(eq(pages.id, testPage.id))

    // Create version 2
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    // Restore to version 1
    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 1 }),
      }
    )

    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.page.content).toBe('Initial content')
    expect(data.page.title).toBe('Initial title')
  })

  test('without edit permission', async () => {
    const given = 'user without edit permission'
    const should = 'return 403 Forbidden'

    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      otherUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 1 }),
      }
    )

    expect(response.status).toBe(403)

    const data = await response.json()
    expect(data.error).toBe('Permission denied')
  })

  test('with invalid version number', async () => {
    const given = 'request with string instead of number'
    const should = 'return 400 validation error'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 'invalid' }),
      }
    )

    expect(response.status).toBe(400)

    const data = await response.json()
    expect(data.error).toBe('Validation failed')
  })

  test('with missing version number', async () => {
    const given = 'request without version number'
    const should = 'return 400 validation error'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    )

    expect(response.status).toBe(400)

    const data = await response.json()
    expect(data.error).toBe('Validation failed')
  })

  test('with non-existent version', async () => {
    const given = 'version number that does not exist'
    const should = 'return 404 Not Found'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 999 }),
      }
    )

    expect(response.status).toBe(404)

    const data = await response.json()
    expect(data.error).toContain('not found')
  })

  test('with negative version number', async () => {
    const given = 'negative version number'
    const should = 'return 400 validation error'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: -1 }),
      }
    )

    expect(response.status).toBe(400)

    const data = await response.json()
    expect(data.error).toBe('Validation failed')
  })

  test('with zero version number', async () => {
    const given = 'version number of zero'
    const should = 'return 400 validation error'

    const response = await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 0 }),
      }
    )

    expect(response.status).toBe(400)

    const data = await response.json()
    expect(data.error).toBe('Validation failed')
  })

  test('creates new version after restoration', async () => {
    const given = 'successful version restoration'
    const should = 'create new version documenting the restoration'

    // Create version 1
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    // Update and create version 2
    const { pages, eq } = await import('@pagespace/db')
    await db.update(pages).set({
      content: 'Updated content',
    }).where(eq(pages.id, testPage.id))

    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
    })

    // Restore to version 1
    await makeAuthenticatedRequest(
      `${BASE_URL}/api/pages/${testPage.id}/versions`,
      testUser.id,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber: 1 }),
      }
    )

    // Check that version 3 was created
    const { getPageVersions } = await import('@pagespace/lib/audit')
    const versions = await getPageVersions(testPage.id)

    expect(versions.length).toBeGreaterThanOrEqual(3)
    expect(versions[0].changeSummary).toContain('Restored to version 1')
  })
})
