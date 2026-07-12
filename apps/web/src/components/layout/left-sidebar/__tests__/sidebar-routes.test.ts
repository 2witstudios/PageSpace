import { describe, test, expect } from 'vitest';
import { resolveSidebarVariant } from '../sidebar-routes';

describe('resolveSidebarVariant', () => {
  test('routes the drive-scoped Development tree to the Development sidebar', () => {
    expect(resolveSidebarVariant('/dashboard/drive-1/development')).toBe('development');
  });

  test('keeps the Development sidebar when a machine is selected', () => {
    // The whole point of the sidebar living above the routed page: picking a
    // machine swaps the detail pane, not the sidebar.
    expect(resolveSidebarVariant('/dashboard/drive-1/development/machine-1')).toBe('development');
  });

  test('the driveless Development entry resolves from the same matcher', () => {
    expect(resolveSidebarVariant('/dashboard/development')).toBe('development');
  });

  test("does not swallow a drive's ordinary page route", () => {
    expect(resolveSidebarVariant('/dashboard/drive-1/page-1')).toBe('default');
  });

  test('does not match a path that merely starts with the segment', () => {
    expect(resolveSidebarVariant('/dashboard/drive-1/development-notes')).toBe('default');
    expect(resolveSidebarVariant('/dashboard/developments')).toBe('default');
  });

  test('leaves the existing swaps alone', () => {
    expect(resolveSidebarVariant('/dashboard/dms')).toBe('dms');
    expect(resolveSidebarVariant('/dashboard/dms/thread-1')).toBe('dms');
    expect(resolveSidebarVariant('/dashboard/channels')).toBe('channels');
    expect(resolveSidebarVariant('/dashboard/drive-1/channels')).toBe('channels');
    expect(resolveSidebarVariant('/dashboard')).toBe('default');
  });
});
