import { describe, it, expect } from 'vitest';
import {
  initialWorkspace,
  openTerminal,
  splitRight,
  splitDown,
  closePane,
  selectPane,
  type WorkspaceState,
} from '../workspace-reducer';

describe('initialWorkspace', () => {
  it('given a first pane id, should create a single column with a single active pane and no scope', () => {
    const actual = initialWorkspace('pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
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
    };
    const scope = { name: 'my-terminal' };

    const actual = openTerminal(state, scope);
    const expected: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope }] },
      ],
      activePaneId: 'pane-2',
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
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
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
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
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
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'col-3', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-1',
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
    };

    const actual = closePane(state, 'pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'col-2', panes: [{ id: 'pane-2', scope: null }] }],
      activePaneId: 'pane-2',
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
