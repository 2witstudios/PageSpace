import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentIntegrationsPanel } from '../AgentIntegrationsPanel';
import type { SafeConnection, SafeGrant } from '@/components/integrations/types';

// Mock hooks
const mockMutateGrants = vi.fn();
vi.mock('@/hooks/useIntegrations', () => ({
  useAgentGrants: vi.fn(),
  useUserConnections: vi.fn(),
  useDriveConnections: vi.fn(),
}));

// Mock API calls
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDel = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
  put: (...args: unknown[]) => mockPut(...args),
  del: (...args: unknown[]) => mockDel(...args),
}));

// Mock toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useAgentGrants, useUserConnections, useDriveConnections } from '@/hooks/useIntegrations';

// Fixtures
const activeConnection: SafeConnection = {
  id: 'conn-1',
  providerId: 'provider-1',
  name: 'GitHub Integration',
  status: 'active',
  statusMessage: null,
  visibility: 'private',
  accountMetadata: null,
  baseUrlOverride: null,
  lastUsedAt: null,
  createdAt: '2025-01-01T00:00:00Z',
  provider: { id: 'p1', slug: 'github', name: 'GitHub', description: null },
};

const expiredConnection: SafeConnection = {
  id: 'conn-2',
  providerId: 'provider-2',
  name: 'Slack Integration',
  status: 'expired',
  statusMessage: null,
  visibility: 'owned_drives',
  accountMetadata: null,
  baseUrlOverride: null,
  lastUsedAt: null,
  createdAt: '2025-01-01T00:00:00Z',
  provider: { id: 'p2', slug: 'slack', name: 'Slack', description: null },
};

const grantWithTools: SafeGrant = {
  id: 'grant-1',
  agentId: 'agent-1',
  connectionId: 'conn-1',
  allowedTools: ['create_issue', 'list_repos'],
  deniedTools: null,
  readOnly: false,
  rateLimitOverride: null,
  createdAt: '2025-01-01T00:00:00Z',
  connection: { id: 'conn-1', name: 'GitHub Integration', status: 'active', provider: { slug: 'github', name: 'GitHub' } },
};

const grantNoTools: SafeGrant = {
  id: 'grant-2',
  agentId: 'agent-1',
  connectionId: 'conn-1',
  allowedTools: null,
  deniedTools: null,
  readOnly: true,
  rateLimitOverride: { requestsPerMinute: 30 },
  createdAt: '2025-01-01T00:00:00Z',
  connection: { id: 'conn-1', name: 'GitHub Integration', status: 'active', provider: { slug: 'github', name: 'GitHub' } },
};

function mockHooksDefault(overrides: {
  grants?: SafeGrant[];
  userConnections?: SafeConnection[];
  driveConnections?: SafeConnection[];
  loadingGrants?: boolean;
  loadingUser?: boolean;
  loadingDrive?: boolean;
  error?: Error | null;
} = {}) {
  vi.mocked(useAgentGrants).mockReturnValue({
    grants: overrides.grants ?? [],
    isLoading: overrides.loadingGrants ?? false,
    error: overrides.error ?? null,
    mutate: mockMutateGrants,
  });
  vi.mocked(useUserConnections).mockReturnValue({
    connections: overrides.userConnections ?? [],
    isLoading: overrides.loadingUser ?? false,
    error: null,
    mutate: vi.fn(),
  });
  vi.mocked(useDriveConnections).mockReturnValue({
    connections: overrides.driveConnections ?? [],
    isLoading: overrides.loadingDrive ?? false,
    error: null,
    mutate: vi.fn(),
  });
}

