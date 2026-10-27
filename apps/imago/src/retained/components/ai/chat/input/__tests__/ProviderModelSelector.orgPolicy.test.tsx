// @vitest-environment jsdom
import '@/retained/test/setup';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The model picker in an org drive offers only what the org allows (Spec POL-8). The server computes the list
 * (GET /api/ai/settings?driveId=…, allowedModels); the picker hides every provider and model outside it.
 */
const fetchWithAuth = vi.fn();
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  patch: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { ProviderModelSelector } from '../ProviderModelSelector';

const settings = (allowedModels: Record<string, string[] | null> | null) => ({
  ok: true,
  json: async () => ({
    currentProvider: 'openai',
    currentModel: 'openai/gpt-6-luna',
    userSubscriptionTier: 'business',
    isAdmin: false,
    providers: { openai: { isAvailable: true }, anthropic: { isAvailable: true }, google: { isAvailable: true } },
    allowedModels,
  }),
});

describe('ProviderModelSelector under an org model allowlist', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it('POL-8 (partial) asks the server for the drive\'s list and shows only the providers and models the org allows', async () => {
    fetchWithAuth.mockResolvedValue(settings({ openai: ['openai/gpt-6-luna-pro'] }));
    render(<ProviderModelSelector provider="openai" model="openai/gpt-6-luna-pro" driveId="drive-org" />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/ai/settings?driveId=drive-org'));
    fireEvent.click(await screen.findByText('OpenAI'));
    // The popover is open: OpenAI is listed as well as on the trigger.
    expect(await screen.findAllByText('OpenAI')).toHaveLength(2);
    expect(screen.queryByText('Anthropic')).not.toBeInTheDocument();
    expect(screen.queryByText('Google')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText('GPT-6 Luna Pro')[0]);
    expect(await screen.findAllByText('GPT-6 Luna Pro')).toHaveLength(2);
    expect(screen.queryByText('GPT-6 Sol')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-6 Luna')).not.toBeInTheDocument();
  });

  it('POL-8 (partial) with no restriction (allowedModels null) every available provider is offered', async () => {
    fetchWithAuth.mockResolvedValue(settings(null));
    render(<ProviderModelSelector provider="openai" model="openai/gpt-6-luna" />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/ai/settings'));
    fireEvent.click(await screen.findByText('OpenAI'));
    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
  });
});
