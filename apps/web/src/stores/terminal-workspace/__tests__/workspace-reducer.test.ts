import { describe, it, expect } from 'vitest';
import {
  initialWorkspace,
  openTerminal,
  split,
  closePane,
  selectPane,
  type WorkspaceState,
} from '../workspace-reducer';

describe('initialWorkspace', () => {
  it('given a first pane id, should create a single active pane with no scope', () => {
    const actual = initialWorkspace('pane-1');
    const expected: WorkspaceState = {
      panes: [{ id: 'pane-1', scope: null }],
      activePaneId: 'pane-1',
    };

    expect({
      given: 'a first pane id',
      should: 'create a single active pane with no scope',
      actual,
      expected,
    }).toEqual({
      given: 'a first pane id',
      should: 'create a single active pane with no scope',
      actual: expected,
      expected,
    });
  });
});

describe('openTerminal', () => {
  it('given two panes, should write the scope into only the active pane', () => {
    const state: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope: null },
      ],
      activePaneId: 'pane-2',
    };
    const scope = { name: 'my-terminal' };

    const actual = openTerminal(state, scope);
    const expected: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope },
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

describe('split', () => {
  it('given a single pane, should append a new empty pane and activate it', () => {
    const state = initialWorkspace('pane-1');

    const actual = split(state, 'pane-2');
    const expected: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope: null },
      ],
      activePaneId: 'pane-2',
    };

    expect({
      given: 'a single pane',
      should: 'append a new empty pane and activate it',
      actual,
      expected,
    }).toEqual({
      given: 'a single pane',
      should: 'append a new empty pane and activate it',
      actual: expected,
      expected,
    });
  });

  it('given a pane with a scope, splitting should leave the existing pane untouched', () => {
    const scope = { name: 'my-terminal' };
    const state: WorkspaceState = {
      panes: [{ id: 'pane-1', scope }],
      activePaneId: 'pane-1',
    };

    const result = split(state, 'pane-2');

    expect({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: result.panes[0],
      expected: { id: 'pane-1', scope },
    }).toEqual({
      given: 'a pane with a scope',
      should: 'leave the existing pane untouched',
      actual: { id: 'pane-1', scope },
      expected: { id: 'pane-1', scope },
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

  it('given the active pane is closed, should re-target active to the first remaining pane', () => {
    const state: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope: null },
        { id: 'pane-3', scope: null },
      ],
      activePaneId: 'pane-2',
    };

    const actual = closePane(state, 'pane-2');
    const expected: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-3', scope: null },
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
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope: null },
      ],
      activePaneId: 'pane-2',
    };

    const actual = closePane(state, 'pane-1');
    const expected: WorkspaceState = {
      panes: [{ id: 'pane-2', scope: null }],
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
});

describe('selectPane', () => {
  it('given a valid pane id, should activate it', () => {
    const state: WorkspaceState = {
      panes: [
        { id: 'pane-1', scope: null },
        { id: 'pane-2', scope: null },
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
