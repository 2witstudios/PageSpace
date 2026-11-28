/**
 * Agent Signup Phase 2b leaf 5 — an agent's display name is self-chosen, so the
 * marker beside it comes from accountType, never from the name.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentBadge } from '../AgentBadge';
import { MemberRow } from '@/components/members/MemberRow';

describe('AgentBadge', () => {
  it('given an agent account, should render the agent marker', () => {
    render(<AgentBadge accountType="agent" />);
    expect(screen.getByLabelText('AI agent account')).toHaveTextContent('Agent');
  });

  it('given a human, missing or unknown account type, should render nothing', () => {
    for (const accountType of ['human', null, undefined, 'Agent']) {
      const { container, unmount } = render(<AgentBadge accountType={accountType} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe('MemberRow — agent marker', () => {
  const member = (accountType: 'human' | 'agent', name: string) => ({
    id: 'm1', userId: 'u1', role: 'MEMBER', invitedAt: '2026-01-01', acceptedAt: '2026-01-01',
    user: { id: 'u1', email: 'x@y.z', name, accountType },
    profile: undefined, customRole: null, permissionCounts: { view: 0, edit: 0, share: 0 },
  });

  it('given an agent member impersonating staff, should mark it as an agent', () => {
    render(<MemberRow member={member('agent', 'PageSpace Support')} driveId="d1" currentUserRole="MEMBER" onRemove={() => {}} />);
    expect(screen.getByText('PageSpace Support')).toBeInTheDocument();
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('given a human member, should not mark it', () => {
    render(<MemberRow member={member('human', 'Ada')} driveId="d1" currentUserRole="MEMBER" onRemove={() => {}} />);
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});
