import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: false }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchWithAuth }));
vi.mock('@/components/billing/CreditBalance', () => ({ CreditBalance: () => <div data-testid="personal-credit-chip" /> }));

import { AiBalanceWidget } from '@/components/billing/AiBalanceWidget';
import { ComposerSpendStrip } from '../ComposerSpendStrip';
import { conversationSpendKey } from '@/hooks/useConversationSpend';
import { driveWalletKey } from '@/hooks/useDriveWallet';
import { useSpendContextStore } from '@/stores/useSpendContextStore';

describe('spend surfaces while organizations are dark', () => {
  it('UI-8 (partial) nothing org-facing renders or fetches: the personal chip stays, no strip, no conversation registered', () => {
    render(
      <>
        <AiBalanceWidget />
        <ComposerSpendStrip conversationId="c1" driveId="d1" isGlobal={false} hasMessages={false} />
      </>,
    );
    expect(screen.getByTestId('personal-credit-chip')).toBeTruthy();
    expect(screen.queryByTestId('composer-spend-strip')).toBeNull();
    expect(useSpendContextStore.getState().active).toBeNull();
    expect(conversationSpendKey('c1', 'd1', true)).toBeNull();
    expect(driveWalletKey('d1')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
