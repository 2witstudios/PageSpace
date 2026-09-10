import { describe, it, expect } from 'vitest';

import {
  ALL_DRIVES,
  driveFocus,
  focusDestinationHref,
  focusSectionHref,
  isSameFocus,
  sectionForPathname,
} from '../focus';

describe('sectionForPathname', () => {
  it('given a drive-scoped section route, should name the section, sub-paths included', () => {
    expect(sectionForPathname('/dashboard/drive_eng/files')).toBe('files');
    expect(sectionForPathname('/dashboard/drive_eng/files/page_9')).toBe('files');
    expect(sectionForPathname('/dashboard/drive_eng/calendar')).toBe('calendar');
    expect(sectionForPathname('/dashboard/drive_eng/channels')).toBe('channels');
  });

  it('given an all-drives section route, should name the section, with drives standing in for files', () => {
    expect(sectionForPathname('/dashboard/drives')).toBe('files');
    expect(sectionForPathname('/dashboard/tasks')).toBe('tasks');
    expect(sectionForPathname('/dashboard/channels/page_3')).toBe('channels');
    expect(sectionForPathname('/dashboard/calendar')).toBe('calendar');
  });

  it('given agents, activity or trash in either shape, should name them too', () => {
    expect(sectionForPathname('/dashboard/agents')).toBe('agents');
    expect(sectionForPathname('/dashboard/drive_eng/agents')).toBe('agents');
    expect(sectionForPathname('/dashboard/activity')).toBe('activity');
    expect(sectionForPathname('/dashboard/drive_eng/trash')).toBe('trash');
    expect(focusSectionHref(ALL_DRIVES, 'agents')).toBe('/dashboard/agents');
    expect(focusDestinationHref('/dashboard/drive_eng/agents', ALL_DRIVES)).toBe('/dashboard/agents');
    expect(focusDestinationHref('/dashboard/agents', driveFocus('drive_eng'))).toBe('/dashboard/drive_eng/agents');
  });

  it('given a route outside the sections, should find nothing', () => {
    expect(sectionForPathname('/dashboard')).toBeNull();
    expect(sectionForPathname('/dashboard/drive_eng')).toBeNull();
    expect(sectionForPathname('/dashboard/drive_eng/page_9')).toBeNull();
    expect(sectionForPathname('/dashboard/dms')).toBeNull();
    expect(sectionForPathname('/dashboard/files')).toBeNull();
    expect(sectionForPathname('/dashboard/agentsx')).toBeNull();
    expect(sectionForPathname('/dashboard/drive_eng/agents-archive')).toBeNull();
    expect(sectionForPathname(null)).toBeNull();
    expect(sectionForPathname(undefined)).toBeNull();
  });
});

describe('focusSectionHref', () => {
  it('given All drives, should map each section to the route the sidebar uses', () => {
    expect(focusSectionHref(ALL_DRIVES, 'channels')).toBe('/dashboard/channels');
    expect(focusSectionHref(ALL_DRIVES, 'files')).toBe('/dashboard/drives');
    expect(focusSectionHref(ALL_DRIVES, 'tasks')).toBe('/dashboard/tasks');
    expect(focusSectionHref(ALL_DRIVES, 'calendar')).toBe('/dashboard/calendar');
  });

  it('given a drive, should nest the section under that drive', () => {
    expect(focusSectionHref(driveFocus('drive_eng'), 'calendar')).toBe('/dashboard/drive_eng/calendar');
    expect(focusSectionHref(driveFocus('drive_eng'), 'files')).toBe('/dashboard/drive_eng/files');
  });

  it('given no section, should go to the home of the focus', () => {
    expect(focusSectionHref(ALL_DRIVES, null)).toBe('/dashboard');
    expect(focusSectionHref(driveFocus('drive_eng'), null)).toBe('/dashboard/drive_eng');
  });
});

describe('focusDestinationHref', () => {
  it('given a files view, should send a picked drive to its files', () => {
    expect(focusDestinationHref('/dashboard/drives', driveFocus('drive_eng'))).toBe('/dashboard/drive_eng/files');
    expect(focusDestinationHref('/dashboard/drive_x/files/page_1', driveFocus('drive_eng'))).toBe(
      '/dashboard/drive_eng/files'
    );
  });

  it('given a drive section, should send All drives to the same section', () => {
    expect(focusDestinationHref('/dashboard/drive_x/tasks', ALL_DRIVES)).toBe('/dashboard/tasks');
    expect(focusDestinationHref('/dashboard/drive_x/files/page_1', ALL_DRIVES)).toBe('/dashboard/drives');
  });

  it('given no section, should fall back to the home of the focus', () => {
    expect(focusDestinationHref('/dashboard', driveFocus('drive_eng'))).toBe('/dashboard/drive_eng');
    expect(focusDestinationHref('/dashboard/drive_x/page_1', driveFocus('drive_eng'))).toBe('/dashboard/drive_eng');
    expect(focusDestinationHref('/dashboard/drive_x/page_1', ALL_DRIVES)).toBe('/dashboard');
  });
});

describe('isSameFocus', () => {
  it('given two focuses, should compare kind and drive', () => {
    expect(isSameFocus(ALL_DRIVES, { kind: 'all' })).toBe(true);
    expect(isSameFocus(driveFocus('a'), driveFocus('a'))).toBe(true);
    expect(isSameFocus(driveFocus('a'), driveFocus('b'))).toBe(false);
    expect(isSameFocus(driveFocus('a'), ALL_DRIVES)).toBe(false);
  });
});
