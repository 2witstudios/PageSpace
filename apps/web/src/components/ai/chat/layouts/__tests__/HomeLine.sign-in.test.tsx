import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComposedLine } from '@pagespace/lib/home-signals/composer';
import { HomeLine } from '../HomeLine';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';

const LINE: ComposedLine = {
  greeting: 'Good morning.',
  lead: '2 tasks due today',
  rest: [],
  icon: null,
  suggestions: [],
  leadHref: null,
};

beforeEach(() => {
  act(() => useOrgReauthStore.getState().dismiss());
});

describe('the Home line when an org withholds the Pulse summary (D-OW-62)', () => {
  it('SEC-2 (partial) shows the withheld notice beside the line, and its action opens the re-authentication prompt', async () => {
    render(<HomeLine line={LINE} signInRequired={{ code: 'org_strong_sign_in_required', orgIds: ['org_a'] }} />);
    expect(screen.getByText('2 tasks due today')).toBeTruthy();
    expect(screen.getByText(/Your Pulse summary is hidden because an organization it draws from requires strong sign-in/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use your passkey' }));
    expect(useOrgReauthStore.getState().denials).toEqual([{ code: 'org_strong_sign_in_required', orgId: 'org_a' }]);
  });

  it('renders the line alone when nothing is withheld', () => {
    render(<HomeLine line={LINE} signInRequired={null} />);
    expect(screen.getByText('2 tasks due today')).toBeTruthy();
    expect(screen.queryByText(/is hidden because/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
