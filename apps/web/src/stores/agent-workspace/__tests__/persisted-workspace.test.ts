/**
 * Rehydration is the one boundary in this store that reads untyped data —
 * everything past this module can trust a `WorkspaceState` is what it claims
 * to be. These tests exist to keep that true across storage corruption, not
 * just the happy path.
 */
import { describe, it, expect } from 'vitest';
import { newWorkspace } from '../pane-reducer';
import { validatePersistedWorkspaces } from '../persisted-workspace';

function validWorkspace(sessionId: string) {
  return newWorkspace({
    sessionId,
    paneId: 'pane-1',
    columnId: 'col-1',
    scope: { kind: 'chat', name: 'Planning', targetId: 'conv-1', agentPageId: 'agent-1' },
  });
}

describe('validatePersistedWorkspaces', () => {
  it('keeps a grid that matches the shape exactly', () => {
    const result = validatePersistedWorkspaces({ workspaces: { 'ses-1': validWorkspace('ses-1') } });
    expect(result['ses-1']).toEqual(validWorkspace('ses-1'));
  });

  it('keeps several valid grids side by side', () => {
    const result = validatePersistedWorkspaces({
      workspaces: { 'ses-1': validWorkspace('ses-1'), 'ses-2': validWorkspace('ses-2') },
    });
    expect(Object.keys(result).sort()).toEqual(['ses-1', 'ses-2']);
  });

  it('drops a grid whose pane scope has a kind paneScopeSchema does not recognize', () => {
    const corrupt = validWorkspace('ses-1');
    corrupt.columns[0].panes[0].scope = { kind: 'legacy-ssh', name: 'x', targetId: 'row-1', agentPageId: null } as never;
    const result = validatePersistedWorkspaces({ workspaces: { 'ses-1': corrupt } });
    expect(result['ses-1']).toBeUndefined();
  });

  it('keeps a valid neighbor when only one grid is corrupt', () => {
    const corrupt = validWorkspace('ses-bad');
    corrupt.activePaneId = '';
    const result = validatePersistedWorkspaces({
      workspaces: { 'ses-bad': corrupt, 'ses-good': validWorkspace('ses-good') },
    });
    expect(result['ses-bad']).toBeUndefined();
    expect(result['ses-good']).toBeDefined();
  });

  it('drops a grid with an empty column list', () => {
    const corrupt = { ...validWorkspace('ses-1'), columns: [] };
    const result = validatePersistedWorkspaces({ workspaces: { 'ses-1': corrupt } });
    expect(result['ses-1']).toBeUndefined();
  });

  it('given a scope of null (an unbound pane), keeps the grid', () => {
    const withPicker = validWorkspace('ses-1');
    withPicker.columns[0].panes[0].scope = null;
    const result = validatePersistedWorkspaces({ workspaces: { 'ses-1': withPicker } });
    expect(result['ses-1']).toEqual(withPicker);
  });

  it('given no workspaces key at all, returns an empty map rather than throwing', () => {
    expect(validatePersistedWorkspaces({})).toEqual({});
  });

  it('given garbage (not an object), returns an empty map', () => {
    expect(validatePersistedWorkspaces(null)).toEqual({});
    expect(validatePersistedWorkspaces('corrupted-string')).toEqual({});
    expect(validatePersistedWorkspaces(undefined)).toEqual({});
  });

  it('given a workspaces value that is not itself an object, returns an empty map', () => {
    expect(validatePersistedWorkspaces({ workspaces: 'nope' })).toEqual({});
  });
});
