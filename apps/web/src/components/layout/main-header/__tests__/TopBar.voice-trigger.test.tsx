/**
 * WHERE the voice trigger lives, asserted against the real TopBar.
 *
 * "One trigger on every route" is a structural claim, and the structure that
 * makes it true is that the button is in the app-wide header rather than inside
 * the assistant sidebar it usually reveals. Move it into the sidebar and every
 * behavioural test of the trigger still passes, while voice quietly becomes a
 * feature of a panel — unreachable on the dashboard, unreachable while the
 * panel is collapsed, and unreachable as the way back to a minimized call.
 *
 * The trigger itself is a probe here: this file is about placement and about
 * the reveal callback being wired to the OPEN-only handler rather than to the
 * toggle.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { revealSpy, toggleSpy } = vi.hoisted(() => ({
  revealSpy: vi.fn(),
  toggleSpy: vi.fn(),
}));

vi.mock('@/components/ai/voice/realtime', () => ({
  VoiceNavTrigger: ({ onReveal }: { onReveal: (surface: string) => void }) => (
    <button type="button" data-testid="voice-nav-trigger" onClick={() => onReveal('sidebar')} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('@/components/notifications/NotificationBell', () => ({ default: () => <div /> }));
vi.mock('@/components/notifications/VerifyEmailButton', () => ({ default: () => <div /> }));
vi.mock('@/components/search/InlineSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/search/GlobalSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/shared/UserDropdown', () => ({ default: () => <div /> }));
vi.mock('@/components/shared/RecentsDropdown', () => ({ default: () => <div /> }));
vi.mock('@/components/billing/AiBalanceWidget', () => ({
  AiBalanceWidget: () => <div data-testid="ai-balance" />,
}));
vi.mock('../NavButtons', () => ({ default: () => <div /> }));

import TopBar from '../index';

const renderTopBar = () =>
  render(
    <TopBar
      onToggleLeftPanel={() => {}}
      onToggleRightPanel={toggleSpy}
      onRevealAssistant={revealSpy}
    />,
  );

describe('TopBar — the voice trigger is app-wide chrome', () => {
  it('should render the trigger in the header, beside the balance widget', () => {
    renderTopBar();
    expect(screen.getByTestId('voice-nav-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('ai-balance')).toBeInTheDocument();
  });

  it('should wire the trigger to REVEAL, never to the sidebar toggle', () => {
    // The distinction is the whole point: the same button is the live indicator
    // for a call in progress, and a toggle would hide the call it was pressed
    // to show.
    renderTopBar();
    fireEvent.click(screen.getByTestId('voice-nav-trigger'));

    expect(revealSpy).toHaveBeenCalledWith('sidebar');
    expect(toggleSpy).not.toHaveBeenCalled();
  });
});
