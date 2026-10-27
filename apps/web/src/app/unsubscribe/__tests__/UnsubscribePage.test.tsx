// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const searchParamsState: { token: string | null; type: string | null } = {
  token: 'tok-1',
  type: 'NEW_DIRECT_MESSAGE',
};
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (searchParamsState as Record<string, string | null>)[key] ?? null,
  }),
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import UnsubscribePage from '../page';

const fetchMock = vi.fn();

beforeEach(() => {
  searchParamsState.token = 'tok-1';
  searchParamsState.type = 'NEW_DIRECT_MESSAGE';
  pushMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('UnsubscribePage', () => {
  it('given a valid link, should ask to confirm the email type with the two actions', () => {
    render(<UnsubscribePage />);
    expect(screen.getByRole('heading', { name: 'Unsubscribe?' })).toBeInTheDocument();
    expect(screen.getByText('Direct Messages', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, unsubscribe me' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Keep them, manage preferences' })).toHaveAttribute(
      'href',
      '/settings/notifications',
    );
  });

  it('given a rejected token (4xx), should show the role=alert message and disable the button', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status: 400 }));
    render(<UnsubscribePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, unsubscribe me' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That unsubscribe link is no longer valid.');
    expect(screen.getByRole('button', { name: 'Yes, unsubscribe me' })).toBeDisabled();
  });

  it('given a missing token, should start in the invalid state with the button disabled', () => {
    searchParamsState.token = null;
    render(<UnsubscribePage />);
    expect(screen.getByRole('alert')).toHaveTextContent('That unsubscribe link is no longer valid.');
    expect(screen.getByRole('button', { name: 'Yes, unsubscribe me' })).toBeDisabled();
  });

  it('given a server failure (5xx), should show a retryable error rather than the invalid-link message', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<UnsubscribePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, unsubscribe me' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    expect(screen.getByRole('button', { name: 'Yes, unsubscribe me' })).toBeEnabled();
  });

  it('given a confirmed opt-out, should POST the token and go to the success page for the type', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    render(<UnsubscribePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, unsubscribe me' }));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/unsubscribe-success?type=NEW_DIRECT_MESSAGE'),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/unsubscribe/tok-1', { method: 'POST' });
  });

  it('given Imago is on, should render the v3 copy and point preferences at /imago/account/notifications', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<UnsubscribePage />);
    expect(screen.getByRole('link', { name: 'Keep them, manage preferences' })).toHaveAttribute(
      'href',
      '/imago/account/notifications',
    );
    expect(screen.getByRole('button', { name: 'Yes, unsubscribe me' })).toHaveClass('bg-[oklch(0.50_0.16_235)]');
  });
});
