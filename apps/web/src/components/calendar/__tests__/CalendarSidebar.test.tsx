import { describe, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { assert } from './riteway';
import { CalendarSidebar } from '../CalendarSidebar';
import { DRIVE_CALENDAR_COLORS, PERSONAL_CALENDAR_COLOR } from '../calendar-types';

const makeCalendars = (overrides: Record<string, boolean> = {}) => [
  {
    key: 'personal',
    name: 'Personal',
    color: PERSONAL_CALENDAR_COLOR,
    visible: overrides['personal'] ?? true,
  },
  {
    key: 'drive-aaa',
    name: 'Work Drive',
    color: DRIVE_CALENDAR_COLORS[0],
    visible: overrides['drive-aaa'] ?? true,
  },
  {
    key: 'drive-bbb',
    name: 'Side Project',
    color: DRIVE_CALENDAR_COLORS[1],
    visible: overrides['drive-bbb'] ?? true,
  },
];

describe('CalendarSidebar', () => {
  test('renders calendar entries', () => {
    const calendars = makeCalendars();
    render(
      <CalendarSidebar
        calendars={calendars}
        onToggle={() => {}}
        onShowAll={() => {}}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
      />
    );

    assert({
      given: 'a list of calendars',
      should: 'render the My Calendars heading',
      actual: screen.getByText('My Calendars') !== null,
      expected: true,
    });

    assert({
      given: 'a personal calendar entry',
      should: 'render the Personal label',
      actual: screen.getByText('Personal') !== null,
      expected: true,
    });

    assert({
      given: 'drive calendar entries',
      should: 'render each drive name',
      actual: screen.getByText('Work Drive') !== null && screen.getByText('Side Project') !== null,
      expected: true,
    });
  });

  test('checkbox toggle callback', () => {
    const onToggle = vi.fn();
    render(
      <CalendarSidebar
        calendars={makeCalendars()}
        onToggle={onToggle}
        onShowAll={() => {}}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
      />
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // click "Work Drive" checkbox

    assert({
      given: 'a click on a calendar checkbox',
      should: 'call onToggle with the calendar key',
      actual: onToggle.mock.calls[0][0],
      expected: 'drive-aaa',
    });
  });

  test('hide all button when all visible', () => {
    const onHideAll = vi.fn();
    render(
      <CalendarSidebar
        calendars={makeCalendars()}
        onToggle={() => {}}
        onShowAll={() => {}}
        onHideAll={onHideAll}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Hide all'));

    assert({
      given: 'all calendars visible and clicking Hide all',
      should: 'call onHideAll',
      actual: onHideAll.mock.calls.length,
      expected: 1,
    });
  });

  test('show all button when some hidden', () => {
    const onShowAll = vi.fn();
    render(
      <CalendarSidebar
        calendars={makeCalendars({ 'drive-aaa': false })}
        onToggle={() => {}}
        onShowAll={onShowAll}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Show all'));

    assert({
      given: 'some calendars hidden and clicking Show all',
      should: 'call onShowAll',
      actual: onShowAll.mock.calls.length,
      expected: 1,
    });
  });

  test('hidden calendar has unchecked checkbox', () => {
    render(
      <CalendarSidebar
        calendars={makeCalendars({ 'drive-aaa': false })}
        onToggle={() => {}}
        onShowAll={() => {}}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
      />
    );

    const checkboxes = screen.getAllByRole('checkbox');
    assert({
      given: 'a hidden calendar',
      should: 'have aria-checked=false on its checkbox',
      actual: checkboxes[1].getAttribute('aria-checked'),
      expected: 'false',
    });
  });
});

describe('CalendarSidebar create target', () => {
  test('names the calendar new events go to, only when selection is offered', () => {
    const { rerender } = render(
      <CalendarSidebar
        calendars={makeCalendars()}
        onToggle={() => {}}
        onShowAll={() => {}}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
        selectedKey="drive-aaa"
        onSelectCalendar={() => {}}
      />
    );

    assert({
      given: 'a selected calendar with selection offered',
      should: 'label it as the New events target',
      actual: screen.getByText('New events').closest('[role="button"]')?.textContent?.includes('Work Drive'),
      expected: true,
    });

    rerender(
      <CalendarSidebar
        calendars={makeCalendars()}
        onToggle={() => {}}
        onShowAll={() => {}}
        onHideAll={() => {}}
        agentEventsVisible={true}
        userEventsVisible={true}
        onToggleAgentEvents={() => {}}
        onToggleUserEvents={() => {}}
        selectedKey="drive-aaa"
      />
    );

    assert({
      given: 'no selection handler',
      should: 'show no target label, since rows only toggle visibility',
      actual: screen.queryByText('New events'),
      expected: null,
    });
  });
});
