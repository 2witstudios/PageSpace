/**
 * The primary nav's Agents entry.
 *
 * One property, and it is the whole fix: **Agents means "my conversations"**.
 * The link carries no agent selection, so clicking it lands on the
 * conversation list rather than reopening whatever session was last selected.
 *
 * That mattered because `AgentsSurface` renders the list ONLY while nothing is
 * selected, and every existing way to clear a selection destroys the session
 * first — so a link that re-attached the live selection made the surface a
 * room with a door in and no door out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/dashboard/drive-1/agents'),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => false }));
vi.mock('@/hooks/useSidebarBadges', () => ({
  useSidebarBadges: () => ({ dms: 0, channels: 0, files: 0, tasks: 0, calendar: 0 }),
}));

import PrimaryNavigation from '../PrimaryNavigation';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';

const agentsLink = () => screen.getByText('Agents').closest('a')!;

beforeEach(() => {
  useAgentSurfaceStore.setState({
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
});

describe('the Agents nav entry', () => {
  it('carries NO selection even while a session is open — clicking it lands on the conversation list', () => {
    // The exact state the owner was stuck in: a live session selected, on the
    // same drive this nav is scoped to. The link used to spell that selection
    // back out, which reopened the session instead of leaving it.
    useAgentSurfaceStore.setState({
      driveId: 'drive-1',
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });

    render(<PrimaryNavigation driveId="drive-1" />);

    expect(agentsLink()).toHaveAttribute('href', '/dashboard/drive-1/agents');
  });

  it('carries no selection on the global console either', () => {
    useAgentSurfaceStore.setState({
      driveId: null,
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });

    render(<PrimaryNavigation />);

    expect(agentsLink()).toHaveAttribute('href', '/dashboard/agents');
  });

  it('still highlights as active while a session is open', () => {
    // The href stopped carrying a query string, so `isActive` compares
    // `pathname` against it directly. `exact: false` means the whole surface —
    // list and session alike — keeps the entry lit.
    useAgentSurfaceStore.setState({ driveId: 'drive-1', selectedSessionId: 'ses-1' });

    render(<PrimaryNavigation driveId="drive-1" />);

    // Split into class TOKENS: a substring match would be satisfied by the
    // inactive state's own `hover:bg-accent`, which is how the first draft of
    // this test passed against a deliberately broken `isActive`.
    expect(agentsLink().className.split(/\s+/)).toContain('bg-accent');
  });
});
