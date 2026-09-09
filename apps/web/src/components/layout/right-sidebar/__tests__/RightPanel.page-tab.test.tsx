/**
 * The page-context tab is DRIVEN FROM THE STORE, not from panel-local state.
 *
 * This is the other half of the nav trigger's reveal. `Layout` writes
 * `setRightSidebarPageTab('chat')` when it reveals a call — and a test on that
 * side alone would pass happily while this panel kept its own `useState` and
 * ignored the write entirely. The symptom would be a live call whose chrome the
 * user cannot reach because the sidebar opened on History.
 *
 * The three tab bodies are stubs: this file is about which one is shown.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from '@/stores/useLayoutStore';

vi.mock('@/hooks/useDashboardContext', () => ({
  useDashboardContext: () => ({ isDashboardContext: false }),
}));
vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ isOpen: false, height: 0 }),
}));
vi.mock('../ai-assistant/SidebarChatTab', () => ({
  default: () => <div data-testid="tab-body-chat" />,
}));
vi.mock('../ai-assistant/SidebarHistoryTab', () => ({
  default: () => <div data-testid="tab-body-history" />,
}));
vi.mock('../ai-assistant/SidebarActivityTab', () => ({
  default: () => <div data-testid="tab-body-activity" />,
}));

import RightPanel from '../index';

/**
 * Every tab body is force-mounted (the panel keeps chat state alive across tab
 * switches), so "which tab is shown" is Radix's `data-state` on the panel, not
 * presence in the DOM — and not `toBeVisible`, since the hiding is a Tailwind
 * class that jsdom does not compile.
 */
const panelState = (testId: string) =>
  screen.getByTestId(testId).closest('[role="tabpanel"]')?.getAttribute('data-state');

beforeEach(() => {
  useLayoutStore.setState({ rightSidebarPageTab: 'chat' });
});

describe('RightPanel — the page-context tab comes from the layout store', () => {
  it('should show whichever tab the store names', () => {
    useLayoutStore.setState({ rightSidebarPageTab: 'history' });
    render(<RightPanel />);

    expect(panelState('tab-body-history')).toBe('active');
    expect(panelState('tab-body-chat')).toBe('inactive');
  });

  it('should switch to chat when the store is driven there from OUTSIDE the panel', () => {
    // Exactly what `Layout.handleRevealAssistant` does when the voice trigger
    // reveals a call. Nothing inside this panel is touched.
    useLayoutStore.setState({ rightSidebarPageTab: 'history' });
    render(<RightPanel />);
    expect(panelState('tab-body-history')).toBe('active');

    act(() => {
      useLayoutStore.getState().setRightSidebarPageTab('chat');
    });

    expect(panelState('tab-body-chat')).toBe('active');
    expect(panelState('tab-body-history')).toBe('inactive');
  });

  it('should still write the user\'s own tab clicks back to the store', () => {
    render(<RightPanel />);

    const activityTab = screen.getByRole('tab', { name: /activity/i });
    // Radix Tabs switches on mousedown, not on the synthetic click alone.
    fireEvent.mouseDown(activityTab);
    fireEvent.click(activityTab);

    expect(useLayoutStore.getState().rightSidebarPageTab).toBe('activity');
    expect(panelState('tab-body-activity')).toBe('active');
  });

  it('should default to chat, as the local state it replaced did', () => {
    render(<RightPanel />);
    expect(panelState('tab-body-chat')).toBe('active');
  });
});
