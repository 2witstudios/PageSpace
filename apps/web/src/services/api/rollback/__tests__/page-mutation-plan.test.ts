import { describe, it, vi } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';

// computePageMutation calls computePageStateHash, whose module imports the db
// connection at load time. Stub the connection so the pure hash/format helpers
// (which never touch the DB) can run in isolation.
vi.mock('@pagespace/db/db', () => ({ db: {} }));

import { channelMessages } from '@pagespace/db/schema/chat';
import { messages } from '@pagespace/db/schema/conversations';
import { chatMessages } from '@pagespace/db/schema/core';
import {
  computePageMutation,
  restoreFields,
  pickConversationTable,
  type CurrentPageForMutation,
} from '../page-mutation-plan';

function makePage(overrides: Partial<CurrentPageForMutation> = {}): CurrentPageForMutation {
  return {
    revision: 4,
    content: 'BEFORE',
    title: 'Old Title',
    parentId: 'parent_old',
    position: 1,
    isTrashed: false,
    type: 'DOCUMENT',
    driveId: 'drive_1',
    aiProvider: 'openai',
    aiModel: 'gpt',
    systemPrompt: 'sys',
    enabledTools: ['a'],
    isPaginated: false,
    includeDrivePrompt: false,
    agentDefinition: 'def',
    visibleToGlobalAssistant: false,
    includePageTree: false,
    pageTreeScope: 'scope',
    userScopedAccess: false,
    ...overrides,
  };
}

describe('computePageMutation — revision counter', () => {
  it('increments a numeric revision', () => {
    assert({
      given: 'a page whose revision is a number',
      should: 'set nextRevision to revision + 1 and currentRevision to the revision',
      actual: (() => {
        const m = computePageMutation(makePage({ revision: 4 }), {});
        return { current: m.currentRevision, next: m.nextRevision };
      })(),
      expected: { current: 4, next: 5 },
    });
  });

  it('starts the counter at 0 when the revision column is not a number', () => {
    assert({
      given: 'a page whose revision is not a number',
      should: 'treat currentRevision as 0 and nextRevision as 1',
      actual: (() => {
        const m = computePageMutation(makePage({ revision: null as unknown as number }), {});
        return { current: m.currentRevision, next: m.nextRevision };
      })(),
      expected: { current: 0, next: 1 },
    });
  });
});

describe('computePageMutation — content', () => {
  it('uses the update content when provided', () => {
    assert({
      given: 'updateData.content set',
      should: 'set nextContent to the stringified update content',
      actual: computePageMutation(makePage(), { content: 'AFTER' }).nextContent,
      expected: 'AFTER',
    });
  });

  it('reuses previous content when update omits content', () => {
    assert({
      given: 'no content in updateData',
      should: 'reuse the previous content',
      actual: computePageMutation(makePage({ content: 'BEFORE' }), {}).nextContent,
      expected: 'BEFORE',
    });
  });

  it('treats null current content as empty string and re-detects format both sides', () => {
    assert({
      given: 'null current content and no content update',
      should: 'derive both previous and next content as an empty string',
      actual: (() => {
        const m = computePageMutation(makePage({ content: null as unknown as string }), {});
        return { prev: m.previousContent, next: m.nextContent, before: m.contentFormatBefore, after: m.contentFormatAfter };
      })(),
      expected: { prev: '', next: '', before: 'text', after: 'text' },
    });
  });
});

describe('computePageMutation — nextState fallback paths (updateData empty)', () => {
  it('falls back to every current page field', () => {
    assert({
      given: 'an empty updateData',
      should: 'carry all current page fields into nextState',
      actual: (() => {
        const { nextState } = computePageMutation(makePage(), {});
        const { contentRef, ...rest } = nextState;
        void contentRef;
        return rest;
      })(),
      expected: {
        title: 'Old Title',
        parentId: 'parent_old',
        position: 1,
        isTrashed: false,
        type: 'DOCUMENT',
        driveId: 'drive_1',
        aiProvider: 'openai',
        aiModel: 'gpt',
        systemPrompt: 'sys',
        enabledTools: ['a'],
        isPaginated: false,
        includeDrivePrompt: false,
        agentDefinition: 'def',
        visibleToGlobalAssistant: false,
        includePageTree: false,
        pageTreeScope: 'scope',
        userScopedAccess: false,
      },
    });
  });
});

