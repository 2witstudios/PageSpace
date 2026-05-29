import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectIntegrationDialog } from '../ConnectIntegrationDialog';
import type { SafeProvider } from '../types';

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const githubProvider: SafeProvider = {
  id: 'p1',
  slug: 'github',
  name: 'GitHub',
  description: 'GitHub integration',
  iconUrl: null,
  documentationUrl: null,
  providerType: 'builtin',
  isSystem: true,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  oauthScopeDescriptions: {
    repo: 'Read and write code, issues, and pull requests',
    'read:user': 'Read your GitHub profile',
  },
  connectNotes: 'Agents you grant this connection act as you on GitHub.',
};

const noop = () => {};

describe('ConnectIntegrationDialog', () => {
  it('given an OAuth provider, should show the identity note and plain-English scopes', () => {
    render(
      <ConnectIntegrationDialog
        provider={githubProvider}
        open
        onOpenChange={noop}
        onConnected={noop}
      />
    );

    expect(screen.getByText(/act as you on GitHub/i)).toBeInTheDocument();
    expect(screen.getByText('Access requested')).toBeInTheDocument();
    expect(
      screen.getByText('Read and write code, issues, and pull requests')
    ).toBeInTheDocument();
    expect(screen.getByText('Read your GitHub profile')).toBeInTheDocument();
  });

  it('given user scope, should frame visibility as who can use the connection and point at per-agent tools', () => {
    render(
      <ConnectIntegrationDialog
        provider={githubProvider}
        open
        onOpenChange={noop}
        onConnected={noop}
        scope="user"
      />
    );

    expect(screen.getByText('Who can use this connection')).toBeInTheDocument();
    expect(screen.getByText(/which tools each AI agent can use/i)).toBeInTheDocument();
  });

  it('given a connected button, should label the OAuth action as Authorize', () => {
    render(
      <ConnectIntegrationDialog
        provider={githubProvider}
        open
        onOpenChange={noop}
        onConnected={noop}
      />
    );

    expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
  });
});
