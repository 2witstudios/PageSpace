import { describe, test, beforeEach } from 'vitest';
import { assert } from './riteway';
import { useCalendarFilterStore } from '../useCalendarFilterStore';

// Reset store between tests to avoid shared mutable state
beforeEach(() => {
  useCalendarFilterStore.setState({
    hiddenCalendars: [],
  });
});

describe('useCalendarFilterStore', () => {
  test('default visibility', () => {
    const { hiddenCalendars } = useCalendarFilterStore.getState();
    assert({
      given: 'a fresh store with no saved state',
      should: 'have no hidden calendars (all visible)',
      actual: hiddenCalendars,
      expected: [],
    });
  });

  test('isVisible for unhidden calendar', () => {
    const { isVisible } = useCalendarFilterStore.getState();
    assert({
      given: 'a calendar key not in the hidden list',
      should: 'return true (visible)',
      actual: isVisible('drive-aaa'),
      expected: true,
    });
  });

  test('toggleCalendar hides a visible calendar', () => {
    useCalendarFilterStore.getState().toggleCalendar('drive-aaa');
    const { hiddenCalendars, isVisible } = useCalendarFilterStore.getState();
    assert({
      given: 'toggling a visible calendar',
      should: 'add it to the hidden list',
      actual: hiddenCalendars,
      expected: ['drive-aaa'],
    });
    assert({
      given: 'a hidden calendar',
      should: 'return false from isVisible',
      actual: isVisible('drive-aaa'),
      expected: false,
    });
  });

  test('toggleCalendar shows a hidden calendar', () => {
    useCalendarFilterStore.setState({ hiddenCalendars: ['drive-aaa'] });
    useCalendarFilterStore.getState().toggleCalendar('drive-aaa');
    const { hiddenCalendars, isVisible } = useCalendarFilterStore.getState();
    assert({
      given: 'toggling a hidden calendar',
      should: 'remove it from the hidden list',
      actual: hiddenCalendars,
      expected: [],
    });
    assert({
      given: 'a calendar that was toggled back to visible',
      should: 'return true from isVisible',
      actual: isVisible('drive-aaa'),
      expected: true,
    });
  });

  test('personal calendar key', () => {
    useCalendarFilterStore.getState().toggleCalendar('personal');
    const { isVisible } = useCalendarFilterStore.getState();
    assert({
      given: 'the personal calendar toggled off',
      should: 'return false for the personal key',
      actual: isVisible('personal'),
      expected: false,
    });
  });

  test('hideAll', () => {
    const keys = ['personal', 'drive-aaa', 'drive-bbb'];
    useCalendarFilterStore.getState().hideAll(keys);
    const { isVisible } = useCalendarFilterStore.getState();
    assert({
      given: 'hideAll called with all calendar keys',
      should: 'hide all calendars',
      actual: keys.every((k) => !isVisible(k)),
      expected: true,
    });
  });

  test('showAll', () => {
    useCalendarFilterStore.setState({
      hiddenCalendars: ['personal', 'drive-aaa', 'drive-bbb'],
    });
    useCalendarFilterStore.getState().showAll();
    const { hiddenCalendars } = useCalendarFilterStore.getState();
    assert({
      given: 'showAll called after hiding some calendars',
      should: 'clear the hidden list',
      actual: hiddenCalendars,
      expected: [],
    });
  });
});
