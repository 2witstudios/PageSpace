import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadPanelStore } from '../useThreadPanelStore';

const reset = () =>
  useThreadPanelStore.setState({
    open: false,
    source: null,
    contextId: null,
    parentId: null,
  });

describe('useThreadPanelStore', () => {
  beforeEach(() => {
    reset();
  });

  it('given a fresh store, should be closed with null fields', () => {
    const state = useThreadPanelStore.getState();

    expect({
      given: 'a fresh store',
      should: 'be closed with null fields',
      actual: { open: state.open, source: state.source, contextId: state.contextId, parentId: state.parentId },
      expected: { open: false, source: null, contextId: null, parentId: null },
    }).toEqual({
      given: 'a fresh store',
      should: 'be closed with null fields',
      actual: { open: false, source: null, contextId: null, parentId: null },
      expected: { open: false, source: null, contextId: null, parentId: null },
    });
  });

  it('given openThread is called, should set source/contextId/parentId and mark open', () => {
    useThreadPanelStore
      .getState()
      .openThread({ source: 'channel', contextId: 'page-1', parentId: 'msg-9' });

    const state = useThreadPanelStore.getState();
    const actual = {
      open: state.open,
      source: state.source,
      contextId: state.contextId,
      parentId: state.parentId,
    };
    const expected = {
      open: true,
      source: 'channel' as const,
      contextId: 'page-1',
      parentId: 'msg-9',
    };

    expect({
      given: 'openThread is called',
      should: 'set source/contextId/parentId and mark open',
      actual,
      expected,
    }).toEqual({
      given: 'openThread is called',
      should: 'set source/contextId/parentId and mark open',
      actual: expected,
      expected,
    });
  });

  it('given an open DM thread, when openThread fires for a different parent, should swap fields without closing', () => {
    useThreadPanelStore
      .getState()
      .openThread({ source: 'dm', contextId: 'conv-1', parentId: 'msg-1' });
    useThreadPanelStore
      .getState()
      .openThread({ source: 'dm', contextId: 'conv-1', parentId: 'msg-2' });

    const state = useThreadPanelStore.getState();
    const actual = { open: state.open, parentId: state.parentId };
    const expected = { open: true, parentId: 'msg-2' };

    expect({
      given: 'an open DM thread',
      should: 'swap parentId without closing on a second openThread',
      actual,
      expected,
    }).toEqual({
      given: 'an open DM thread',
      should: 'swap parentId without closing on a second openThread',
      actual: expected,
      expected,
    });
  });

  it('given an open thread, when close is called, should reset every field', () => {
    useThreadPanelStore
      .getState()
      .openThread({ source: 'channel', contextId: 'page-1', parentId: 'msg-9' });
    useThreadPanelStore.getState().close();

    const state = useThreadPanelStore.getState();
    const actual = {
      open: state.open,
      source: state.source,
      contextId: state.contextId,
      parentId: state.parentId,
    };
    const expected = { open: false, source: null, contextId: null, parentId: null };

    expect({
      given: 'an open thread',
      should: 'reset every field on close',
      actual,
      expected,
    }).toEqual({
      given: 'an open thread',
      should: 'reset every field on close',
      actual: expected,
      expected,
    });
  });
});
