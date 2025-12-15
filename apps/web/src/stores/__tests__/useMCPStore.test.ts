/**
 * useMCPStore Tests
 * Tests for MCP server settings and per-chat MCP toggle state
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useMCPStore } from '../useMCPStore';

// Mock localStorage for persistence tests
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

describe('useMCPStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useMCPStore.setState({ perChatMCP: {} });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty perChatMCP map', () => {
      const { perChatMCP } = useMCPStore.getState();
      expect(perChatMCP).toEqual({});
    });
  });

  describe('isChatMCPEnabled', () => {
    it('given no per-chat setting exists, should return true (default enabled)', () => {
      const { isChatMCPEnabled } = useMCPStore.getState();

      expect(isChatMCPEnabled('new-chat-123')).toBe(true);
    });

    it('given chat was explicitly enabled, should return true', () => {
      const { setChatMCPEnabled, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-123', true);

      expect(isChatMCPEnabled('chat-123')).toBe(true);
    });

    it('given chat was explicitly disabled, should return false', () => {
      const { setChatMCPEnabled, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-123', false);

      expect(isChatMCPEnabled('chat-123')).toBe(false);
    });
  });

  describe('setChatMCPEnabled', () => {
    it('given a chat ID and enabled=true, should set the value', () => {
      const { setChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-123', true);

      const { perChatMCP } = useMCPStore.getState();
      expect(perChatMCP['chat-123']).toBe(true);
    });

    it('given a chat ID and enabled=false, should set the value', () => {
      const { setChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-456', false);

      const { perChatMCP } = useMCPStore.getState();
      expect(perChatMCP['chat-456']).toBe(false);
    });

    it('given multiple chats, should track each independently', () => {
      const { setChatMCPEnabled, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-1', true);
      setChatMCPEnabled('chat-2', false);
      setChatMCPEnabled('chat-3', true);

      expect(isChatMCPEnabled('chat-1')).toBe(true);
      expect(isChatMCPEnabled('chat-2')).toBe(false);
      expect(isChatMCPEnabled('chat-3')).toBe(true);
    });

    it('given an existing setting, should update the value', () => {
      const { setChatMCPEnabled, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-123', true);
      expect(isChatMCPEnabled('chat-123')).toBe(true);

      setChatMCPEnabled('chat-123', false);
      expect(isChatMCPEnabled('chat-123')).toBe(false);
    });
  });

  describe('clearChatMCPSettings', () => {
    it('given a chat with MCP setting, should remove the setting', () => {
      const { setChatMCPEnabled, clearChatMCPSettings, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-123', false);
      expect(isChatMCPEnabled('chat-123')).toBe(false);

      clearChatMCPSettings('chat-123');

      // Should return default (true) since setting was cleared
      expect(isChatMCPEnabled('chat-123')).toBe(true);
      expect(useMCPStore.getState().perChatMCP['chat-123']).toBeUndefined();
    });

    it('given a non-existent chat ID, should not throw', () => {
      const { clearChatMCPSettings } = useMCPStore.getState();

      expect(() => clearChatMCPSettings('non-existent')).not.toThrow();
    });

    it('given multiple chats, should only clear the specified one', () => {
      const { setChatMCPEnabled, clearChatMCPSettings, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-1', false);
      setChatMCPEnabled('chat-2', false);
      setChatMCPEnabled('chat-3', false);

      clearChatMCPSettings('chat-2');

      expect(isChatMCPEnabled('chat-1')).toBe(false);
      expect(isChatMCPEnabled('chat-2')).toBe(true); // Default after clear
      expect(isChatMCPEnabled('chat-3')).toBe(false);
    });
  });

  describe('clearAllChatMCPSettings', () => {
    it('given multiple chats with settings, should clear all of them', () => {
      const { setChatMCPEnabled, clearAllChatMCPSettings, isChatMCPEnabled } = useMCPStore.getState();

      setChatMCPEnabled('chat-1', false);
      setChatMCPEnabled('chat-2', false);
      setChatMCPEnabled('chat-3', true);

      clearAllChatMCPSettings();

      // All should return default (true)
      expect(isChatMCPEnabled('chat-1')).toBe(true);
      expect(isChatMCPEnabled('chat-2')).toBe(true);
      expect(isChatMCPEnabled('chat-3')).toBe(true);
      expect(useMCPStore.getState().perChatMCP).toEqual({});
    });

    it('given empty store, should not throw', () => {
      const { clearAllChatMCPSettings } = useMCPStore.getState();

      expect(() => clearAllChatMCPSettings()).not.toThrow();
    });
  });

  describe('opt-out model behavior', () => {
    it('given new chat, MCP should be enabled by default (opt-out model)', () => {
      const { isChatMCPEnabled } = useMCPStore.getState();

      // A brand new chat should have MCP enabled
      expect(isChatMCPEnabled('brand-new-chat')).toBe(true);
    });

    it('given user explicitly disables MCP, should remember the setting', () => {
      const { setChatMCPEnabled, isChatMCPEnabled } = useMCPStore.getState();

      // User opts out
      setChatMCPEnabled('user-chat', false);

      expect(isChatMCPEnabled('user-chat')).toBe(false);
    });
  });
});
