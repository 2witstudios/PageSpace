import { describe, it, expect } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { isValidAgentTerminalName, AGENT_LAUNCH_SPECS } from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  initialWorkspace,
  openTerminal,
  splitRight,
  splitDown,
  closePane,
  selectPane,
  assignPane,
  clearPanePrompt,
  dismissPicker,
  autoSessionName,
  workspaceKey,
  nodeOfTerminalScope,
  isSameNodeScope,
  type WorkspaceState,
} from '../workspace-reducer';

describe('initialWorkspace', () => {
  it('given a first pane id, should create a single column with a single active pane and no scope', () => {
    const actual = initialWorkspace('pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'a first pane id',
      should: 'create a single column with a single active pane and no scope',
      actual,
      expected,
    }).toEqual({
      given: 'a first pane id',
      should: 'create a single column with a single active pane and no scope',
      actual: expected,
      expected,
    });
  });
});

describe('openTerminal', () => {
  it('given two panes across columns, should write the scope into only the active pane', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    };
    const scope = { name: 'my-terminal' };

    const actual = openTerminal(state, scope);
    const expected: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'two panes across columns',
      should: 'write the scope into only the active pane',
      actual,
      expected,
    }).toEqual({
      given: 'two panes across columns',
      should: 'write the scope into only the active pane',
      actual: expected,
      expected,
    });
  });

  it('given openTerminal is called, should not mutate the input state', () => {
    const state: WorkspaceState = initialWorkspace('pane-1');
    const snapshot = JSON.parse(JSON.stringify(state));

    openTerminal(state, { name: 'my-terminal' });

    expect({
      given: 'openTerminal is called',
      should: 'not mutate the input state',
      actual: state,
      expected: snapshot,
    }).toEqual({
      given: 'openTerminal is called',
      should: 'not mutate the input state',
      actual: snapshot,
      expected: snapshot,
    });
  });
});

describe('splitRight', () => {
  it('given a single column, should insert a new column after it and activate its pane', () => {
    const state = initialWorkspace('pane-1');

    const actual = splitRight(state, 'pane-1', 'col-2', 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        { id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-2',
      // The new pane is empty, so its inline agent picker opens focused.
      pendingPickerPaneId: 'pane-2',
    };

    expect({
      given: 'a single column',
      should: 'insert a new column after it and activate its pane',
      actual,
      expected,
    }).toEqual({
      given: 'a single column',
      should: 'insert a new column after it and activate its pane',
      actual: expected,
      expected,
    });
  });

  it('given a pane with a scope, splitting right should leave the existing pane untouched', () => {
    const scope = { name: 'my-terminal' };
    const state: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const result = splitRight(state, 'pane-1', 'col-2', 'pane-2');

    expect({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: result.columns[0],
      expected: { id: 'col-1', panes: [{ id: 'pane-1', scope }] },
    }).toEqual({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: { id: 'col-1', panes: [{ id: 'pane-1', scope }] },
      expected: { id: 'col-1', panes: [{ id: 'pane-1', scope }] },
    });
  });

  it('given a pane whose id does not exist, should be a no-op', () => {
    const state = initialWorkspace('pane-1');

    const actual = splitRight(state, 'does-not-exist', 'col-2', 'pane-2');

    expect({
      given: 'a pane whose id does not exist',
      should: 'be a no-op',
      actual,
      expected: state,
    }).toEqual({
      given: 'a pane whose id does not exist',
      should: 'be a no-op',
      actual: state,
      expected: state,
    });
  });

  it('given splitting the middle column of three, should insert immediately after it', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
        { id: 'col-3', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = splitRight(state, 'pane-2', 'col-new', 'pane-new');

    expect({
      given: 'splitting the middle column of three',
      should: 'insert immediately after it',
      actual: actual.columns.map((c) => c.id),
      expected: ['col-1', 'col-2', 'col-new', 'col-3'],
    }).toEqual({
      given: 'splitting the middle column of three',
      should: 'insert immediately after it',
      actual: ['col-1', 'col-2', 'col-new', 'col-3'],
      expected: ['col-1', 'col-2', 'col-new', 'col-3'],
    });
  });
});

describe('splitDown', () => {
  it('given a single-pane column, should stack a new pane within that same column', () => {
    const state = initialWorkspace('pane-1');

    const actual = splitDown(state, 'pane-1', 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        {
          id: 'pane-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: 'pane-2',
    };

    expect({
      given: 'a single-pane column',
      should: 'stack a new pane within that same column',
      actual,
      expected,
    }).toEqual({
      given: 'a single-pane column',
      should: 'stack a new pane within that same column',
      actual: expected,
      expected,
    });
  });

  it('given a pane whose id does not exist, should be a no-op', () => {
    const state = initialWorkspace('pane-1');

    const actual = splitDown(state, 'does-not-exist', 'pane-2');

    expect({
      given: 'a pane whose id does not exist',
      should: 'be a no-op',
      actual,
      expected: state,
    }).toEqual({
      given: 'a pane whose id does not exist',
      should: 'be a no-op',
      actual: state,
      expected: state,
    });
  });

  it('given splitting down in one column of two, should leave the other column untouched', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = splitDown(state, 'pane-1', 'pane-1b');

    expect({
      given: 'splitting down in one column of two',
      should: 'leave the other column untouched',
      actual: actual.columns[1],
      expected: { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
    }).toEqual({
      given: 'splitting down in one column of two',
      should: 'leave the other column untouched',
      actual: { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      expected: { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
    });
  });
});

describe('closePane', () => {
  it('given the last remaining pane, should be a no-op', () => {
    const state = initialWorkspace('pane-1');

    const actual = closePane(state, 'pane-1');

    expect({
      given: 'the last remaining pane',
      should: 'be a no-op',
      actual,
      expected: state,
    }).toEqual({
      given: 'the last remaining pane',
      should: 'be a no-op',
      actual: state,
      expected: state,
    });
  });

  it('given closing the last pane in a column, should remove the column', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'closing the last pane in a column',
      should: 'remove the column',
      actual,
      expected,
    }).toEqual({
      given: 'closing the last pane in a column',
      should: 'remove the column',
      actual: expected,
      expected,
    });
  });

  it('given closing one of two stacked panes in a column, should keep the column with the remaining pane', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'col-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'closing one of two stacked panes in a column',
      should: 'keep the column with the remaining pane',
      actual,
      expected,
    }).toEqual({
      given: 'closing one of two stacked panes in a column',
      should: 'keep the column with the remaining pane',
      actual: expected,
      expected,
    });
  });

  it('given the active pane is closed, should re-target active to the first remaining pane', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
        { id: 'col-3', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-3', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'the active pane is closed',
      should: 're-target active to the first remaining pane',
      actual,
      expected,
    }).toEqual({
      given: 'the active pane is closed',
      should: 're-target active to the first remaining pane',
      actual: expected,
      expected,
    });
  });

  it('given a non-active pane is closed, should leave the active pane untouched', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    };

    const actual = closePane(state, 'pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-2', panes: [{ id: 'pane-2', scope: null }] }],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    };

    expect({
      given: 'a non-active pane is closed',
      should: 'leave the active pane untouched',
      actual,
      expected,
    }).toEqual({
      given: 'a non-active pane is closed',
      should: 'leave the active pane untouched',
      actual: expected,
      expected,
    });
  });

  it('given closing the only pane in the only column, should no-op like today', () => {
    const state: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'my-terminal' } }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = closePane(state, 'pane-1');

    expect({
      given: 'closing the only pane in the only column',
      should: 'no-op like today',
      actual,
      expected: state,
    }).toEqual({
      given: 'closing the only pane in the only column',
      should: 'no-op like today',
      actual: state,
      expected: state,
    });
  });
});

