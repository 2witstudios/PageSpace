// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { createInitialState } from '@/ui/store/state';
import { getUiState, setUiState } from '@/ui/store/store';
import { OnboardingGate } from './OnboardingGate';

const deployment = vi.hoisted(() => ({ onPrem: false }));
vi.mock('@/retained/lib/deployment-mode', () => ({ isOnPrem: () => deployment.onPrem }));

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};

const onboardingRoutes = (needsOnboarding: boolean) => ({
  'GET /api/onboarding': () => Response.json({ needsOnboarding }),
  'POST /api/onboarding': () => Response.json({ ok: true, remembered: true }),
});

function show(routes: Parameters<typeof fakeWeb>[0]) {
  const web = fakeWeb(routes);
  mount(<ImagoSWRProvider client={web.client}><OnboardingGate /></ImagoSWRProvider>);
  return web;
}

beforeEach(() => {
  deployment.onPrem = false;
  setUiState(createInitialState());
});

afterEach(() => {
  unmountAll();
  cleanup();
});

describe('first-run gate', () => {
  it('shows the modal while the server says onboarding is incomplete', async () => {
    show(onboardingRoutes(true));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('renders nothing once onboarding is complete', async () => {
    show(onboardingRoutes(false));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing while loading and when the read fails', async () => {
    show({ 'GET /api/onboarding': () => new Response('nope', { status: 500 }) });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('finishing', () => {
  it('skipping records completion with an empty body and seeds nothing', async () => {
    const user = userEvent.setup();
    const web = show(onboardingRoutes(true));
    await user.click(await screen.findByRole('button', { name: /Skip/i }));

    await waitFor(() => expect(web.writes()).toHaveLength(1));
    expect(web.writes()[0]).toMatchObject({ method: 'POST', url: '/api/onboarding', body: {} });
    expect(getUiState().resources.chatDraft).toBe('');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asking records the scale and request, and seeds the chat-home composer with the request', async () => {
    const user = userEvent.setup();
    const web = show(onboardingRoutes(true));
    await user.click(await screen.findByRole('radio', { name: /Just me/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Show me' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText(/your first request/i), 'run my bakery');
    await user.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(web.writes()).toHaveLength(1));
    expect(web.writes()[0]).toMatchObject({
      method: 'POST',
      url: '/api/onboarding',
      body: { scaleLabel: 'Personal projects and life admin', firstRequest: 'run my bakery' },
    });
    expect(getUiState().resources.chatDraft).toBe('run my bakery');
  });
});
