// @vitest-environment jsdom
/**
 * The v3 (Imago-enabled) device-flow screens: entry, invalid code, consent card,
 * connected and denied. Logic is covered by ActivateFlow.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const postMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

import { ActivateFlow } from '../ActivateFlow';

const VERIFY = {
  userCode: 'ABCDEFGH',
  clientName: 'PageSpace CLI',
  firstParty: true,
  scopeDescriptions: [
    'Name this key "jono-macbook"',
    'Act as you in Studio',
    'Stay connected until you revoke access',
  ],
  requiresStepUp: false,
  stepUpActionBinding: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ActivateFlow — v3 screens', () => {
  it('given the entry step, should show the Activate a device heading and the Continue action', () => {
    render(<ActivateFlow initialUserCode="" />);
    expect(screen.getByRole('heading', { name: 'Activate a device' })).toBeInTheDocument();
    expect(screen.getByLabelText('Device code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('given a bad code, should show the invalid-code alert', async () => {
    postMock.mockRejectedValue(new Error('invalid'));
    render(<ActivateFlow initialUserCode="WDJB-MJHT" />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is invalid or has expired.');
  });

  it('given a valid code, should show the consent card with the badge, three scope rows and Allow / Deny', async () => {
    postMock.mockResolvedValue(VERIFY);
    render(<ActivateFlow initialUserCode="ABCD-EFGH" />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: /PageSpace CLI is requesting access/ })).toBeInTheDocument();
    expect(screen.getByText('Built by PageSpace')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('given an approval, should show the Device connected heading and copy', async () => {
    postMock.mockResolvedValueOnce(VERIFY).mockResolvedValueOnce({ ok: true });
    render(<ActivateFlow initialUserCode="ABCD-EFGH" />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('heading', { name: 'Device connected' })).toBeInTheDocument();
    expect(screen.getByText('Device connected. You may return to your terminal.')).toBeInTheDocument();
  });

  it('given a denial, should show the Access denied heading and copy', async () => {
    postMock.mockResolvedValueOnce(VERIFY).mockResolvedValueOnce({ ok: true });
    render(<ActivateFlow initialUserCode="ABCD-EFGH" />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument());
    expect(screen.getByText('Access denied. You may close this window.')).toBeInTheDocument();
  });
});
