import { describe, it, expect } from 'vitest';
import {
  parseConversationData,
  parseConversationsData,
} from '../chat-types';
import type { RawConversationData } from '../chat-types';

describe('chat-types', () => {
  const raw: RawConversationData = {
    id: 'conv-1',
    title: 'Test Conversation',
    preview: 'Hello world',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T11:00:00Z',
    messageCount: 5,
    lastMessage: {
      role: 'assistant',
      timestamp: '2025-01-15T10:30:00Z',
    },
  };

  describe('parseConversationData', () => {
    it('should parse date strings into Date objects', () => {
      const result = parseConversationData(raw);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.lastMessage.timestamp).toBeInstanceOf(Date);
    });

    it('should preserve non-date fields', () => {
      const result = parseConversationData(raw);
      expect(result.id).toBe('conv-1');
      expect(result.title).toBe('Test Conversation');
      expect(result.preview).toBe('Hello world');
      expect(result.messageCount).toBe(5);
      expect(result.lastMessage.role).toBe('assistant');
    });

    it('should parse dates correctly', () => {
      const result = parseConversationData(raw);
      expect(result.createdAt.toISOString()).toBe('2025-01-15T10:00:00.000Z');
      expect(result.updatedAt.toISOString()).toBe('2025-01-15T11:00:00.000Z');
      expect(result.lastMessage.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    });
  });

  describe('parseConversationsData', () => {
    it('should parse an array of raw conversations', () => {
      const raw2: RawConversationData = {
        ...raw,
        id: 'conv-2',
        title: 'Second',
      };
      const results = parseConversationsData([raw, raw2]);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('conv-1');
      expect(results[1].id).toBe('conv-2');
      expect(results[0].createdAt).toBeInstanceOf(Date);
      expect(results[1].createdAt).toBeInstanceOf(Date);
    });

    it('should return empty array for empty input', () => {
      expect(parseConversationsData([])).toEqual([]);
    });
  });
});
