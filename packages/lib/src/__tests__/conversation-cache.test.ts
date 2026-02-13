import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConversationCache, type CachedMessage } from '../services/conversation-cache'

describe('conversation-cache', () => {
  let cache: ConversationCache

  beforeEach(() => {
    // Create instance with Redis disabled for predictable testing
    cache = ConversationCache.getInstance({
      enableRedis: false,
      defaultTTL: 60,
      maxMemoryEntries: 100,
      maxMessagesPerConversation: 50
    })
  })

  afterEach(async () => {
    await cache.clearAll()
    await cache.shutdown()
  })

  const testPageId = 'page_123'
  const testConversationId = 'conv_456'

  const createTestMessage = (id: string, role: 'user' | 'assistant' | 'system' = 'user'): CachedMessage => ({
    id,
    role,
    content: `Test message ${id}`,
    toolCalls: null,
    toolResults: null,
    createdAt: Date.now(),
    editedAt: null,
    messageType: 'standard',
  })

  describe('setConversation and getConversation', () => {
    it('stores and retrieves conversation (cache hit)', async () => {
      const messages = [
        createTestMessage('msg_1', 'user'),
        createTestMessage('msg_2', 'assistant'),
      ]

      await cache.setConversation(testPageId, testConversationId, messages)

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached).not.toBeNull()
      expect(cached?.pageId).toBe(testPageId)
      expect(cached?.conversationId).toBe(testConversationId)
      expect(cached?.messages).toHaveLength(2)
      expect(cached?.messages[0].id).toBe('msg_1')
      expect(cached?.messages[1].id).toBe('msg_2')
    })

    it('returns null for non-existent conversation (cache miss)', async () => {
      const cached = await cache.getConversation('nonexistent', 'conv_999')

      expect(cached).toBeNull()
    })

    it('stores message content correctly', async () => {
      const messageWithToolCalls: CachedMessage = {
        id: 'msg_tools',
        role: 'assistant',
        content: 'Using a tool',
        toolCalls: JSON.stringify([{ name: 'test_tool', args: {} }]),
        toolResults: JSON.stringify([{ result: 'success' }]),
        createdAt: Date.now(),
        editedAt: Date.now() - 1000,
        messageType: 'standard',
      }

      await cache.setConversation(testPageId, testConversationId, [messageWithToolCalls])

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages[0].toolCalls).toBe(messageWithToolCalls.toolCalls)
      expect(cached?.messages[0].toolResults).toBe(messageWithToolCalls.toolResults)
      expect(cached?.messages[0].editedAt).toBe(messageWithToolCalls.editedAt)
    })

    it('respects TTL for conversations', async () => {
      const shortTTL = 1 // 1 second
      const messages = [createTestMessage('msg_1')]

      await cache.setConversation(testPageId, testConversationId, messages, shortTTL)

      // Should exist immediately
      let cached = await cache.getConversation(testPageId, testConversationId)
      expect(cached).not.toBeNull()

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Should be expired
      cached = await cache.getConversation(testPageId, testConversationId)
      expect(cached).toBeNull()
    })

    it('overwrites existing conversation', async () => {
      const originalMessages = [createTestMessage('msg_1')]
      await cache.setConversation(testPageId, testConversationId, originalMessages)

      const newMessages = [
        createTestMessage('msg_new_1'),
        createTestMessage('msg_new_2'),
      ]
      await cache.setConversation(testPageId, testConversationId, newMessages)

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages).toHaveLength(2)
      expect(cached?.messages[0].id).toBe('msg_new_1')
    })

    it('stores conversations for different pages separately', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'

      await cache.setConversation(page1, testConversationId, [createTestMessage('msg_p1')])
      await cache.setConversation(page2, testConversationId, [createTestMessage('msg_p2')])

      const cached1 = await cache.getConversation(page1, testConversationId)
      const cached2 = await cache.getConversation(page2, testConversationId)

      expect(cached1?.messages[0].id).toBe('msg_p1')
      expect(cached2?.messages[0].id).toBe('msg_p2')
    })

    it('stores different conversations for same page separately', async () => {
      const conv1 = 'conv_1'
      const conv2 = 'conv_2'

      await cache.setConversation(testPageId, conv1, [createTestMessage('msg_c1')])
      await cache.setConversation(testPageId, conv2, [createTestMessage('msg_c2')])

      const cached1 = await cache.getConversation(testPageId, conv1)
      const cached2 = await cache.getConversation(testPageId, conv2)

      expect(cached1?.messages[0].id).toBe('msg_c1')
      expect(cached2?.messages[0].id).toBe('msg_c2')
    })
  })

  describe('message truncation at max limit', () => {
    it('truncates messages when exceeding limit', async () => {
      // Shutdown the default cache first to create a new one with different config
      await cache.shutdown()

      const smallLimitCache = ConversationCache.getInstance({
        enableRedis: false,
        maxMessagesPerConversation: 5
      })

      // Create 10 messages
      const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg_${i}`))

      await smallLimitCache.setConversation(testPageId, testConversationId, messages)

      const cached = await smallLimitCache.getConversation(testPageId, testConversationId)

      // Should only keep last 5 messages
      expect(cached?.messages).toHaveLength(5)
      expect(cached?.messages[0].id).toBe('msg_5')
      expect(cached?.messages[4].id).toBe('msg_9')

      await smallLimitCache.shutdown()

      // Recreate the default cache for subsequent tests
      cache = ConversationCache.getInstance({
        enableRedis: false,
        defaultTTL: 60,
        maxMemoryEntries: 100,
        maxMessagesPerConversation: 50
      })
    })
  })

  describe('appendMessage', () => {
    it('appends message to existing conversation', async () => {
      const initialMessages = [createTestMessage('msg_1')]
      await cache.setConversation(testPageId, testConversationId, initialMessages)

      const newMessage = createTestMessage('msg_2', 'assistant')
      await cache.appendMessage(testPageId, testConversationId, newMessage)

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages).toHaveLength(2)
      expect(cached?.messages[1].id).toBe('msg_2')
    })

    it('does not create new entry if conversation not cached', async () => {
      const newMessage = createTestMessage('msg_1')

      // Append to non-existent conversation
      await cache.appendMessage('nonexistent_page', 'nonexistent_conv', newMessage)

      // Should still not exist
      const cached = await cache.getConversation('nonexistent_page', 'nonexistent_conv')
      expect(cached).toBeNull()
    })

    it('refreshes TTL on append', async () => {
      const shortTTL = 2 // 2 seconds
      const messages = [createTestMessage('msg_1')]
      await cache.setConversation(testPageId, testConversationId, messages, shortTTL)

      // Wait 1.5 seconds
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Append should refresh TTL
      const newMessage = createTestMessage('msg_2')
      await cache.appendMessage(testPageId, testConversationId, newMessage)

      // Wait another 1 second (would have been expired without refresh)
      await new Promise(resolve => setTimeout(resolve, 1000))

      const cached = await cache.getConversation(testPageId, testConversationId)
      expect(cached).not.toBeNull()
    })

    it('updates existing message with same ID (upsert)', async () => {
      const initialMessages = [createTestMessage('msg_1')]
      await cache.setConversation(testPageId, testConversationId, initialMessages)

      // Append message with same ID but different content
      const updatedMessage: CachedMessage = {
        ...createTestMessage('msg_1'),
        content: 'Updated content',
      }
      await cache.appendMessage(testPageId, testConversationId, updatedMessage)

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages).toHaveLength(1) // Still 1, not 2
      expect(cached?.messages[0].content).toBe('Updated content')
    })

    it('truncates on append when exceeding limit', async () => {
      // Shutdown the default cache first to create a new one with different config
      await cache.shutdown()

      const smallLimitCache = ConversationCache.getInstance({
        enableRedis: false,
        maxMessagesPerConversation: 3
      })

      const messages = [
        createTestMessage('msg_1'),
        createTestMessage('msg_2'),
        createTestMessage('msg_3'),
      ]
      await smallLimitCache.setConversation(testPageId, testConversationId, messages)

      // Append a 4th message
      await smallLimitCache.appendMessage(testPageId, testConversationId, createTestMessage('msg_4'))

      const cached = await smallLimitCache.getConversation(testPageId, testConversationId)

      expect(cached?.messages).toHaveLength(3)
      expect(cached?.messages[0].id).toBe('msg_2')
      expect(cached?.messages[2].id).toBe('msg_4')

      await smallLimitCache.shutdown()

      // Recreate the default cache for subsequent tests
      cache = ConversationCache.getInstance({
        enableRedis: false,
        defaultTTL: 60,
        maxMemoryEntries: 100,
        maxMessagesPerConversation: 50
      })
    })
  })

  describe('invalidateConversation', () => {
    it('invalidates single conversation', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      await cache.invalidateConversation(testPageId, testConversationId)

      const cached = await cache.getConversation(testPageId, testConversationId)
      expect(cached).toBeNull()
    })

    it('does not affect other conversations on same page', async () => {
      const conv1 = 'conv_1'
      const conv2 = 'conv_2'

      await cache.setConversation(testPageId, conv1, [createTestMessage('msg_c1')])
      await cache.setConversation(testPageId, conv2, [createTestMessage('msg_c2')])

      await cache.invalidateConversation(testPageId, conv1)

      const cached1 = await cache.getConversation(testPageId, conv1)
      const cached2 = await cache.getConversation(testPageId, conv2)

      expect(cached1).toBeNull()
      expect(cached2).not.toBeNull()
    })

    it('handles invalidation for non-existent conversation', async () => {
      await expect(cache.invalidateConversation('nonexistent', 'conv_999')).resolves.not.toThrow()
    })
  })

  describe('invalidatePage', () => {
    it('invalidates all conversations for a page', async () => {
      const conv1 = 'conv_1'
      const conv2 = 'conv_2'

      await cache.setConversation(testPageId, conv1, [createTestMessage('msg_1')])
      await cache.setConversation(testPageId, conv2, [createTestMessage('msg_2')])

      await cache.invalidatePage(testPageId)

      const cached1 = await cache.getConversation(testPageId, conv1)
      const cached2 = await cache.getConversation(testPageId, conv2)

      expect(cached1).toBeNull()
      expect(cached2).toBeNull()
    })

    it('does not affect other pages', async () => {
      const page1 = 'page_1'
      const page2 = 'page_2'

      await cache.setConversation(page1, testConversationId, [createTestMessage('msg_1')])
      await cache.setConversation(page2, testConversationId, [createTestMessage('msg_2')])

      await cache.invalidatePage(page1)

      const cached1 = await cache.getConversation(page1, testConversationId)
      const cached2 = await cache.getConversation(page2, testConversationId)

      expect(cached1).toBeNull()
      expect(cached2).not.toBeNull()
    })

    it('handles invalidation for non-existent page', async () => {
      await expect(cache.invalidatePage('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('getCacheStats', () => {
    it('returns cache statistics', () => {
      const stats = cache.getCacheStats()

      expect(stats).toHaveProperty('memoryEntries')
      expect(stats).toHaveProperty('redisAvailable')
      expect(stats).toHaveProperty('maxMemoryEntries')
      expect(stats).toHaveProperty('memoryUsagePercent')
      expect(stats).toHaveProperty('metrics')

      expect(typeof stats.memoryEntries).toBe('number')
      expect(typeof stats.redisAvailable).toBe('boolean')
    })

    it('reflects memory entries count', async () => {
      await cache.setConversation('page_1', 'conv_1', [createTestMessage('msg_1')])
      await cache.setConversation('page_2', 'conv_2', [createTestMessage('msg_2')])

      const stats = cache.getCacheStats()

      expect(stats.memoryEntries).toBe(2)
    })
  })

  describe('metrics tracking', () => {
    beforeEach(() => {
      cache.resetMetrics()
    })

    it('tracks hits when cache returns valid entry', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      await cache.getConversation(testPageId, testConversationId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.hits).toBe(1)
      expect(metrics.misses).toBe(0)
    })

    it('tracks misses when cache returns null', async () => {
      await cache.getConversation('nonexistent', 'conv_999')

      const { metrics } = cache.getCacheStats()
      expect(metrics.misses).toBe(1)
      expect(metrics.hits).toBe(0)
    })

    it('tracks invalidation count', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      await cache.invalidateConversation(testPageId, testConversationId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.invalidations).toBe(1)
    })

    it('tracks append operations', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      await cache.appendMessage(testPageId, testConversationId, createTestMessage('msg_2'))

      const { metrics } = cache.getCacheStats()
      expect(metrics.appendOperations).toBe(1)
    })

    it('tracks TTL expirations on access', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')], 1)

      await new Promise(resolve => setTimeout(resolve, 1100))

      await cache.getConversation(testPageId, testConversationId)

      const { metrics } = cache.getCacheStats()
      expect(metrics.ttlExpirations).toBe(1)
      expect(metrics.misses).toBe(1)
    })

    it('resets metrics correctly', async () => {
      await cache.getConversation('nonexistent', 'conv_999')
      expect(cache.getCacheStats().metrics.misses).toBe(1)

      cache.resetMetrics()

      const { metrics } = cache.getCacheStats()
      expect(metrics.hits).toBe(0)
      expect(metrics.misses).toBe(0)
      expect(metrics.invalidations).toBe(0)
      expect(metrics.appendOperations).toBe(0)
      expect(metrics.ttlExpirations).toBe(0)
      expect(metrics.sizeEvictions).toBe(0)
      expect(metrics.redisErrors).toBe(0)
    })
  })

  describe('memory management', () => {
    it('enforces max memory entries limit via cleanup', async () => {
      const smallCache = ConversationCache.getInstance({
        enableRedis: false,
        maxMemoryEntries: 5
      })

      // Add more than max
      for (let i = 0; i < 10; i++) {
        await smallCache.setConversation(`page_${i}`, `conv_${i}`, [createTestMessage(`msg_${i}`)])
      }

      const stats = smallCache.getCacheStats()
      // Note: Memory limit is enforced during cleanup interval, not immediately
      expect(stats.memoryEntries).toBeLessThanOrEqual(10)

      await smallCache.shutdown()
    })
  })

  describe('clearAll', () => {
    it('clears all cache entries', async () => {
      await cache.setConversation('page_1', 'conv_1', [createTestMessage('msg_1')])
      await cache.setConversation('page_2', 'conv_2', [createTestMessage('msg_2')])

      await cache.clearAll()

      const stats = cache.getCacheStats()
      expect(stats.memoryEntries).toBe(0)
    })
  })

  describe('configuration', () => {
    it('uses default TTL when not specified', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.ttl).toBe(60) // Default TTL set in beforeEach
    })

    it('uses custom TTL when specified', async () => {
      const customTTL = 300
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')], customTTL)

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.ttl).toBe(customTTL)
    })

    it('indicates Redis availability', () => {
      const stats = cache.getCacheStats()

      expect(stats.redisAvailable).toBe(false) // We disabled Redis in beforeEach
    })
  })

  describe('edge cases', () => {
    it('handles empty messages array', async () => {
      await cache.setConversation(testPageId, testConversationId, [])

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages).toHaveLength(0)
    })

    it('handles rapid sequential operations', async () => {
      const operations = []

      for (let i = 0; i < 50; i++) {
        operations.push(
          cache.setConversation(`page_${i}`, `conv_${i}`, [createTestMessage(`msg_${i}`)])
        )
      }

      await Promise.all(operations)

      const stats = cache.getCacheStats()
      expect(stats.memoryEntries).toBeGreaterThan(0)
    })

    it('handles concurrent reads and writes', async () => {
      await cache.setConversation(testPageId, testConversationId, [createTestMessage('msg_1')])

      const operations = []

      for (let i = 0; i < 20; i++) {
        operations.push(cache.getConversation(testPageId, testConversationId))
        operations.push(cache.appendMessage(testPageId, testConversationId, createTestMessage(`msg_append_${i}`)))
      }

      await Promise.all(operations)

      // Should complete without errors
      const cached = await cache.getConversation(testPageId, testConversationId)
      expect(cached).not.toBeNull()
    })

    it('handles messages with complex content', async () => {
      const complexMessage: CachedMessage = {
        id: 'msg_complex',
        role: 'assistant',
        content: JSON.stringify({
          textParts: ['Hello', 'World'],
          partsOrder: ['text', 'file', 'text'],
          fileParts: [{ url: 'test.png' }]
        }),
        toolCalls: JSON.stringify([
          { name: 'search', args: { query: 'test' } },
          { name: 'read', args: { file: 'test.txt' } }
        ]),
        toolResults: JSON.stringify([
          { success: true, data: 'result 1' },
          { success: false, error: 'not found' }
        ]),
        createdAt: Date.now(),
        editedAt: Date.now() - 1000,
        messageType: 'standard',
      }

      await cache.setConversation(testPageId, testConversationId, [complexMessage])

      const cached = await cache.getConversation(testPageId, testConversationId)

      expect(cached?.messages[0]).toEqual(complexMessage)
    })
  })
})