describe('AgentIntegrationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Loading ---
  it('renders loading skeletons while fetching', () => {
    mockHooksDefault({ loadingGrants: true });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    // Skeleton uses data-slot="skeleton" from shadcn/ui
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  // --- Error ---
  it('renders error state when hooks error', () => {
    mockHooksDefault({ error: new Error('Network failure') });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/failed to load integrations/i)).toBeInTheDocument();
  });

  // --- Empty state ---
  it('renders helpful empty state when no connections available', () => {
    mockHooksDefault();
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/no integrations available/i)).toBeInTheDocument();
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
  });

  // --- Connection list ---
  it('renders connection list with toggle switches', () => {
    mockHooksDefault({ userConnections: [activeConnection, expiredConnection] });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText('GitHub Integration')).toBeInTheDocument();
    expect(screen.getByText('Slack Integration')).toBeInTheDocument();
    // Should have toggle switches
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(2);
  });

  // --- Disabled switch for non-active ---
  it('disables switch when connection status is not active', () => {
    mockHooksDefault({ userConnections: [expiredConnection] });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    const toggle = screen.getByRole('switch', { name: /enable slack integration/i });
    expect(toggle).toBeDisabled();
  });

  // --- Enable integration ---
  it('calls POST to enable integration on toggle', async () => {
    mockHooksDefault({ userConnections: [activeConnection] });
    mockPost.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    const toggle = screen.getByRole('switch', { name: /enable github integration/i });
    await user.click(toggle);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agent-1/integrations', {
        connectionId: 'conn-1',
      });
    });
    expect(mockMutateGrants).toHaveBeenCalled();
  });

  // --- Disable integration ---
  it('calls DELETE to disable integration on toggle', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    mockDel.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    const toggle = screen.getByRole('switch', { name: /enable github integration/i });
    await user.click(toggle);

    await waitFor(() => {
      expect(mockDel).toHaveBeenCalledWith('/api/agents/agent-1/integrations/grant-1');
    });
    expect(mockMutateGrants).toHaveBeenCalled();
  });

  // --- Expanded config with read-only toggle ---
  it('shows expanded config with read-only toggle when grant exists', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantNoTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/read-only mode/i)).toBeInTheDocument();
  });

  // --- Read-only toggle calls PUT ---
  it('calls PUT to update read-only when toggled', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantNoTools],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    // Find the read-only switch (not the main enable switch)
    const readOnlySwitch = screen.getByLabelText(/read-only mode/i);
    await user.click(readOnlySwitch);

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-2',
        expect.objectContaining({ readOnly: false })
      );
    });
  });

  // --- Tool filtering: shows allowed tools ---
  it('displays tool filter section when grant has allowedTools', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/tool access/i)).toBeInTheDocument();
    expect(screen.getByText('create_issue')).toBeInTheDocument();
    expect(screen.getByText('list_repos')).toBeInTheDocument();
  });

  // --- Tool filtering: update allowed tools ---
  it('calls PUT to update allowedTools when a tool chip is removed', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    // Find the remove button for create_issue tool
    const removeButton = screen.getByRole('button', { name: /remove create_issue/i });
    await user.click(removeButton);

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-1',
        expect.objectContaining({ allowedTools: ['list_repos'] })
      );
    });
  });

  // --- Tool filtering: all tools when allowedTools is null ---
  it('shows "All tools" indicator when allowedTools is null', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantNoTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/all tools/i)).toBeInTheDocument();
  });

  // --- Deduplication ---
  it('deduplicates connections from user and drive scopes', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      driveConnections: [activeConnection], // Same connection
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    // Should only render once
    const items = screen.getAllByText('GitHub Integration');
    expect(items.length).toBe(1);
  });

  // --- Tool filtering: removing last tool sets allowedTools to null ---
  it('sets allowedTools to null when the last tool is removed', async () => {
    const grantSingleTool: SafeGrant = {
      ...grantWithTools,
      id: 'grant-single',
      allowedTools: ['create_issue'],
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantSingleTool],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    const removeButton = screen.getByRole('button', { name: /remove create_issue/i });
    await user.click(removeButton);

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-single',
        expect.objectContaining({ allowedTools: null })
      );
    });
  });

  // --- Error toast on enable failure ---
  it('shows error toast when enabling integration fails', async () => {
    const { toast } = await import('sonner');
    mockHooksDefault({ userConnections: [activeConnection] });
    mockPost.mockRejectedValue(new Error('Connection refused'));
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    const toggle = screen.getByRole('switch', { name: /enable github integration/i });
    await user.click(toggle);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Connection refused');
    });
  });

  // --- Error toast on grant update failure ---
  it('shows error toast when grant update fails', async () => {
    const { toast } = await import('sonner');
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantNoTools],
    });
    mockPut.mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    const readOnlySwitch = screen.getByLabelText(/read-only mode/i);
    await user.click(readOnlySwitch);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update grant settings');
    });
  });

  // --- Visibility badge ---
  it('shows "User" badge for private connections and "Drive" for drive-scoped', () => {
    const driveConn: SafeConnection = {
      ...activeConnection,
      id: 'conn-drive',
      name: 'Drive Integration',
      visibility: 'owned_drives',
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      driveConnections: [driveConn],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Drive')).toBeInTheDocument();
  });
});
