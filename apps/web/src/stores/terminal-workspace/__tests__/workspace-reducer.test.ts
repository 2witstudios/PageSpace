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
  it('given a column id and a first pane id, should create a single column with a single active pane', () => {
    const actual = initialWorkspace('column-1', 'pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'column-1', panes: [{ id: 'pane-1', scope: null }] }],
      activePaneId: 'pane-1',
    };

    expect({
      given: 'a column id and a first pane id',
      should: 'create a single column with a single active pane',
      actual,
      expected,
    }).toEqual({
      given: 'a column id and a first pane id',
      should: 'create a single column with a single active pane',
      actual: expected,
      expected,
    });
  });
});

describe('openTerminal', () => {
  it('given two panes, should write the scope into only the active pane', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-2',
    };
    const scope = { name: 'my-terminal' };

    const actual = openTerminal(state, scope);
    const expected: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope },
          ],
        },
      ],
      activePaneId: 'pane-2',
    };

    expect({
      given: 'two panes',
      should: 'write the scope into only the active pane',
      actual,
      expected,
    }).toEqual({
      given: 'two panes',
      should: 'write the scope into only the active pane',
      actual: expected,
      expected,
    });
  });

  it('given openTerminal is called, should not mutate the input state', () => {
    const state: WorkspaceState = initialWorkspace('column-1', 'pane-1');
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
  it('given a single column, should append a new column with one empty pane and activate it', () => {
    const state = initialWorkspace('column-1', 'pane-1');

    const actual = splitRight(state, 'pane-1', 'column-2', 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        { id: 'column-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-2',
    };

    expect({
      given: 'a single column',
      should: 'append a new column with one empty pane and activate it',
      actual,
      expected,
    }).toEqual({
      given: 'a single column',
      should: 'append a new column with one empty pane and activate it',
      actual: expected,
      expected,
    });
  });

  it('given a pane with a scope, splitting right should leave the existing pane untouched', () => {
    const scope = { name: 'my-terminal' };
    const state: WorkspaceState = {
      columns: [{ id: 'column-1', panes: [{ id: 'pane-1', scope }] }],
      activePaneId: 'pane-1',
    };

    const result = splitRight(state, 'pane-1', 'column-2', 'pane-2');

    expect({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: result.columns[0].panes[0],
      expected: { id: 'pane-1', scope },
    }).toEqual({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: { id: 'pane-1', scope },
      expected: { id: 'pane-1', scope },
    });
  });

  it('given a pane in the first of several columns, should insert the new column immediately to its right', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'column-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
    };

    const actual = splitRight(state, 'pane-1', 'column-new', 'pane-new');

    expect({
      given: 'a pane in the first of several columns',
      should: 'insert the new column immediately to its right',
      actual: actual.columns.map((c) => c.id),
      expected: ['column-1', 'column-new', 'column-2'],
    }).toEqual({
      given: 'a pane in the first of several columns',
      should: 'insert the new column immediately to its right',
      actual: ['column-1', 'column-new', 'column-2'],
      expected: ['column-1', 'column-new', 'column-2'],
    });
  });
});

describe('splitDown', () => {
  it('given a single pane, should stack a new empty pane below it in the same column', () => {
    const state = initialWorkspace('column-1', 'pane-1');

    const actual = splitDown(state, 'pane-1', 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-2',
    };

    expect({
      given: 'a single pane',
      should: 'stack a new empty pane below it in the same column',
      actual,
      expected,
    }).toEqual({
      given: 'a single pane',
      should: 'stack a new empty pane below it in the same column',
      actual: expected,
      expected,
    });
  });

  it('given an unknown pane id, should be a no-op', () => {
    const state = initialWorkspace('column-1', 'pane-1');

    const actual = splitDown(state, 'does-not-exist', 'pane-2');

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

  it('given a column that already has two panes, should append the new pane after the source pane', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-1',
    };

    const actual = splitDown(state, 'pane-1', 'pane-new');

    expect({
      given: 'a column that already has two panes',
      should: 'append the new pane after the source pane',
      actual: actual.columns[0].panes.map((p) => p.id),
      expected: ['pane-1', 'pane-new', 'pane-2'],
    }).toEqual({
      given: 'a column that already has two panes',
      should: 'append the new pane after the source pane',
      actual: ['pane-1', 'pane-new', 'pane-2'],
      expected: ['pane-1', 'pane-new', 'pane-2'],
    });
  });
});

describe('closePane', () => {
  it('given the last remaining pane, should be a no-op', () => {
    const state = initialWorkspace('column-1', 'pane-1');

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

  it('given the active pane is closed, should re-target active to the workspace\'s first remaining pane', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-2',
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      columns: [
        { id: 'column-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-1',
    };

    expect({
      given: 'the active pane is closed',
      should: "re-target active to the workspace's first remaining pane",
      actual,
      expected,
    }).toEqual({
      given: 'the active pane is closed',
      should: "re-target active to the workspace's first remaining pane",
      actual: expected,
      expected,
    });
  });

  it('given a non-active pane is closed, should leave the active pane untouched', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
      ],
      activePaneId: 'pane-2',
    };

    const actual = closePane(state, 'pane-1');
    const expected: WorkspaceState = {
      columns: [{ id: 'column-1', panes: [{ id: 'pane-2', scope: null }] }],
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

  it('given closing the last pane in a column, should remove the column', () => {
    const state: WorkspaceState = {
      columns: [
        { id: 'column-1', panes: [{ id: 'pane-1', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
    };

    const actual = closePane(state, 'pane-1');

    expect({
      given: 'closing the last pane in a column',
      should: 'remove the column',
      actual: actual.columns.map((c) => c.id),
      expected: ['column-2'],
    }).toEqual({
      given: 'closing the last pane in a column',
      should: 'remove the column',
      actual: ['column-2'],
      expected: ['column-2'],
    });
  });

  it('given closing the last pane in the last column, should be a no-op', () => {
    const state = initialWorkspace('column-1', 'pane-1');

    const actual = closePane(state, 'pane-1');

    expect({
      given: 'closing the last pane in the last column',
      should: 'be a no-op',
      actual,
      expected: state,
    }).toEqual({
      given: 'closing the last pane in the last column',
      should: 'be a no-op',
      actual: state,
      expected: state,
    });
  });

  it('given closing one pane in a two-pane column, should leave the column with the other pane', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
      activePaneId: 'pane-3',
    };

    const actual = closePane(state, 'pane-1');

    expect({
      given: 'closing one pane in a two-pane column',
      should: 'leave the column with the other pane',
      actual: actual.columns,
      expected: [
        { id: 'column-1', panes: [{ id: 'pane-2', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
    }).toEqual({
      given: 'closing one pane in a two-pane column',
      should: 'leave the column with the other pane',
      actual: [
        { id: 'column-1', panes: [{ id: 'pane-2', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
      expected: [
        { id: 'column-1', panes: [{ id: 'pane-2', scope: null }] },
        { id: 'column-2', panes: [{ id: 'pane-3', scope: null }] },
      ],
    });
  });
});

describe('selectPane', () => {
  it('given a valid pane id, should activate it', () => {
    const state: WorkspaceState = {
      columns: [
        {
          id: 'column-1',
          panes: [
            { id: 'pane-1', scope: null },
            { id: 'pane-2', scope: null },
          ],
        },
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
    const state = initialWorkspace('column-1', 'pane-1');

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