describe('computePageMutation — nextState override paths (non-null updates)', () => {
  it('applies every overriding field with the right coercion', () => {
    assert({
      given: 'updateData overriding every field with a non-null value',
      should: 'coerce and apply each override into nextState',
      actual: (() => {
        const { nextState } = computePageMutation(makePage(), {
          content: 'NEW',
          title: 123,
          parentId: 'parent_new',
          position: '9',
          isTrashed: 1,
          type: 'FOLDER',
          aiProvider: 'anthropic',
          aiModel: 'claude',
          systemPrompt: 'newsys',
          enabledTools: ['b', 'c'],
          isPaginated: 1,
          includeDrivePrompt: 1,
          agentDefinition: 'newdef',
          visibleToGlobalAssistant: 1,
          includePageTree: 1,
          pageTreeScope: 'newscope',
          userScopedAccess: 1,
        });
        const { contentRef, ...rest } = nextState;
        void contentRef;
        return rest;
      })(),
      expected: {
        title: '123',
        parentId: 'parent_new',
        position: 9,
        isTrashed: true,
        type: 'FOLDER',
        driveId: 'drive_1',
        aiProvider: 'anthropic',
        aiModel: 'claude',
        systemPrompt: 'newsys',
        enabledTools: ['b', 'c'],
        isPaginated: true,
        includeDrivePrompt: true,
        agentDefinition: 'newdef',
        visibleToGlobalAssistant: true,
        includePageTree: true,
        pageTreeScope: 'newscope',
        userScopedAccess: true,
      },
    });
  });

  it('sets nullable string fields to null when explicitly nulled', () => {
    assert({
      given: 'updateData nulling every nullable string field',
      should: 'set those fields to null in nextState',
      actual: (() => {
        const { nextState } = computePageMutation(makePage(), {
          aiProvider: null,
          aiModel: null,
          systemPrompt: null,
          agentDefinition: null,
          pageTreeScope: null,
        });
        return {
          aiProvider: nextState.aiProvider,
          aiModel: nextState.aiModel,
          systemPrompt: nextState.systemPrompt,
          agentDefinition: nextState.agentDefinition,
          pageTreeScope: nextState.pageTreeScope,
        };
      })(),
      expected: {
        aiProvider: null,
        aiModel: null,
        systemPrompt: null,
        agentDefinition: null,
        pageTreeScope: null,
      },
    });
  });
});

describe('restoreFields', () => {
  it('returns an empty object for a null source', () => {
    assert({
      given: 'a null source',
      should: 'return an empty object',
      actual: restoreFields(['a', 'b'], null),
      expected: {},
    });
  });

  it('copies only present fields', () => {
    assert({
      given: 'a field list where only some keys exist in the source',
      should: 'copy the present keys and skip the absent ones',
      actual: restoreFields(['a', 'b', 'c'], { a: 1, c: 3 }),
      expected: { a: 1, c: 3 },
    });
  });

  it('copies a field whose value is explicitly undefined when the key is present', () => {
    assert({
      given: 'a key present in source with an undefined value',
      should: 'copy the key (in operator matches)',
      actual: restoreFields(['a'], { a: undefined }),
      expected: { a: undefined },
    });
  });
});

describe('pickConversationTable', () => {
  it('routes channel conversations to the channel-messages table', () => {
    assert({
      given: "conversationType 'channel'",
      should: 'select channelMessages and mark isChannel',
      actual: (() => {
        const r = pickConversationTable({ conversationType: 'channel', hasPageId: true });
        return { isChannel: r.isChannel, isGlobal: r.isGlobal, label: r.label, isChannelTable: r.table === channelMessages };
      })(),
      expected: { isChannel: true, isGlobal: false, label: 'channel', isChannelTable: true },
    });
  });

  it('routes explicit global conversations to the messages table', () => {
    assert({
      given: "conversationType 'global' with a pageId present",
      should: 'select messages and mark isGlobal',
      actual: (() => {
        const r = pickConversationTable({ conversationType: 'global', hasPageId: true });
        return { isChannel: r.isChannel, isGlobal: r.isGlobal, label: r.label, isGlobalTable: r.table === messages };
      })(),
      expected: { isChannel: false, isGlobal: true, label: 'global', isGlobalTable: true },
    });
  });

  it('treats a missing pageId as global', () => {
    assert({
      given: 'no conversationType and no pageId',
      should: 'select messages as global',
      actual: (() => {
        const r = pickConversationTable({ conversationType: undefined, hasPageId: false });
        return { isGlobal: r.isGlobal, label: r.label, isGlobalTable: r.table === messages };
      })(),
      expected: { isGlobal: true, label: 'global', isGlobalTable: true },
    });
  });

  it('routes a page conversation to the chat-messages table', () => {
    assert({
      given: 'no conversationType but a pageId present',
      should: 'select chatMessages as a page conversation',
      actual: (() => {
        const r = pickConversationTable({ conversationType: undefined, hasPageId: true });
        return { isChannel: r.isChannel, isGlobal: r.isGlobal, label: r.label, isChatTable: r.table === chatMessages };
      })(),
      expected: { isChannel: false, isGlobal: false, label: 'page', isChatTable: true },
    });
  });
});
