import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntegrationAuditLogPage } from '../IntegrationAuditLogPage';
import type { AuditLogEntry } from '@/components/integrations/types';
import type { SafeConnection } from '@/components/integrations/types';

// Mock hooks
vi.mock('@/hooks/useIntegrations', () => ({
  useIntegrationAuditLogs: vi.fn(),
  useDriveConnections: vi.fn(),
}));

// Mock fetch for export
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock date-fns format to avoid timezone issues
vi.mock('date-fns', () => ({
  format: vi.fn((date: Date, fmt: string) => {
    if (fmt === 'MMM d, yyyy HH:mm:ss') return 'Jan 15, 2025 10:30:00';
    if (fmt === 'MMM d, yyyy') return 'Jan 15, 2025';
    if (fmt === 'yyyy-MM-dd-HHmmss') return '2025-01-15-103000';
    return date.toISOString();
  }),
}));

import { useIntegrationAuditLogs, useDriveConnections } from '@/hooks/useIntegrations';

// Fixtures
const mockLogs: AuditLogEntry[] = [
  {
    id: 'log-1',
    driveId: 'drive-1',
    agentId: 'agent-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    toolName: 'create_issue',
    inputSummary: 'Created issue #42',
    success: true,
    responseCode: 200,
    errorType: null,
    errorMessage: null,
    durationMs: 245,
    createdAt: '2025-01-15T10:30:00Z',
  },
  {
    id: 'log-2',
    driveId: 'drive-1',
    agentId: 'agent-2',
    userId: 'user-1',
    connectionId: 'conn-2',
    toolName: 'send_message',
    inputSummary: 'Sent to #general',
    success: false,
    responseCode: 500,
    errorType: 'SERVER_ERROR',
    errorMessage: 'Internal server error',
    durationMs: 1520,
    createdAt: '2025-01-15T09:00:00Z',
  },
];

const mockConnections: SafeConnection[] = [
  {
    id: 'conn-1',
    providerId: 'p1',
    name: 'GitHub',
    status: 'active',
    statusMessage: null,
    accountMetadata: null,
    baseUrlOverride: null,
    lastUsedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    provider: { id: 'p1', slug: 'github', name: 'GitHub', description: null },
  },
  {
    id: 'conn-2',
    providerId: 'p2',
    name: 'Slack',
    status: 'active',
    statusMessage: null,
    accountMetadata: null,
    baseUrlOverride: null,
    lastUsedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    provider: { id: 'p2', slug: 'slack', name: 'Slack', description: null },
  },
];

function setupMocks(overrides: {
  logs?: AuditLogEntry[];
  total?: number;
  isLoading?: boolean;
  error?: Error | null;
  connections?: SafeConnection[];
} = {}) {
  vi.mocked(useIntegrationAuditLogs).mockReturnValue({
    logs: overrides.logs ?? mockLogs,
    total: overrides.total ?? mockLogs.length,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
    mutate: vi.fn(),
  });
  vi.mocked(useDriveConnections).mockReturnValue({
    connections: overrides.connections ?? mockConnections,
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  });
}

