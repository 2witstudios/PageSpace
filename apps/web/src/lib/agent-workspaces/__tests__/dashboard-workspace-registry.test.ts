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

  it('reads back the registered workspace id for the SAME user', () => {
    expect(getRegisteredDashboardWorkspaceId('u1')).toBeNull();
    registerDashboardWorkspace('u1', 'ws-dash');
    expect(getRegisteredDashboardWorkspaceId('u1')).toBe('ws-dash');
  });

  it('self-invalidates for a DIFFERENT user — a stale entry after an account switch cannot mint into the previous user\'s workspace', () => {
    registerDashboardWorkspace('u1', 'ws-dash');
    expect(getRegisteredDashboardWorkspaceId('u2')).toBeNull();
    expect(getRegisteredDashboardWorkspaceId('u1')).toBe('ws-dash');
  });

  it('keeps the LAST registration — a fresh dashboard workspace wins', () => {
    registerDashboardWorkspace('u1', 'ws-old');
    registerDashboardWorkspace('u1', 'ws-new');
    expect(getRegisteredDashboardWorkspaceId('u1')).toBe('ws-new');
  });
});
