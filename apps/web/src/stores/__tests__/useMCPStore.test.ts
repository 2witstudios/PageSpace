/**
 * useMCPStore Tests
 * Tests for MCP server settings and per-chat, per-server MCP toggle state
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
    useMCPStore.setState({ perChatServerMCP: {} });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty perChatServerMCP map', () => {
      const { perChatServerMCP } = useMCPStore.getState();
      expect(perChatServerMCP).toEqual({});
    });
  });

  describe('isServerEnabled', () => {
    it('given no per-chat setting exists, should return true (default enabled)', () => {
      const { isServerEnabled } = useMCPStore.getState();

      expect(isServerEnabled('new-chat-123', 'server-a')).toBe(true);
    });

    it('given server was explicitly enabled, should return true', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-123', 'server-a', true);

      expect(isServerEnabled('chat-123', 'server-a')).toBe(true);
    });

    it('given server was explicitly disabled, should return false', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-123', 'server-a', false);

      expect(isServerEnabled('chat-123', 'server-a')).toBe(false);
    });
  });

  describe('setServerEnabled', () => {
    it('given a chat ID, server name and enabled=true, should set the value', () => {
      const { setServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-123', 'server-a', true);

      const { perChatServerMCP } = useMCPStore.getState();
      expect(perChatServerMCP['chat-123']['server-a']).toBe(true);
    });

    it('given a chat ID, server name and enabled=false, should set the value', () => {
      const { setServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-456', 'server-b', false);

      const { perChatServerMCP } = useMCPStore.getState();
      expect(perChatServerMCP['chat-456']['server-b']).toBe(false);
    });

    it('given multiple servers in same chat, should track each independently', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-1', 'server-a', true);
      setServerEnabled('chat-1', 'server-b', false);
      setServerEnabled('chat-1', 'server-c', true);

      expect(isServerEnabled('chat-1', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-1', 'server-b')).toBe(false);
      expect(isServerEnabled('chat-1', 'server-c')).toBe(true);
    });

    it('given multiple chats, should track each independently', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-1', 'server-a', true);
      setServerEnabled('chat-2', 'server-a', false);

      expect(isServerEnabled('chat-1', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-2', 'server-a')).toBe(false);
    });

    it('given an existing setting, should update the value', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-123', 'server-a', true);
      expect(isServerEnabled('chat-123', 'server-a')).toBe(true);

      setServerEnabled('chat-123', 'server-a', false);
      expect(isServerEnabled('chat-123', 'server-a')).toBe(false);
    });
  });

  describe('setAllServersEnabled', () => {
    it('given server names and enabled=true, should enable all servers', () => {
      const { setAllServersEnabled, isServerEnabled } = useMCPStore.getState();
      const servers = ['server-a', 'server-b', 'server-c'];

      setAllServersEnabled('chat-123', true, servers);

      expect(isServerEnabled('chat-123', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-123', 'server-b')).toBe(true);
      expect(isServerEnabled('chat-123', 'server-c')).toBe(true);
    });

    it('given server names and enabled=false, should disable all servers', () => {
      const { setAllServersEnabled, isServerEnabled } = useMCPStore.getState();
      const servers = ['server-a', 'server-b', 'server-c'];

      setAllServersEnabled('chat-123', false, servers);

      expect(isServerEnabled('chat-123', 'server-a')).toBe(false);
      expect(isServerEnabled('chat-123', 'server-b')).toBe(false);
      expect(isServerEnabled('chat-123', 'server-c')).toBe(false);
    });
  });

  describe('areAllServersEnabled', () => {
    it('given all servers enabled, should return true', () => {
      const { setAllServersEnabled, areAllServersEnabled } = useMCPStore.getState();
      const servers = ['server-a', 'server-b'];

      setAllServersEnabled('chat-123', true, servers);

      expect(areAllServersEnabled('chat-123', servers)).toBe(true);
    });

    it('given some servers disabled, should return false', () => {
      const { setServerEnabled, areAllServersEnabled } = useMCPStore.getState();
      const servers = ['server-a', 'server-b'];

      setServerEnabled('chat-123', 'server-a', true);
      setServerEnabled('chat-123', 'server-b', false);

      expect(areAllServersEnabled('chat-123', servers)).toBe(false);
    });

    it('given no settings (all default), should return true', () => {
      const { areAllServersEnabled } = useMCPStore.getState();
      const servers = ['server-a', 'server-b'];

      // Default is enabled
      expect(areAllServersEnabled('new-chat', servers)).toBe(true);
    });

    it('given empty server list, should return false', () => {
      const { areAllServersEnabled } = useMCPStore.getState();

      expect(areAllServersEnabled('chat-123', [])).toBe(false);
    });
  });

  describe('getEnabledServers', () => {
    it('given all servers enabled, should return all servers', () => {
      const { setAllServersEnabled, getEnabledServers } = useMCPStore.getState();
      const servers = ['server-a', 'server-b', 'server-c'];

      setAllServersEnabled('chat-123', true, servers);

      expect(getEnabledServers('chat-123', servers)).toEqual(servers);
    });

    it('given some servers disabled, should return only enabled ones', () => {
      const { setServerEnabled, getEnabledServers } = useMCPStore.getState();
      const servers = ['server-a', 'server-b', 'server-c'];

      setServerEnabled('chat-123', 'server-a', true);
      setServerEnabled('chat-123', 'server-b', false);
      setServerEnabled('chat-123', 'server-c', true);

      expect(getEnabledServers('chat-123', servers)).toEqual(['server-a', 'server-c']);
    });

    it('given no settings (all default), should return all servers', () => {
      const { getEnabledServers } = useMCPStore.getState();
      const servers = ['server-a', 'server-b'];

      // Default is enabled
      expect(getEnabledServers('new-chat', servers)).toEqual(servers);
    });
  });

  describe('clearChatMCPSettings', () => {
    it('given a chat with MCP settings, should remove all settings for that chat', () => {
      const { setServerEnabled, clearChatMCPSettings, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-123', 'server-a', false);
      setServerEnabled('chat-123', 'server-b', false);
      expect(isServerEnabled('chat-123', 'server-a')).toBe(false);

      clearChatMCPSettings('chat-123');

      // Should return default (true) since settings were cleared
      expect(isServerEnabled('chat-123', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-123', 'server-b')).toBe(true);
      expect(useMCPStore.getState().perChatServerMCP['chat-123']).toBeUndefined();
    });

    it('given a non-existent chat ID, should not throw', () => {
      const { clearChatMCPSettings } = useMCPStore.getState();

      expect(() => clearChatMCPSettings('non-existent')).not.toThrow();
    });

    it('given multiple chats, should only clear the specified one', () => {
      const { setServerEnabled, clearChatMCPSettings, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-1', 'server-a', false);
      setServerEnabled('chat-2', 'server-a', false);
      setServerEnabled('chat-3', 'server-a', false);

      clearChatMCPSettings('chat-2');

      expect(isServerEnabled('chat-1', 'server-a')).toBe(false);
      expect(isServerEnabled('chat-2', 'server-a')).toBe(true); // Default after clear
      expect(isServerEnabled('chat-3', 'server-a')).toBe(false);
    });
  });

  describe('clearAllChatMCPSettings', () => {
    it('given multiple chats with settings, should clear all of them', () => {
      const { setServerEnabled, clearAllChatMCPSettings, isServerEnabled } = useMCPStore.getState();

      setServerEnabled('chat-1', 'server-a', false);
      setServerEnabled('chat-2', 'server-a', false);
      setServerEnabled('chat-3', 'server-a', true);

      clearAllChatMCPSettings();

      // All should return default (true)
      expect(isServerEnabled('chat-1', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-2', 'server-a')).toBe(true);
      expect(isServerEnabled('chat-3', 'server-a')).toBe(true);
      expect(useMCPStore.getState().perChatServerMCP).toEqual({});
    });

    it('given empty store, should not throw', () => {
      const { clearAllChatMCPSettings } = useMCPStore.getState();

      expect(() => clearAllChatMCPSettings()).not.toThrow();
    });
  });

  describe('opt-out model behavior', () => {
    it('given new chat and server, should be enabled by default (opt-out model)', () => {
      const { isServerEnabled } = useMCPStore.getState();

      // A brand new chat/server should have MCP enabled
      expect(isServerEnabled('brand-new-chat', 'any-server')).toBe(true);
    });

    it('given user explicitly disables a server, should remember the setting', () => {
      const { setServerEnabled, isServerEnabled } = useMCPStore.getState();

      // User opts out of specific server
      setServerEnabled('user-chat', 'server-x', false);

      expect(isServerEnabled('user-chat', 'server-x')).toBe(false);
      // Other servers still default to enabled
      expect(isServerEnabled('user-chat', 'server-y')).toBe(true);
    });
  });
});
