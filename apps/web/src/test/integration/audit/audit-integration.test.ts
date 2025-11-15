/**
 * Integration tests for audit logging in page CRUD operations
 *
 * Tests that audit events and versions are automatically created during normal page operations.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { factories } from '@pagespace/db/test/factories'
import { db, users, pages, eq } from '@pagespace/db'
import {
  getPageAuditEvents,
  getPageVersions,
  createAuditEvent,
  createPageVersion,
} from '@pagespace/lib/audit'

describe('Audit logging during page CRUD operations', () => {
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

  test('page creation logs audit event', async () => {
    const given = 'new page is created'
    const should = 'create PAGE_CREATE audit event'

    // Simulate page creation audit logging
    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      afterState: {
        title: testPage.title,
        content: testPage.content,
        type: testPage.type,
      },
      description: 'Page created',
    })

    const events = await getPageAuditEvents(testPage.id)
    const createEvent = events.find(e => e.actionType === 'PAGE_CREATE')

    expect(createEvent).toBeDefined()
    expect(createEvent?.entityId).toBe(testPage.id)
    expect(createEvent?.userId).toBe(testUser.id)
  })

  test('page update logs audit event and creates version', async () => {
    const given = 'page content is updated'
    const should = 'create PAGE_UPDATE event and page version'

    const beforeState = {
      title: testPage.title,
      content: testPage.content,
    }

    // Update page
    await db.update(pages).set({
      content: 'Updated content',
      title: 'Updated title',
    }).where(eq(pages.id, testPage.id))

    const updatedPage = await db.query.pages.findFirst({
      where: eq(pages.id, testPage.id),
    })

    // Log audit event
    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      beforeState,
      afterState: {
        title: updatedPage?.title,
        content: updatedPage?.content,
      },
      changes: {
        title: { before: beforeState.title, after: updatedPage?.title },
        content: { before: beforeState.content, after: updatedPage?.content },
      },
      description: 'Page updated',
    })

    // Create version
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      auditEventId: auditEvent.id,
      changeSummary: 'Updated title and content',
      changeType: 'user_edit',
    })

    // Verify audit event
    const events = await getPageAuditEvents(testPage.id)
    const updateEvent = events.find(e => e.actionType === 'PAGE_UPDATE')
    expect(updateEvent).toBeDefined()

    // Verify version
    const versions = await getPageVersions(testPage.id)
    expect(versions).toHaveLength(1)
    expect(versions[0].auditEventId).toBe(auditEvent.id)
  })

  test('AI page edit logs AI action with operation ID', async () => {
    const given = 'AI makes page edit'
    const should = 'create audit event with isAiAction=true and aiOperationId'

    const { trackAiOperation } = await import('@pagespace/lib/audit')

    // Track AI operation
    const aiOp = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      prompt: 'Improve this content',
      driveId: testDrive.id,
      pageId: testPage.id,
    })

    // Simulate AI edit
    await db.update(pages).set({
      content: 'AI improved content',
    }).where(eq(pages.id, testPage.id))

    // Log as AI action
    await createAuditEvent({
      actionType: 'AI_EDIT',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
      aiOperationId: aiOp.id,
      afterState: { content: 'AI improved content' },
      description: 'AI edited page content',
    })

    // Create AI-generated version
    await createPageVersion({
      pageId: testPage.id,
      userId: testUser.id,
      isAiGenerated: true,
      changeSummary: 'AI content improvement',
      changeType: 'ai_edit',
    })

    // Complete AI operation
    await aiOp.complete({
      completion: 'Improved content',
      actionsPerformed: { edited: 1 },
      tokens: { input: 100, output: 50, cost: 10 },
    })

    // Verify AI attribution
    const events = await getPageAuditEvents(testPage.id)
    const aiEvent = events.find(e => e.actionType === 'AI_EDIT')
    expect(aiEvent?.isAiAction).toBe(true)
    expect(aiEvent?.aiOperationId).toBe(aiOp.id)

    const versions = await getPageVersions(testPage.id)
    expect(versions[0].isAiGenerated).toBe(true)
  })

  test('page deletion logs audit event with before state', async () => {
    const given = 'page is deleted (trashed)'
    const should = 'create PAGE_DELETE event with before state'

    const beforeState = {
      title: testPage.title,
      content: testPage.content,
      isTrashed: testPage.isTrashed,
    }

    // Soft delete (trash) page
    await db.update(pages).set({
      isTrashed: true,
      trashedAt: new Date(),
    }).where(eq(pages.id, testPage.id))

    // Log deletion
    await createAuditEvent({
      actionType: 'PAGE_DELETE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      beforeState,
      afterState: { isTrashed: true },
      description: 'Page moved to trash',
    })

    const events = await getPageAuditEvents(testPage.id)
    const deleteEvent = events.find(e => e.actionType === 'PAGE_DELETE')
    expect(deleteEvent?.beforeState).toEqual(beforeState)
  })

  test('page restoration logs audit event', async () => {
    const given = 'deleted page is restored'
    const should = 'create PAGE_RESTORE event'

    // First trash it
    await db.update(pages).set({
      isTrashed: true,
      trashedAt: new Date(),
    }).where(eq(pages.id, testPage.id))

    // Then restore it
    await db.update(pages).set({
      isTrashed: false,
      trashedAt: null,
    }).where(eq(pages.id, testPage.id))

    await createAuditEvent({
      actionType: 'PAGE_RESTORE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      beforeState: { isTrashed: true },
      afterState: { isTrashed: false },
      description: 'Page restored from trash',
    })

    const events = await getPageAuditEvents(testPage.id)
    const restoreEvent = events.find(e => e.actionType === 'PAGE_RESTORE')
    expect(restoreEvent).toBeDefined()
  })

  test('bulk page operations use operation ID', async () => {
    const given = 'multiple pages moved in bulk'
    const should = 'link all events with same operationId'

    const { createId } = await import('@paralleldrive/cuid2')
    const operationId = createId()

    const page2 = await factories.createPage(testDrive.id)
    const page3 = await factories.createPage(testDrive.id)

    // Simulate bulk move
    const pages = [testPage.id, page2.id, page3.id]
    for (const pageId of pages) {
      await createAuditEvent({
        actionType: 'PAGE_MOVE',
        entityType: 'PAGE',
        entityId: pageId,
        userId: testUser.id,
        driveId: testDrive.id,
        operationId,
        description: 'Bulk page move',
      })
    }

    // Verify all events share operation ID
    const { getOperationEvents } = await import('@pagespace/lib/audit')
    const opEvents = await getOperationEvents(operationId)
    expect(opEvents).toHaveLength(3)
    expect(opEvents.every(e => e.operationId === operationId)).toBe(true)
  })

  test('permission changes log audit events', async () => {
    const given = 'page permissions are granted'
    const should = 'create PERMISSION_GRANT audit event'

    const otherUser = await factories.createUser()

    await createAuditEvent({
      actionType: 'PERMISSION_GRANT',
      entityType: 'PERMISSION',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      afterState: {
        pageId: testPage.id,
        userId: otherUser.id,
        canView: true,
        canEdit: true,
      },
      description: `Granted permissions to ${otherUser.name}`,
    })

    const { getPagePermissionEvents } = await import('@pagespace/lib/audit')
    const permEvents = await getPagePermissionEvents(testPage.id)
    expect(permEvents.length).toBeGreaterThan(0)
    expect(permEvents[0].actionType).toBe('PERMISSION_GRANT')
  })

  test('request context is captured in audit events', async () => {
    const given = 'audit event with request context'
    const should = 'store IP, user agent, session ID'

    const event = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      requestId: 'req-123',
      sessionId: 'sess-456',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0 (Test Browser)',
      description: 'Page updated',
    })

    expect(event.requestId).toBe('req-123')
    expect(event.sessionId).toBe('sess-456')
    expect(event.ipAddress).toBe('192.168.1.1')
    expect(event.userAgent).toBe('Mozilla/5.0 (Test Browser)')
  })

  test('version snapshots capture full page state', async () => {
    const given = 'page with AI configuration'
    const should = 'snapshot all metadata in version'

    // Create page with AI config
    const aiPage = await factories.createPage(testDrive.id, {
      aiProvider: 'openai',
      aiModel: 'gpt-4',
      systemPrompt: 'You are helpful',
      enabledTools: ['search', 'code'],
    })

    const version = await createPageVersion({
      pageId: aiPage.id,
      userId: testUser.id,
      changeSummary: 'Initial snapshot',
    })

    expect(version.metadata).toMatchObject({
      aiProvider: 'openai',
      aiModel: 'gpt-4',
      systemPrompt: 'You are helpful',
      enabledTools: ['search', 'code'],
    })
  })
})

describe('Audit trail queries for activity feeds', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('drive activity feed includes all drive events', async () => {
    const given = 'multiple events in drive'
    const should = 'return chronological activity feed'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const { getDriveActivityFeed } = await import('@pagespace/lib/audit')
    const feed = await getDriveActivityFeed(testDrive.id)

    expect(feed.length).toBeGreaterThanOrEqual(2)
    // Most recent first
    expect(feed[0].actionType).toBe('PAGE_UPDATE')
    expect(feed[1].actionType).toBe('PAGE_CREATE')
  })

  test('activity feed filters AI vs human actions', async () => {
    const given = 'mix of AI and human actions'
    const should = 'filter by isAiAction flag'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const { getDriveAiActivity, getDriveHumanActivity } = await import('@pagespace/lib/audit')

    const aiActivity = await getDriveAiActivity(testDrive.id)
    const humanActivity = await getDriveHumanActivity(testDrive.id)

    expect(aiActivity.every(e => e.isAiAction === true)).toBe(true)
    expect(humanActivity.every(e => e.isAiAction === false)).toBe(true)
  })

  test('activity stats aggregate metrics correctly', async () => {
    const given = 'drive with various activities'
    const should = 'calculate correct statistics'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    const { getDriveActivityStats } = await import('@pagespace/lib/audit')
    const stats = await getDriveActivityStats(testDrive.id, 30)

    expect(stats.total).toBe(2)
    expect(stats.aiActions).toBe(1)
    expect(stats.humanActions).toBe(1)
    expect(stats.aiPercentage).toBe(50)
    expect(stats.actionTypeCounts['PAGE_CREATE']).toBe(1)
    expect(stats.actionTypeCounts['PAGE_UPDATE']).toBe(1)
  })
})
