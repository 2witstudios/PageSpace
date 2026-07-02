/**
 * Tests for pure chat-config functions.
 * RITE tests: Readable, Isolated, Thorough, Explicit.
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  GLOBAL_CHAT_ID,
  AGENT_CHAT_ID,
  SIDEBAR_AGENT_CHAT_ID,
  buildChatConfig,
} from '../chat-config';

describe('chat-config pure functions', () => {
  describe('stable chat ID constants', () => {
    it('given the module loads, should export stable ID constants for each surface', () => {
      expect(GLOBAL_CHAT_ID).toBe('global-assistant');
      expect(AGENT_CHAT_ID).toBe('agent-chat');
      expect(SIDEBAR_AGENT_CHAT_ID).toBe('sidebar-agent');
    });
  });

  describe('buildChatConfig', () => {
    const mockTransport = new DefaultChatTransport<UIMessage>({ api: '/api/ai/chat' });

    it('given valid params, should return a config with the provided id', () => {
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport });
      expect(config.id).toBe(GLOBAL_CHAT_ID);
    });

    it('given no throttleMs, should default to 100ms', () => {
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport });
      expect(config.experimental_throttle).toBe(100);
    });

    it('given a custom throttleMs, should use it', () => {
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport, throttleMs: 50 });
      expect(config.experimental_throttle).toBe(50);
    });

    it('given a custom onError handler, should use it', () => {
      const handler = vi.fn();
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport, onError: handler });
      expect(config.onError).toBe(handler);
    });

    it('given no onError handler, should provide a default', () => {
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport });
      expect(typeof config.onError).toBe('function');
    });

    it('given the same inputs, should NOT include a messages property', () => {
      const config = buildChatConfig({ id: GLOBAL_CHAT_ID, transport: mockTransport });
      expect(config).not.toHaveProperty('messages');
    });

    it('given the same inputs, should produce deterministic output (purity)', () => {
      const params = { id: GLOBAL_CHAT_ID, transport: mockTransport };
      const a = buildChatConfig(params);
      const b = buildChatConfig(params);
      expect(a.id).toBe(b.id);
      expect(a.transport).toBe(b.transport);
      expect(a.experimental_throttle).toBe(b.experimental_throttle);
    });
  });
});
