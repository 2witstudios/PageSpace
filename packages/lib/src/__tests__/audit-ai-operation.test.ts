/**
 * Unit tests for AI operation tracking
 *
 * Tests the track-ai-operation module which provides AI attribution and usage tracking.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import {
  trackAiOperation,
  getUserAiOperations,
  getDriveAiOperations,
  getPageAiOperations,
  getAiUsageReport,
  getConversationAiOperations,
  getLatestAiOperation,
  getFailedAiOperations,
  getAiUsageSummary,
} from '../audit/track-ai-operation'
import { factories } from '@pagespace/db/test/factories'
import { db, users } from '@pagespace/db'

describe('trackAiOperation', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with basic operation tracking', async () => {
    const given = 'AI operation parameters'
    const should = 'create operation and return controller'

    const actual = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      prompt: 'Improve this paragraph',
      driveId: testDrive.id,
      pageId: testPage.id,
    })

    expect(actual.id).toBeTruthy()
    expect(actual.complete).toBeInstanceOf(Function)
    expect(actual.fail).toBeInstanceOf(Function)
    expect(actual.cancel).toBeInstanceOf(Function)
  })

  test('with successful completion', async () => {
    const given = 'AI operation that completes successfully'
    const should = 'update operation with completion data'

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20250219',
      operationType: 'generate',
      driveId: testDrive.id,
    })

    await operation.complete({
      completion: 'Generated content here',
      actionsPerformed: { created: 1, updated: 0 },
      tokens: { input: 100, output: 200, cost: 50 },
    })

    const operations = await getUserAiOperations(testUser.id)
    const completed = operations.find(op => op.id === operation.id)

    expect(completed?.status).toBe('completed')
    expect(completed?.completion).toBe('Generated content here')
    expect(completed?.inputTokens).toBe(100)
    expect(completed?.outputTokens).toBe(200)
    expect(completed?.totalCost).toBe(50)
    expect(completed?.duration).toBeGreaterThanOrEqual(0)
  })

  test('with operation failure', async () => {
    const given = 'AI operation that fails'
    const should = 'update operation with error status'

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'CODER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'tool_call',
      driveId: testDrive.id,
    })

    await operation.fail('API rate limit exceeded')

    const operations = await getUserAiOperations(testUser.id)
    const failed = operations.find(op => op.id === operation.id)

    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('API rate limit exceeded')
  })

  test('with operation cancellation', async () => {
    const given = 'AI operation that is cancelled'
    const should = 'update operation with cancelled status'

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'ANALYST',
      provider: 'google',
      model: 'gemini-pro',
      operationType: 'analyze',
      driveId: testDrive.id,
    })

    await operation.cancel()

    const operations = await getUserAiOperations(testUser.id)
    const cancelled = operations.find(op => op.id === operation.id)

    expect(cancelled?.status).toBe('cancelled')
  })

  test('with conversation context', async () => {
    const given = 'AI operation with conversation and message IDs'
    const should = 'store conversation context'

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'ASSISTANT',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'conversation',
      conversationId: 'conv-123',
      messageId: 'msg-456',
      driveId: testDrive.id,
    })

    const operations = await getUserAiOperations(testUser.id)
    const tracked = operations.find(op => op.id === operation.id)

    expect(tracked?.conversationId).toBe('conv-123')
    expect(tracked?.messageId).toBe('msg-456')
  })

  test('with tool usage tracking', async () => {
    const given = 'AI operation that calls tools'
    const should = 'store tools called and results'

    const toolsCalled = ['search', 'calculator']
    const toolResults = [
      { tool: 'search', result: 'Found 5 results' },
      { tool: 'calculator', result: '42' },
    ]

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'RESEARCHER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'tool_call',
      toolsCalled,
      toolResults,
      driveId: testDrive.id,
    })

    const operations = await getUserAiOperations(testUser.id)
    const tracked = operations.find(op => op.id === operation.id)

    expect(tracked?.toolsCalled).toEqual(toolsCalled)
    expect(tracked?.toolResults).toEqual(toolResults)
  })

  test('with system prompt', async () => {
    const given = 'AI operation with custom system prompt'
    const should = 'store system prompt'

    const systemPrompt = 'You are an expert code reviewer'

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'REVIEWER',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20250219',
      operationType: 'review',
      systemPrompt,
      driveId: testDrive.id,
    })

    const operations = await getUserAiOperations(testUser.id)
    const tracked = operations.find(op => op.id === operation.id)

    expect(tracked?.systemPrompt).toBe(systemPrompt)
  })

  test('with metadata', async () => {
    const given = 'AI operation with custom metadata'
    const should = 'store metadata in JSONB field'

    const metadata = {
      temperature: 0.7,
      maxTokens: 1000,
      customField: 'value',
    }

    const operation = await trackAiOperation({
      userId: testUser.id,
      agentType: 'CUSTOM',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'custom',
      metadata,
      driveId: testDrive.id,
    })

    const operations = await getUserAiOperations(testUser.id)
    const tracked = operations.find(op => op.id === operation.id)

    expect(tracked?.metadata).toEqual(metadata)
  })
})

describe('getUserAiOperations', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with multiple user operations', async () => {
    const given = 'user with multiple AI operations'
    const should = 'return all operations for that user'

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20250219',
      operationType: 'generate',
      driveId: testDrive.id,
    })

    await trackAiOperation({
      userId: otherUser.id,
      agentType: 'CODER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'code',
      driveId: testDrive.id,
    })

    const actual = await getUserAiOperations(testUser.id)

    expect(actual).toHaveLength(2)
    expect(actual.every(op => op.userId === testUser.id)).toBe(true)
  })

  test('with limit parameter', async () => {
    const given = 'user with many operations and limit'
    const should = 'return only limited number of operations'

    for (let i = 0; i < 5; i++) {
      await trackAiOperation({
        userId: testUser.id,
        agentType: 'ASSISTANT',
        provider: 'openai',
        model: 'gpt-4',
        operationType: 'assist',
        driveId: testDrive.id,
      })
    }

    const actual = await getUserAiOperations(testUser.id, 3)

    expect(actual).toHaveLength(3)
  })
})

describe('getDriveAiOperations', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let otherDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    otherDrive = await factories.createDrive(testUser.id)
  })

  test('with drive-scoped operations', async () => {
    const given = 'operations in specific drive'
    const should = 'return only operations for that drive'

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'write',
      driveId: otherDrive.id,
    })

    const actual = await getDriveAiOperations(testDrive.id)

    expect(actual).toHaveLength(1)
    expect(actual[0].driveId).toBe(testDrive.id)
  })
})

describe('getPageAiOperations', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>
  let otherPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
    otherPage = await factories.createPage(testDrive.id)
  })

  test('with page-specific operations', async () => {
    const given = 'operations on specific page'
    const should = 'return only operations for that page'

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
      pageId: testPage.id,
    })

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'write',
      driveId: testDrive.id,
      pageId: otherPage.id,
    })

    const actual = await getPageAiOperations(testPage.id)

    expect(actual).toHaveLength(1)
    expect(actual[0].pageId).toBe(testPage.id)
  })
})

describe('getAiUsageReport', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with usage statistics by model', async () => {
    const given = 'multiple operations with different models'
    const should = 'aggregate statistics by agent type, provider, and model'

    const op1 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })

    await op1.complete({
      completion: 'Done',
      actionsPerformed: {},
      tokens: { input: 100, output: 50, cost: 10 },
    })

    const op2 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })

    await op2.complete({
      completion: 'Done',
      actionsPerformed: {},
      tokens: { input: 200, output: 100, cost: 20 },
    })

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 1)
    const endDate = new Date()
    endDate.setDate(endDate.getDate() + 1)

    const actual = await getAiUsageReport(testUser.id, startDate, endDate)

    expect(actual).toHaveLength(1)
    expect(actual[0].agentType).toBe('EDITOR')
    expect(actual[0].provider).toBe('openai')
    expect(actual[0].model).toBe('gpt-4')
    expect(Number(actual[0].operationCount)).toBe(2)
    expect(Number(actual[0].totalInputTokens)).toBe(300)
    expect(Number(actual[0].totalOutputTokens)).toBe(150)
    expect(Number(actual[0].totalCost)).toBe(30)
  })
})

describe('getConversationAiOperations', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with conversation operations', async () => {
    const given = 'operations in same conversation'
    const should = 'return all operations for that conversation'

    const conversationId = 'conv-123'

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'ASSISTANT',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'conversation',
      conversationId,
      driveId: testDrive.id,
    })

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'ASSISTANT',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'conversation',
      conversationId,
      driveId: testDrive.id,
    })

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'ASSISTANT',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'conversation',
      conversationId: 'other-conv',
      driveId: testDrive.id,
    })

    const actual = await getConversationAiOperations(conversationId)

    expect(actual).toHaveLength(2)
    expect(actual.every(op => op.conversationId === conversationId)).toBe(true)
  })
})

describe('getLatestAiOperation', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with multiple operations', async () => {
    const given = 'user with multiple operations'
    const should = 'return most recent operation'

    await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const latest = await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'write',
      driveId: testDrive.id,
    })

    const actual = await getLatestAiOperation(testUser.id)

    expect(actual?.id).toBe(latest.id)
  })
})

describe('getFailedAiOperations', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with failed operations', async () => {
    const given = 'mix of successful and failed operations'
    const should = 'return only failed operations'

    const op1 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })
    await op1.fail('Error 1')

    const op2 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'write',
      driveId: testDrive.id,
    })
    await op2.complete({
      completion: 'Done',
      actionsPerformed: {},
      tokens: { input: 100, output: 50, cost: 10 },
    })

    const op3 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'CODER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'code',
      driveId: testDrive.id,
    })
    await op3.fail('Error 2')

    const actual = await getFailedAiOperations(testUser.id)

    expect(actual).toHaveLength(2)
    expect(actual.every(op => op.status === 'failed')).toBe(true)
  })
})

describe('getAiUsageSummary', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with mixed operation statuses', async () => {
    const given = 'operations with different statuses'
    const should = 'calculate counts and success rate'

    const op1 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'EDITOR',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      driveId: testDrive.id,
    })
    await op1.complete({
      completion: 'Done',
      actionsPerformed: {},
      tokens: { input: 100, output: 50, cost: 10 },
    })

    const op2 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'WRITER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'write',
      driveId: testDrive.id,
    })
    await op2.fail('Error')

    const op3 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'CODER',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'code',
      driveId: testDrive.id,
    })
    await op3.cancel()

    const op4 = await trackAiOperation({
      userId: testUser.id,
      agentType: 'ANALYST',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'analyze',
      driveId: testDrive.id,
    })
    await op4.complete({
      completion: 'Done',
      actionsPerformed: {},
      tokens: { input: 200, output: 100, cost: 20 },
    })

    const actual = await getAiUsageSummary(testUser.id, 30)

    expect(actual.total).toBe(4)
    expect(actual.completed).toBe(2)
    expect(actual.failed).toBe(1)
    expect(actual.cancelled).toBe(1)
    expect(actual.successRate).toBe(50)
    expect(actual.totalInputTokens).toBe(300)
    expect(actual.totalOutputTokens).toBe(150)
    expect(actual.totalCost).toBe(30)
    expect(actual.totalCostDollars).toBe(0.30)
  })

  test('with no operations', async () => {
    const given = 'user with no AI operations'
    const should = 'return zero counts'

    const actual = await getAiUsageSummary(testUser.id, 30)

    expect(actual.total).toBe(0)
    expect(actual.completed).toBe(0)
    expect(actual.failed).toBe(0)
    expect(actual.cancelled).toBe(0)
    expect(actual.successRate).toBe(0)
    expect(actual.totalTokens).toBe(0)
    expect(actual.totalCost).toBe(0)
  })
})
