// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import type { MCPConfig } from '@/retained/types/mcp';
import LocalMCPSettingsPage from './page';

const state = vi.hoisted(() => ({
  isDesktop: true,
  loading: false,
  config: {} as { mcpServers: Record<string, { command: string; args: string[] }> },
  serverStatuses: {} as Record<string, Partial<{ status: string; error: string; crashCount: number; enabled: boolean; autoStart: boolean }>>,
}));

vi.mock('@/retained/hooks/useMCP', () => ({
  useMCP: () => ({
    isDesktop: state.isDesktop,
    loading: state.loading,
    config: state.config,
    serverStatuses: state.serverStatuses,
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    updateConfig: vi.fn(async () => ({ success: true })),
    removeServer: vi.fn(),
  }),
}));

const serverConfig: MCPConfig = {
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Studio'] },
    sqlite: { command: 'uvx', args: ['mcp-server-sqlite'] },
    playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
  },
};

afterEach(() => {
  unmountAll();
  state.isDesktop = true;
  state.loading = false;
});

describe('LocalMCPSettingsPage', () => {
  test('renders each server with its status, command, error line and Stop, Restart, Start and Remove', () => {
    state.config = serverConfig;
    state.serverStatuses = {
      filesystem: { status: 'running', enabled: true, autoStart: true, crashCount: 0 },
      sqlite: { status: 'crashed', error: 'unable to open database file', enabled: true, autoStart: true, crashCount: 3 },
      playwright: { status: 'stopped', enabled: false, autoStart: false, crashCount: 0 },
    };
    const container = mount(<LocalMCPSettingsPage />);
    const text = container.textContent ?? '';
    assert({
      given: 'a desktop bridge with a running, a crashed and a stopped server',
      should: 'show each status, the error line, the crash count and the matching action buttons',
      actual: {
        statuses: ['Running', 'Crashed', 'Stopped'].map((s) => text.includes(s)),
        error: text.includes('Error: unable to open database file'),
        crashes: text.includes('3 crashes'),
        restartStop: [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Restart')) &&
          [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Stop')),
        start: [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Start'),
        remove: ['Remove filesystem', 'Remove sqlite', 'Remove playwright'].map(
          (label) => container.querySelector(`button[aria-label="${label}"]`) !== null,
        ),
      },
      expected: {
        statuses: [true, true, true],
        error: true,
        crashes: true,
        restartStop: true,
        start: true,
        remove: [true, true, true],
      },
    });
  });

  test('renders the MCP servers JSON with Reset and Save configuration', () => {
    state.config = serverConfig;
    const container = mount(<LocalMCPSettingsPage />);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    assert({
      given: 'the desktop screen',
      should: 'render the MCP servers JSON textarea with Reset and Save configuration',
      actual: {
        textarea: container.querySelector('textarea[aria-label="MCP servers JSON"]') !== null,
        reset: buttons.includes('Reset'),
        save: buttons.includes('Save configuration'),
      },
      expected: { textarea: true, reset: true, save: true },
    });
  });

  test('shows the desktop-only message and no server editor off desktop', () => {
    state.isDesktop = false;
    const container = mount(<LocalMCPSettingsPage />);
    assert({
      given: 'a browser without the desktop bridge',
      should: 'say the feature is desktop only and render no JSON editor',
      actual: {
        message: container.textContent?.includes('Desktop only.') ?? false,
        textarea: container.querySelector('textarea') !== null,
      },
      expected: { message: true, textarea: false },
    });
  });
});
