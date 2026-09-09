/**
 * WHAT the header offers as the way back to the dashboard, asserted against
 * the real TopBar.
 *
 * The control this replaced named its destination only in an aria-label, so
 * the header could pass every accessibility assertion while showing sighted
 * users nothing but a house and a slash. Asserting the visible text here is
 * therefore the point of the file, not an incidental detail: put the house
 * back and the route out still works, still has an accessible name, and still
 * leaves the reported bug exactly where it was.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ai/voice/realtime', () => ({
  VoiceNavTrigger: () => <div />,
}));
// Matches TopBar.voice-trigger.test.tsx: the header is rendered outside an
// app-router context here, and this file is about what the header SAYS, not
// about Link's own behaviour.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/notifications/NotificationBell', () => ({ default: () => <div /> }));
vi.mock('@/components/notifications/VerifyEmailButton', () => ({ default: () => <div /> }));
vi.mock('@/components/search/InlineSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/search/GlobalSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/shared/UserDropdown', () => ({ default: () => <div /> }));
vi.mock('@/components/shared/RecentsDropdown', () => ({ default: () => <div /> }));
vi.mock('@/components/billing/AiBalanceWidget', () => ({ AiBalanceWidget: () => <div /> }));
vi.mock('../NavButtons', () => ({ default: () => <div /> }));

import TopBar from '../index';

const renderTopBar = () =>
  render(
    <TopBar onToggleLeftPanel={() => {}} onToggleRightPanel={() => {}} onRevealAssistant={() => {}} />,
  );

describe('TopBar — the way back to the dashboard', () => {
  it('given the header renders, should say the word "Dashboard" on screen', () => {
    renderTopBar();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('given a labelled control in the left group, should let that group wrap rather than overflow its neighbours', () => {
    // The group is flex-1 and shrinkable, so it never forces the OUTER wrap —
    // it narrows below its own content instead, and a child that refuses to
    // shrink then overflows into the right-hand controls. Harmless while the
    // only thing here was a 30px icon link; reachable at phone widths once the
    // control carries a word. Walks up by flex-1 rather than by DOM position so
    // this survives reordering.
    renderTopBar();

    let group: HTMLElement | null = screen.getByText('Dashboard');
    while (group && !/\bflex-1\b/.test(group.className)) {
      group = group.parentElement;
    }

    expect(group, 'expected a flex-1 ancestor group').not.toBeNull();
    expect(group?.className).toMatch(/\bflex-wrap\b/);
  });

  it('given the header renders, should not fall back to a lone slash as the route home', () => {
    // The old control's entire visible content, and the reason nobody found it.
    renderTopBar();

    expect(screen.queryByText('/')).not.toBeInTheDocument();
  });
});
