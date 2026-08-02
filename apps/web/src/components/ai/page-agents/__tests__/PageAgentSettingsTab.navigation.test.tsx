import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PageAgentSettingsTab from '../PageAgentSettingsTab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/lib/ai/shared/hooks/useAgentMembership', () => ({
  useAgentMembership: () => ({
    membership: null,
    membershipUserRole: 'MEMBER',
    driveRoles: [],
    updateRole: vi.fn(),
    isSaving: false,
  }),
}));

vi.mock('../AgentDrivesCard', () => ({
  AgentDrivesCard: () => <div>Agent drives</div>,
}));

vi.mock('../AgentIntegrationsPanel', () => ({
  AgentIntegrationsPanel: () => <div>Integration connections</div>,
}));

const config = {
  systemPrompt: '',
  enabledTools: [],
  availableTools: [],
  aiProvider: 'openai',
  aiModel: 'gpt-4o',
};

const props = {
  pageId: 'agent-1',
  driveId: 'drive-1',
  config,
  onConfigUpdate: vi.fn(),
  onConfigRevalidate: vi.fn(),
  selectedProvider: 'openai',
  selectedModel: 'gpt-4o',
  onProviderChange: vi.fn(),
  onModelChange: vi.fn(),
  isProviderConfigured: () => true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PageAgentSettingsTab navigation', () => {
  it('given the settings root, should open focused subpages and return to the menu', async () => {
    const user = userEvent.setup();
    render(<PageAgentSettingsTab {...props} />);

    expect(screen.getByRole('button', { name: /behavior/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /access/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tools/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /integrations/i })).toBeInTheDocument();
    expect(screen.queryByText('System Prompt')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /behavior/i }));

    expect(screen.getByRole('heading', { name: 'Behavior' })).toBeInTheDocument();
    expect(screen.getByText('System Prompt')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /agent settings/i }));

    expect(screen.getByRole('button', { name: /integrations/i })).toBeInTheDocument();
    expect(screen.queryByText('System Prompt')).not.toBeInTheDocument();
  });

  it('given two pane settings surfaces, should keep their selected subpages independent', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <section aria-label="First pane">
          <PageAgentSettingsTab {...props} />
        </section>
        <section aria-label="Second pane">
          <PageAgentSettingsTab {...props} />
        </section>
      </>
    );
    const firstPane = within(container.querySelector('[aria-label="First pane"]')!);
    const secondPane = within(container.querySelector('[aria-label="Second pane"]')!);

    await user.click(firstPane.getByRole('button', { name: /tools/i }));

    expect(firstPane.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
    expect(secondPane.getByRole('button', { name: /tools/i })).toBeInTheDocument();
    expect(secondPane.queryByRole('heading', { name: 'Tools' })).not.toBeInTheDocument();
  });

  it('given unsaved edits, should preserve them while navigating through the menu', async () => {
    const user = userEvent.setup();
    render(<PageAgentSettingsTab {...props} />);

    await user.click(screen.getByRole('button', { name: /behavior/i }));
    await user.type(screen.getByLabelText('Custom Instructions'), 'Keep this draft');
    await user.click(screen.getByRole('button', { name: /agent settings/i }));
    await user.click(screen.getByRole('button', { name: /behavior/i }));

    expect(screen.getByLabelText('Custom Instructions')).toHaveValue('Keep this draft');
  });

  it('given no available tools, should render an empty state without an empty scroll viewport', async () => {
    const user = userEvent.setup();
    const { container } = render(<PageAgentSettingsTab {...props} />);

    await user.click(screen.getByRole('button', { name: /tools/i }));

    expect(screen.getByText('No tools are available for this agent.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeInTheDocument();
  });

  it('given the integrations menu item, should expose integrations in the shared settings surface', async () => {
    const user = userEvent.setup();
    render(<PageAgentSettingsTab {...props} />);

    await user.click(screen.getByRole('button', { name: /integrations/i }));

    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByText('Integration connections')).toBeInTheDocument();
  });
});
