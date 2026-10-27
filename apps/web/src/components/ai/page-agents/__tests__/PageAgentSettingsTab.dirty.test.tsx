import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PageAgentSettingsTab, { type PageAgentSettingsTabRef } from '../PageAgentSettingsTab';

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

interface HarnessAgentConfig {
  systemPrompt: string;
  enabledTools: string[];
  availableTools: Array<{ name: string; description: string }>;
  // Optional — matches PageAgentSettingsTab's own AgentConfig shape, where
  // these (and everything past them) are optional.
  aiProvider?: string;
  aiModel?: string;
}

const initialConfig: HarnessAgentConfig = {
  systemPrompt: '',
  enabledTools: [],
  availableTools: [],
  aiProvider: 'openai',
  aiModel: 'gpt-4o',
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Mirrors how a real host (AgentPageView/AgentPanes) actually wires this
 * component — `selectedProvider`/`config` are host-owned state, not inert
 * mocks: `onProviderChange` is `setSelectedProvider`, and `onConfigUpdate`
 * is `setConfig` (accepts the same updater-function form `onSubmit` calls
 * it with, exactly like `useAgentConfig`'s real `setConfig`). Passing bare
 * `vi.fn()`s here would skip every re-render a real save actually causes in
 * production, making this an unfaithful re-creation of the bug.
 */
const Harness = forwardRef<PageAgentSettingsTabRef, { onDirtyChange: (isDirty: boolean) => void }>(
  ({ onDirtyChange }, ref) => {
    const [config, setConfig] = useState(initialConfig);
    const [selectedProvider, setSelectedProvider] = useState('openai');
    return (
      <PageAgentSettingsTab
        ref={ref}
        pageId="agent-1"
        driveId="drive-1"
        config={config}
        onConfigUpdate={(next) => setConfig((current) => (typeof next === 'function' ? next(current) : next))}
        onConfigRevalidate={vi.fn()}
        selectedProvider={selectedProvider}
        selectedModel="gpt-4o"
        onProviderChange={setSelectedProvider}
        onModelChange={vi.fn()}
        isProviderConfigured={() => true}
        onDirtyChange={onDirtyChange}
      />
    );
  },
);
Harness.displayName = 'Harness';

// review finding — chatgpt-codex-connector on this PR: `handleProviderSelectChange`/
// `handleModelSelectChange` update parent-owned `selectedProvider`/`selectedModel`
// state and `providerTouchedRef`/`modelTouchedRef`, never react-hook-form state, so
// `formIsDirty` alone misses a provider/model-only change. A Save button gated on
// `onDirtyChange` must still see this as dirty, or it becomes unsavable through the
// button unless the user also edits an unrelated field.
describe('PageAgentSettingsTab dirty tracking', () => {
  it('reports dirty when only the AI Provider is changed — no other field touched', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();

    render(<Harness onDirtyChange={onDirtyChange} />);
    await user.click(screen.getByRole('button', { name: /behavior/i }));

    expect(onDirtyChange).not.toHaveBeenCalledWith(true);

    // The Provider Select renders before the Model Select in the grid —
    // index 0 is always Provider.
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: /anthropic/i }));

    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('drops back to not-dirty once the provider-only change is actually saved', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();

    const { patch } = await import('@/lib/auth/auth-fetch');
    (patch as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { container } = render(<Harness onDirtyChange={onDirtyChange} />);
    await user.click(screen.getByRole('button', { name: /behavior/i }));

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: /anthropic/i }));
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    onDirtyChange.mockClear();
    // Submit the real <form> (same handleSubmit(onSubmit) the ref's
    // submitForm() also calls) via a real DOM event.
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/api/pages/agent-1/agent-config',
        expect.objectContaining({ aiProvider: 'anthropic' }),
      ),
    );
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
  });
});