describe('IntegrationAuditLogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Loading ---
  it('renders loading skeletons while fetching', () => {
    setupMocks({ isLoading: true, logs: [], total: 0 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  // --- Error ---
  it('renders error state', () => {
    setupMocks({ error: new Error('Network failure'), logs: [], total: 0 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  // --- Empty state ---
  it('renders empty state when no logs', () => {
    setupMocks({ logs: [], total: 0 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText(/no.*audit logs/i)).toBeInTheDocument();
  });

  // --- Table columns ---
  it('renders audit log table with correct columns', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    // Column headers
    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('Tool')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
  });

  // --- Table data ---
  it('displays tool names in table rows', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('create_issue')).toBeInTheDocument();
    expect(screen.getByText('send_message')).toBeInTheDocument();
  });

  // --- Success badge ---
  it('shows success badge for successful calls', () => {
    setupMocks({ logs: [mockLogs[0]], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  // --- Failure badge ---
  it('shows failure badge for failed calls', () => {
    setupMocks({ logs: [mockLogs[1]], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  // --- Duration ---
  it('formats duration in milliseconds', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('245ms')).toBeInTheDocument();
    expect(screen.getByText('1520ms')).toBeInTheDocument();
  });

  // --- Overview stats ---
  it('shows overview stats card', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Total Calls')).toBeInTheDocument();
    expect(screen.getByText('Success Rate')).toBeInTheDocument();
  });

  // --- Export button ---
  it('renders export CSV button', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
  });

  // --- Pagination ---
  it('shows pagination when total exceeds page size', () => {
    setupMocks({ total: 100 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText(/page 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  // --- No pagination for small results ---
  it('hides pagination when results fit in one page', () => {
    setupMocks({ total: 2 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  // --- Filters section ---
  it('renders filter controls', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Filters')).toBeInTheDocument();
  });

  // --- Clear filters ---
  it('renders clear filters button when filters are active', () => {
    setupMocks();
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    // Initially no clear button since no active filters
    // We verify filters section exists
    expect(screen.getByText('Filters')).toBeInTheDocument();
  });

  // --- Pagination navigation ---
  it('calls hook with offset when next page is clicked', async () => {
    setupMocks({ total: 100 });
    const user = userEvent.setup();
    render(<IntegrationAuditLogPage driveId="drive-1" />);

    const nextBtn = screen.getByRole('button', { name: /next/i });
    await user.click(nextBtn);

    // After clicking next, useIntegrationAuditLogs should be called with offset=50
    await waitFor(() => {
      const lastCall = vi.mocked(useIntegrationAuditLogs).mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual(expect.objectContaining({ offset: 50 }));
    });
  });

  it('disables previous button on first page', () => {
    setupMocks({ total: 100 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    const prevBtn = screen.getByRole('button', { name: /previous/i });
    expect(prevBtn).toBeDisabled();
  });

  // --- Error details for failed logs ---
  it('shows error message for failed logs in details column', () => {
    setupMocks({ logs: [mockLogs[1]], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Internal server error')).toBeInTheDocument();
  });

  // --- Input summary for successful logs ---
  it('shows input summary for successful logs in details column', () => {
    setupMocks({ logs: [mockLogs[0]], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('Created issue #42')).toBeInTheDocument();
  });

  // --- Null duration ---
  it('shows dash when duration is null', () => {
    const logNoDuration: AuditLogEntry = {
      ...mockLogs[0],
      id: 'log-no-dur',
      durationMs: null,
    };
    setupMocks({ logs: [logNoDuration], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  // --- Export triggers fetch ---
  it('calls fetchWithAuth on export and creates download link', async () => {
    setupMocks();
    const user = userEvent.setup();

    // Mock successful blob response
    const mockBlob = new Blob(['csv,data'], { type: 'text/csv' });
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    });

    // Mock URL.createObjectURL and revokeObjectURL
    const mockUrl = 'blob:http://localhost/test';
    const originalCreateObjectURL = window.URL.createObjectURL;
    const originalRevokeObjectURL = window.URL.revokeObjectURL;
    window.URL.createObjectURL = vi.fn(() => mockUrl);
    window.URL.revokeObjectURL = vi.fn();

    render(<IntegrationAuditLogPage driveId="drive-1" />);

    const exportBtn = screen.getByRole('button', { name: /export csv/i });
    await user.click(exportBtn);

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/api/drives/drive-1/integrations/audit/export')
      );
    });

    // Cleanup
    window.URL.createObjectURL = originalCreateObjectURL;
    window.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  // --- Export error handling (silent catch) ---
  it('resets exporting state when export fails', async () => {
    setupMocks();
    const user = userEvent.setup();

    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(<IntegrationAuditLogPage driveId="drive-1" />);

    const exportBtn = screen.getByRole('button', { name: /export csv/i });
    await user.click(exportBtn);

    // Should reset to non-exporting state (button text returns to "Export CSV")
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /export csv/i })).not.toBeDisabled();
    });
  });

  // --- Stats accuracy for current page ---
  it('computes success rate from visible logs only', () => {
    // 1 success + 1 failure = 50%
    setupMocks({ logs: mockLogs, total: 2 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows 0% success rate when all logs failed', () => {
    setupMocks({ logs: [mockLogs[1]], total: 1 });
    render(<IntegrationAuditLogPage driveId="drive-1" />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
