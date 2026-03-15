/**
 * useMCP Hook Tests
 *
 * Tests the MCP server management hook:
 * - Desktop detection
 * - Loading state
 * - Server operations (start/stop/restart) when not desktop
 * - Server operations with desktop (mocked window.electron)
 * - Configuration management (addServer, removeServer, updateConfig)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

import { useMCP } from '../useMCP';

// Helper to set up window.electron mock
function setupElectronMock(overrides: Record<string, unknown> = {}) {
  const mcpMock = {
    getConfig: vi.fn().mockResolvedValue({ mcpServers: {} }),
    getServerStatuses: vi.fn().mockResolvedValue({}),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    startServer: vi.fn().mockResolvedValue({ success: true }),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  Object.defineProperty(window, 'electron', {
    value: {
      isDesktop: true,
      mcp: mcpMock,
    },
    configurable: true,
    writable: true,
  });

  return mcpMock;
}

function removeElectronMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).electron;
}

describe('useMCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeElectronMock();
  });

  afterEach(() => {
    removeElectronMock();
  });

  describe('desktop detection', () => {
    it('should detect non-desktop when window.electron is not present', () => {
      const { result } = renderHook(() => useMCP());

      expect(result.current.isDesktop).toBe(false);
    });

    it('should detect desktop when window.electron.isDesktop is true', async () => {
      setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });
    });
  });

  describe('loading state', () => {
    it('should start in loading state', () => {
      const { result } = renderHook(() => useMCP());

      expect(result.current.loading).toBe(true);
    });
  });

  describe('server operations when not desktop', () => {
    it('should return error from startServer when not running in desktop', async () => {
      const { result } = renderHook(() => useMCP());

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.startServer('test-server');
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Not running in desktop app');
    });

    it('should return error from stopServer when not running in desktop', async () => {
      const { result } = renderHook(() => useMCP());

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.stopServer('test-server');
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Not running in desktop app');
    });

    it('should return error from restartServer when not running in desktop', async () => {
      const { result } = renderHook(() => useMCP());

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.restartServer('test-server');
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Not running in desktop app');
    });
  });

  describe('server operations when desktop', () => {
    it('should start server successfully', async () => {
      const mcpMock = setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean };
      await act(async () => {
        response = await result.current.startServer('my-server');
      });

      expect(mcpMock.startServer).toHaveBeenCalledWith('my-server');
      expect(response!.success).toBe(true);
      expect(mockToast.success).toHaveBeenCalledWith(
        'Server "my-server" started successfully'
      );
    });

    it('should handle startServer failure from electron', async () => {
      const mcpMock = setupElectronMock({
        startServer: vi.fn().mockResolvedValue({ success: false, error: 'Port in use' }),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.startServer('my-server');
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Port in use');
      expect(mockToast.error).toHaveBeenCalledWith('Failed to start server: Port in use');
    });

    it('should handle startServer throwing an error', async () => {
      setupElectronMock({
        startServer: vi.fn().mockRejectedValue(new Error('IPC failure')),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.startServer('my-server');
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('IPC failure');
      expect(mockToast.error).toHaveBeenCalledWith('Error starting server: IPC failure');
    });

    it('should stop server successfully', async () => {
      const mcpMock = setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean };
      await act(async () => {
        response = await result.current.stopServer('my-server');
      });

      expect(mcpMock.stopServer).toHaveBeenCalledWith('my-server');
      expect(response!.success).toBe(true);
      expect(mockToast.success).toHaveBeenCalledWith(
        'Server "my-server" stopped successfully'
      );
    });

    it('should handle stopServer failure', async () => {
      setupElectronMock({
        stopServer: vi.fn().mockResolvedValue({ success: false, error: 'Server not found' }),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.stopServer('my-server');
      });

      expect(response!.success).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith('Failed to stop server: Server not found');
    });

    it('should restart server successfully', async () => {
      const mcpMock = setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      let response: { success: boolean };
      await act(async () => {
        response = await result.current.restartServer('my-server');
      });

      expect(mcpMock.restartServer).toHaveBeenCalledWith('my-server');
      expect(response!.success).toBe(true);
      expect(mockToast.success).toHaveBeenCalledWith(
        'Server "my-server" restarted successfully'
      );
    });
  });

  describe('configuration management', () => {
    it('should return error from updateConfig when not desktop', async () => {
      const { result } = renderHook(() => useMCP());

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.updateConfig({ mcpServers: {} });
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Not running in desktop app');
    });

    it('should update config successfully on desktop', async () => {
      const mcpMock = setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      const newConfig = {
        mcpServers: {
          'test-server': { command: 'node', args: ['server.js'] },
        },
      };

      let response: { success: boolean };
      await act(async () => {
        response = await result.current.updateConfig(newConfig);
      });

      expect(mcpMock.updateConfig).toHaveBeenCalledWith(newConfig);
      expect(response!.success).toBe(true);
      expect(mockToast.success).toHaveBeenCalledWith('Configuration saved successfully');
    });

    it('should handle updateConfig error', async () => {
      setupElectronMock({
        updateConfig: vi.fn().mockRejectedValue(new Error('Invalid configuration')),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let response: { success: boolean; error?: string };
      await act(async () => {
        response = await result.current.updateConfig({ mcpServers: {} });
      });

      expect(response!.success).toBe(false);
      expect(response!.error).toBe('Invalid configuration');
      expect(mockToast.error).toHaveBeenCalledWith('Invalid configuration');

      consoleSpy.mockRestore();
    });

    it('should add a new server to existing config', async () => {
      const mcpMock = setupElectronMock();

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      const serverConfig = { command: 'python', args: ['mcp_server.py'] };

      await act(async () => {
        await result.current.addServer('new-server', serverConfig);
      });

      expect(mcpMock.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({
            'new-server': serverConfig,
          }),
        })
      );
    });

    it('should remove a server from config', async () => {
      // First set up config with an existing server
      const mcpMock = setupElectronMock({
        getConfig: vi.fn().mockResolvedValue({
          mcpServers: {
            'server-a': { command: 'node', args: ['a.js'] },
            'server-b': { command: 'node', args: ['b.js'] },
          },
        }),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      // Wait for config to load
      await waitFor(() => {
        expect(Object.keys(result.current.config.mcpServers).length).toBeGreaterThan(0);
      });

      await act(async () => {
        await result.current.removeServer('server-a');
      });

      // The updateConfig should have been called with server-a removed
      const updateCall = mcpMock.updateConfig.mock.calls[0][0];
      expect(updateCall.mcpServers).not.toHaveProperty('server-a');
      expect(updateCall.mcpServers).toHaveProperty('server-b');
    });
  });

  describe('initial load on desktop', () => {
    it('should load config and statuses when desktop is detected', async () => {
      const mcpMock = setupElectronMock({
        getConfig: vi.fn().mockResolvedValue({
          mcpServers: {
            'my-server': { command: 'node', args: ['server.js'] },
          },
        }),
        getServerStatuses: vi.fn().mockResolvedValue({
          'my-server': { status: 'running', crashCount: 0, enabled: true, autoStart: true },
        }),
      });

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mcpMock.getConfig).toHaveBeenCalled();
      expect(mcpMock.getServerStatuses).toHaveBeenCalled();
      expect(result.current.config.mcpServers).toHaveProperty('my-server');
      expect(result.current.serverStatuses).toHaveProperty('my-server');
    });

    it('should subscribe to status changes', async () => {
      const mcpMock = setupElectronMock();

      renderHook(() => useMCP());

      await waitFor(() => {
        expect(mcpMock.onStatusChange).toHaveBeenCalledWith(expect.any(Function));
      });
    });

    it('should call unsubscribe on unmount', async () => {
      const unsubscribe = vi.fn();
      setupElectronMock({
        onStatusChange: vi.fn().mockReturnValue(unsubscribe),
      });

      const { unmount } = renderHook(() => useMCP());

      await waitFor(() => {
        // Wait for effects to run
      });

      unmount();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('config load error handling', () => {
    it('should show toast error when config loading fails', async () => {
      setupElectronMock({
        getConfig: vi.fn().mockRejectedValue(new Error('Config read failed')),
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useMCP());

      await waitFor(() => {
        expect(result.current.isDesktop).toBe(true);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Failed to load MCP configuration');
      });

      consoleSpy.mockRestore();
    });
  });
});
