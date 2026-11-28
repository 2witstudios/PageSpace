/**
 * Agent Signup Phase 2c — the activity feed marks an agent actor at render,
 * from the live `users.accountType` the API joins on the actor id (fork ruling
 * (a)). An erased actor has no user row, so it shows its stored name unmarked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
}));

import { ActivityItem } from '../ActivityItem';
import { ActivityGroupItem } from '../ActivityGroupItem';
import { ActorFilter } from '../ActorFilter';
import { groupConsecutiveActivities } from '../utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { ActivityLog, ActivityUser } from '../types';

const user = (name: string, accountType: 'human' | 'agent'): ActivityUser => ({
  id: `u-${name}`,
  name,
  email: `${name.toLowerCase()}@example.com`,
  image: null,
  accountType,
});

function activity(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: 'act-1',
    timestamp: new Date().toISOString(),
    userId: 'u-1',
    actorEmail: 'actor@example.com',
    actorDisplayName: 'Stored Name',
    operation: 'update',
    resourceType: 'page',
    resourceId: 'page-1',
    resourceTitle: 'Page',
    driveId: 'drive-1',
    pageId: 'page-1',
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    changeGroupId: null,
    updatedFields: null,
    previousValues: null,
    newValues: null,
    metadata: null,
    rollbackFromActivityId: null,
    rollbackSourceOperation: null,
    rollbackSourceTimestamp: null,
    rollbackSourceTitle: null,
    user: null,
    ...overrides,
  };
}

describe('ActivityItem — agent marker', () => {
  it('given an agent actor, should render the agent badge beside the name', () => {
    render(<ActivityItem activity={activity({ user: user('Helper', 'agent') })} />);
    expect(screen.getByText('Helper')).toBeInTheDocument();
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('given a human actor, should render the name with no badge', () => {
    render(<ActivityItem activity={activity({ user: user('Jane', 'human') })} />);
    expect(screen.getByText('Jane')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });

  it('given an erased actor (no user row), should render the stored name unmarked', () => {
    render(<ActivityItem activity={activity({ user: null, actorDisplayName: 'Deleted User' })} />);
    expect(screen.getByText('Deleted User')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});

describe('activity group summary — agent marker', () => {
  const stream = (u: ActivityUser | null) =>
    groupConsecutiveActivities([
      activity({ id: 'a', aiConversationId: 'conv', isAiGenerated: true, user: u }),
      activity({ id: 'b', aiConversationId: 'conv', isAiGenerated: true, user: u }),
    ]);

  it('carries the first actor accountType, null for an erased actor', () => {
    const [agentGroup] = stream(user('Helper', 'agent'));
    const [erasedGroup] = stream(null);
    expect(agentGroup.type !== 'single' && agentGroup.summary.actorAccountType).toBe('agent');
    expect(erasedGroup.type !== 'single' && erasedGroup.summary.actorAccountType).toBeNull();
  });

  it('ActivityGroupItem renders the badge for an agent group only', () => {
    const [agentGroup] = stream(user('Helper', 'agent'));
    const [humanGroup] = stream(user('Jane', 'human'));
    if (agentGroup.type === 'single' || humanGroup.type === 'single') throw new Error('expected groups');

    const { unmount } = render(<ActivityGroupItem group={agentGroup} />);
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
    unmount();

    render(<ActivityGroupItem group={humanGroup} />);
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});

describe('ActorFilter — agent marker', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        actors: [{ id: 'agent-1', name: 'Helper', email: 'a@agents.invalid', image: null, accountType: 'agent' }],
      }),
    } as unknown as Response);
  });

  it('marks the selected agent actor on the trigger', async () => {
    render(<ActorFilter context="drive" driveId="drive-1" value="agent-1" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Helper')).toBeInTheDocument());
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('shows no marker on the trigger for a human actor', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        actors: [{ id: 'u-1', name: 'Jane', email: 'j@example.com', image: null, accountType: 'human' }],
      }),
    } as unknown as Response);
    render(<ActorFilter context="drive" driveId="drive-1" value="u-1" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Jane')).toBeInTheDocument());
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});