describe('selectPane', () => {
  it('given a valid pane id, should activate it', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    const actual = selectPane(state, 'pane-2');

    expect({
      given: 'a valid pane id',
      should: 'activate it',
      actual: actual.activePaneId,
      expected: 'pane-2',
    }).toEqual({
      given: 'a valid pane id',
      should: 'activate it',
      actual: 'pane-2',
      expected: 'pane-2',
    });
  });

  it('given an unknown pane id, should be a no-op', () => {
    const state = initialWorkspace('pane-1');

    const actual = selectPane(state, 'does-not-exist');

    expect({
      given: 'an unknown pane id',
      should: 'be a no-op',
      actual,
      expected: state,
    }).toEqual({
      given: 'an unknown pane id',
      should: 'be a no-op',
      actual: state,
      expected: state,
    });
  });
});

describe('node-as-workspace keying', () => {
  it('given nodes that differ only in scope, should key their grids apart', () => {
    const machineNode = workspaceKey('m1', {});
    const projectNode = workspaceKey('m1', { projectName: 'app' });
    const branchNode = workspaceKey('m1', { projectName: 'app', branchName: 'main' });
    const otherMachine = workspaceKey('m2', { projectName: 'app', branchName: 'main' });

    assert({
      given: 'the machine, one of its projects, one of its branches, and the same branch on another machine',
      should: 'give each node its own workspace key — a branch grid is not the machine grid',
      actual: new Set([machineNode, projectNode, branchNode, otherMachine]).size,
      expected: 4,
    });
  });

  it('given a session scope, should resolve the node it lives under', () => {
    assert({
      given: 'a session scope',
      should: 'resolve to its node — a scope IS a node plus a name',
      actual: nodeOfTerminalScope({ projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' }),
      expected: { projectName: 'app', branchName: 'main' },
    });
  });

  it('given an absent scope field and an empty one, should treat them as the same node', () => {
    assert({
      given: 'a machine node written as {} and as { projectName: undefined }',
      should: 'compare equal — the two spellings address one node, and must not own two grids',
      actual: isSameNodeScope({}, { projectName: undefined, branchName: undefined }),
      expected: true,
    });
  });
});

describe('assignPane (split-and-pick landing)', () => {
  it('given a spawn that resolves while ANOTHER pane is active, should bind it to the pane it was picked in', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: 'pane-1',
    };
    const scope = { projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' };

    const actual = assignPane(state, 'pane-1', scope, 'fix the build');

    assert({
      given: 'a spawn picked in pane-1 that resolves while pane-2 is active (a cold Sprite boot the user clicked away from)',
      should: 'bind the agent to pane-1 — the pane it was picked in — focus it, and stop its picker pending',
      actual: {
        pane1: actual.columns[0].panes[0],
        pane2: actual.columns[1].panes[0],
        activePaneId: actual.activePaneId,
        pendingPickerPaneId: actual.pendingPickerPaneId,
      },
      expected: {
        pane1: { id: 'pane-1', scope, pendingPrompt: 'fix the build' },
        pane2: { id: 'pane-2', scope: null },
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      },
    });
  });

  it('given a pane closed before its spawn resolved, should be a no-op', () => {
    const state = initialWorkspace('pane-1');

    assert({
      given: 'a pane that was closed while its agent was still booting',
      should: 'be a no-op rather than resurrect it',
      actual: assignPane(state, 'closed-pane', { name: 'claude-a1b2c3' }),
      expected: state,
    });
  });
});

describe('clearPanePrompt', () => {
  it('given a prompt that has been typed into the PTY, should drop it', () => {
    const scope = { name: 'claude-a1b2c3' };
    const state = assignPane(initialWorkspace('pane-1'), 'pane-1', scope, 'fix the build');

    assert({
      given: 'a starting prompt already delivered to the agent',
      should: 'drop it — a pane that re-mounts must reattach, not retype the prompt at a running agent',
      actual: clearPanePrompt(state, 'pane-1').columns[0].panes[0],
      expected: { id: 'pane-1', scope, pendingPrompt: undefined },
    });
  });
});

describe('dismissPicker', () => {
  it('given the pending picker pane, should clear the focus intent but keep the pane empty', () => {
    const state = splitDown(initialWorkspace('pane-1'), 'pane-1', 'pane-2');

    const actual = dismissPicker(state, 'pane-2');

    assert({
      given: 'the auto-focused picker of a freshly split pane, once it has taken focus',
      should: 'clear the focus intent while leaving the pane empty and still offering its picker',
      actual: {
        pendingPickerPaneId: actual.pendingPickerPaneId,
        stillEmpty: actual.columns[0].panes[1].scope,
      },
      expected: { pendingPickerPaneId: null, stillEmpty: null },
    });
  });

  it('given a pane that is not the pending picker, should be a no-op', () => {
    const state = splitDown(initialWorkspace('pane-1'), 'pane-1', 'pane-2');

    assert({
      given: 'a pane other than the pending picker',
      should: 'be a no-op — one pane taking focus must not cancel another pane\'s pending picker',
      actual: dismissPicker(state, 'pane-1'),
      expected: state,
    });
  });
});

describe('closePane (picker)', () => {
  it('given the pending picker pane is closed, should clear the focus intent', () => {
    const state = splitRight(initialWorkspace('pane-1'), 'pane-1', 'col-2', 'pane-2');

    assert({
      given: 'a freshly split pane closed before anything was picked in it',
      should: 'clear the pending picker — it points at a pane that no longer exists',
      actual: closePane(state, 'pane-2').pendingPickerPaneId,
      expected: null,
    });
  });
});

describe('autoSessionName', () => {
  it('given every agent type and a uuid-shaped suffix, should produce a valid, unique-per-spawn session name', () => {
    const names = Object.keys(AGENT_LAUNCH_SPECS).map((type) => autoSessionName(type, '3f2a91b7c4d5'));

    assert({
      given: 'each agent type auto-named with a fresh suffix (picking an agent is ONE act — the user is never asked for a name)',
      should: 'always satisfy isValidAgentTerminalName, the contract the spawn API enforces',
      actual: names.every(isValidAgentTerminalName),
      expected: true,
    });
  });

  it('given two spawns of the same type at the same node, should not collide', () => {
    assert({
      given: 'two claude agents spawned into two panes of one branch (name_in_use is a 409)',
      should: 'differ — the suffix, not the type, carries the identity',
      actual: autoSessionName('claude', 'aaaaaa') === autoSessionName('claude', 'bbbbbb'),
      expected: false,
    });
  });

  it('given a suffix of only separator characters, should still produce a valid name', () => {
    assert({
      given: 'a degenerate suffix with nothing name-safe in it',
      should: 'fall back to the bare agent type rather than emit a trailing dash the API would reject',
      actual: autoSessionName('claude', '----'),
      expected: 'claude',
    });
  });
});
