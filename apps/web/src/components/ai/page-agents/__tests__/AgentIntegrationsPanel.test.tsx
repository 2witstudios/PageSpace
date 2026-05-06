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

const githubProviderTools = [
  { id: 'create_issue', name: 'create_issue', description: 'Create a new issue', category: 'write' as const },
  { id: 'list_repos', name: 'list_repos', description: 'List repositories', category: 'read' as const },
];

const grantWithTools: SafeGrant = {
  id: 'grant-1',
  agentId: 'agent-1',
  connectionId: 'conn-1',
  allowedTools: ['create_issue', 'list_repos'],
  deniedTools: null,
  readOnly: false,
  rateLimitOverride: null,
  createdAt: '2025-01-01T00:00:00Z',
  connection: { id: 'conn-1', name: 'GitHub Integration', status: 'active', provider: { slug: 'github', name: 'GitHub', tools: githubProviderTools } },
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
  connection: { id: 'conn-1', name: 'GitHub Integration', status: 'active', provider: { slug: 'github', name: 'GitHub', tools: githubProviderTools } },
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

  // --- Tool filtering: shows allowed tools as checkboxes ---
  it('renders provider tools as a checkbox list when grant has allowedTools', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByLabelText('create_issue')).toBeChecked();
    expect(screen.getByLabelText('list_repos')).toBeChecked();
    expect(screen.getByText('Create a new issue')).toBeInTheDocument();
    expect(screen.getByText('List repositories')).toBeInTheDocument();
    expect(screen.getByText(/selected 2 of 2 tools/i)).toBeInTheDocument();
  });

  // --- Tool filtering: update allowed tools ---
  it('calls PUT to update allowedTools when a tool checkbox is unchecked', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    await user.click(screen.getByLabelText('create_issue'));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-1',
        expect.objectContaining({ allowedTools: ['list_repos'] })
      );
    });
  });

  // --- Tool filtering: null allowedTools means all non-dangerous checked ---
  it('renders all tools as checked when allowedTools is null', () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantNoTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByLabelText('create_issue')).toBeChecked();
    expect(screen.getByLabelText('list_repos')).toBeChecked();
    expect(screen.getByText(/selected 2 of 2 tools/i)).toBeInTheDocument();
  });

  // --- Tool filtering: dangerous tools stay unchecked under null allowedTools ---
  it('keeps dangerous tools unchecked when allowedTools is null', async () => {
    const grantWithDangerousTool: SafeGrant = {
      ...grantNoTools,
      id: 'grant-dangerous',
      allowedTools: null,
      connection: {
        id: 'conn-1',
        name: 'GitHub Integration',
        status: 'active',
        provider: {
          slug: 'github',
          name: 'GitHub',
          tools: [
            ...githubProviderTools,
            { id: 'delete_repo', name: 'delete_repo', description: 'Delete a repository', category: 'dangerous' },
          ],
        },
      },
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithDangerousTool],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    expect(screen.getByLabelText('create_issue')).toBeChecked();
    expect(screen.getByLabelText('list_repos')).toBeChecked();
    expect(screen.getByLabelText('delete_repo')).not.toBeChecked();
    expect(screen.getByText(/selected 2 of 3 tools/i)).toBeInTheDocument();

    // Unchecking a non-dangerous tool must NOT silently include the dangerous one
    await user.click(screen.getByLabelText('list_repos'));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-dangerous',
        expect.objectContaining({ allowedTools: ['create_issue'] })
      );
    });
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

  // --- Select All button ---
  it('calls PUT with all tool ids when Select All is clicked', async () => {
    const grantSingleTool: SafeGrant = {
      ...grantWithTools,
      id: 'grant-partial',
      allowedTools: ['list_repos'],
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantSingleTool],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /^select all$/i }));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-partial',
        expect.objectContaining({ allowedTools: ['create_issue', 'list_repos'] })
      );
    });
  });

  // --- Deselect All button ---
  it('calls PUT with empty array when Deselect All is clicked', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /^deselect all$/i }));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-1',
        expect.objectContaining({ allowedTools: [] })
      );
    });
  });

  // --- No-op short-circuits ---
  it('does not call PUT when Select All matches current allowedTools', async () => {
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantWithTools],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /^select all$/i }));

    await new Promise((r) => setTimeout(r, 30));
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('does not call PUT when Deselect All matches an already-empty allowedTools', async () => {
    const grantEmpty: SafeGrant = {
      ...grantWithTools,
      id: 'grant-empty-allowed',
      allowedTools: [],
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantEmpty],
    });
    mockPut.mockResolvedValue({});
    const user = userEvent.setup();

    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /^deselect all$/i }));

    await new Promise((r) => setTimeout(r, 30));
    expect(mockPut).not.toHaveBeenCalled();
  });

  // --- Empty tool list rendering ---
  it('renders fallback message when provider exposes no tools', () => {
    const grantEmptyTools: SafeGrant = {
      ...grantWithTools,
      id: 'grant-empty',
      connection: {
        id: 'conn-1',
        name: 'GitHub Integration',
        status: 'active',
        provider: { slug: 'github', name: 'GitHub', tools: [] },
      },
    };
    mockHooksDefault({
      userConnections: [activeConnection],
      grants: [grantEmptyTools],
    });
    render(<AgentIntegrationsPanel pageId="agent-1" driveId="drive-1" />);
    expect(screen.getByText(/this integration does not expose any tools/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^select all$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^deselect all$/i })).toBeDisabled();
  });

  // --- Tool filtering: unchecking last tool sends empty array ---
  it('sends an empty allowedTools array when the last checked tool is unchecked', async () => {
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

    await user.click(screen.getByLabelText('create_issue'));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations/grant-single',
        expect.objectContaining({ allowedTools: [] })
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
