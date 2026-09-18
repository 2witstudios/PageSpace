import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerDashboardWorkspace,
  getRegisteredDashboardWorkspaceId,
  resetDashboardWorkspaceRegistry,
} from '../dashboard-workspace-registry';

describe('dashboard-workspace-registry', () => {
  beforeEach(() => {
    resetDashboardWorkspaceRegistry();
  });

  it('reads back the registered workspace id', () => {
    expect(getRegisteredDashboardWorkspaceId()).toBeNull();
    registerDashboardWorkspace('ws-dash');
    expect(getRegisteredDashboardWorkspaceId()).toBe('ws-dash');
  });

  it('keeps the LAST registration — a fresh dashboard workspace wins', () => {
    registerDashboardWorkspace('ws-old');
    registerDashboardWorkspace('ws-new');
    expect(getRegisteredDashboardWorkspaceId()).toBe('ws-new');
  });
});
