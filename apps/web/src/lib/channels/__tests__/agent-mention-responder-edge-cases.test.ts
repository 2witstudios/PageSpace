/**
 * Universal Commands phase 6 — channel pipeline integration edge cases.
 *
 * Unlike agent-mention-responder-commands.test.ts (which mocks the command
 * resolver), this file runs the REAL command resolver + processor inside
 * triggerMentionedAgentResponses with only the DB and permissions mocked.
 * It proves the two token pipelines — @mention resolution and /command
 * resolution — run side by side on one message without corrupting each
 * other, and that every command degradation (deleted command, deleted
 * drive, revoked membership, hostile tokens, resolver DB failure) degrades
 * the command only: the agent response itself always proceeds.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      channelMessages: { findMany: vi.fn() },
      commands: { findFirst: vi.fn() },
    },
  },
}));
// Structured operator mocks so tests can inspect WHERE clauses (e.g. prove
// the agent lookup filters by the mention id, never the command id).
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
  inArray: vi.fn((field: unknown, values: unknown) => ({ op: 'inArray', field, values })),
  desc: vi.fn(),
  asc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id',
    type: 'type',
    isTrashed: 'isTrashed',
    parentId: 'parentId',
    position: 'position',
  },
}));
vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: { pageId: 'pageId', isActive: 'isActive', createdAt: 'createdAt' },
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-agent-service', () => ({
  getAgentContextDrives: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
  },
}));
vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  agentCommunicationTools: { ask_agent: { execute: vi.fn() } },
}));
vi.mock('@/lib/ai/tools/channel-tools', () => ({
  channelTools: { send_channel_message: { execute: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    insertChannelThreadReply: vi.fn(),
    loadChannelMessageWithRelations: vi.fn(),
    listChannelThreadFollowers: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({})),
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn(),
  broadcastThreadReplyCountUpdated: vi.fn(),
}));
vi.mock('@pagespace/lib/services/preview', () => ({
  buildThreadPreview: vi.fn(() => 'preview'),
}));

import { db } from '@pagespace/db/db';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { agentCommunicationTools } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import { triggerMentionedAgentResponses } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;
const mockCommandsFindFirst = db.query.commands.findFirst as unknown as Mock;
const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockIsUserDriveMember = vi.mocked(isUserDriveMember);
const mockAskAgentExecute = agentCommunicationTools.ask_agent.execute as unknown as Mock;
const mockSendChannelExecute = channelTools.send_channel_message.execute as unknown as Mock;

const SENDER = 'usr9zmbrgj3atz4a98xxat96';
const AGENT_ID = 'agt9zmbrgj3atz4a98xxat96';
const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';
const ENTRY_PAGE_ID = 'pge9zmbrgj3atz4a98xxat96';
const DRIVE_ID = 'drv9zmbrgj3atz4a98xxat96';
const SECRET_CONTENT = 'SECRET checklist body';

const agentRow = { id: AGENT_ID, title: 'Helper', enabledTools: ['send_channel_message'] };
const childRow = { id: 'chd9zmbrgj3atz4a98xxat96', title: 'Rollback Plan', type: 'DOCUMENT' };

/**
 * Both the agent lookup and the command child-manifest loader go through
 * db.query.pages.findMany; route on the column set each caller selects
 * (agents select enabledTools, the child loader does not).
 */
function routePagesFindMany({ agents = [agentRow], children = [childRow] } = {}) {
  mockPagesFindMany.mockImplementation((args: { columns?: Record<string, boolean> }) =>
    Promise.resolve(args?.columns?.enabledTools ? agents : children)
  );
}

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CMD_ID,
    userId: SENDER,
    driveId: null,
    trigger: 'release-checklist',
    description: 'Run the release checklist.',
    entryPageId: ENTRY_PAGE_ID,
    type: 'document',
    enabled: true,
    entryPage: {
      id: ENTRY_PAGE_ID,
      title: 'Release Checklist',
      type: 'DOCUMENT',
      contentMode: 'markdown',
      content: SECRET_CONTENT,
      isTrashed: false,
    },
    ...overrides,
  };
}

const params = {
  userId: SENDER,
  channelId: 'channel-1',
  channelTitle: 'General',
  sourceMessageId: 'msg-1',
  content: `/[release-checklist](${CMD_ID}:command) @[Helper](${AGENT_ID}:page) run it`,
};

function askContext(): string {
  expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
  return (mockAskAgentExecute.mock.calls[0][0] as { context: string }).context;
}

/** Mocked-query WHERE clause shape produced by the structured operator mocks. */
interface WhereClause {
  op: string;
  args?: WhereClause[];
  values?: unknown;
}

/** Baseline happy-path mock state; also used to re-arm after a mid-test reset. */
function armDefaultMocks() {
  routePagesFindMany();
  mockChannelMessagesFindMany.mockResolvedValue([]);
  mockCommandsFindFirst.mockResolvedValue(commandRow());
  mockCanUserViewPage.mockResolvedValue(true);
  mockIsUserDriveMember.mockResolvedValue(true);
  mockAskAgentExecute.mockResolvedValue({ success: true, response: 'done' });
  mockSendChannelExecute.mockResolvedValue({ success: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  armDefaultMocks();
});

describe('command chip and @mention in one message — both pipelines run', () => {
  it('asks the mentioned agent AND injects the real command content into its context', async () => {
    await triggerMentionedAgentResponses(params);

    const context = askContext();
    expect(context).toContain('COMMAND: /release-checklist');
    expect(context).toContain(SECRET_CONTENT);
    // The child-resource manifest came through the real resolver too.
    expect(context).toContain('Rollback Plan');

    // The mention pipeline was untouched: the reply goes out via the agent.
    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: { commandExecution?: unknown };
    };
    expect(sendOptions.experimental_context.commandExecution).toEqual([{
      label: 'release-checklist',
      status: 'used',
      entryPageTitle: 'Release Checklist',
    }]);
  });

  it('never treats the mentioned agent id as a command or the command id as a mention', async () => {
    await triggerMentionedAgentResponses(params);
    // Command resolution queried exactly the chip's commandId path once.
    expect(mockCommandsFindFirst).toHaveBeenCalledTimes(1);

    // The agent lookup's WHERE filters by exactly the mention id — a
    // regression that feeds the command id into mention resolution fails
    // here, not just at the column-shape level.
    const agentLookupCall = mockPagesFindMany.mock.calls.find(
      (call) => (call[0] as { columns?: Record<string, boolean> })?.columns?.enabledTools
    ) as [{ where: WhereClause }] | undefined;
    expect(agentLookupCall).toBeDefined();
    const idFilter = agentLookupCall![0].where.args?.find(
      (clause) => clause.op === 'inArray'
    );
    expect(idFilter?.values).toEqual([AGENT_ID]);
  });
});

describe('command degradations never block the agent response', () => {
  it('drive command after membership revocation: skip notice in context, no content leak, agent still replies', async () => {
    mockCommandsFindFirst.mockResolvedValue(commandRow({ userId: null, driveId: DRIVE_ID }));
    mockIsUserDriveMember.mockResolvedValue(false);

    await triggerMentionedAgentResponses(params);

    const context = askContext();
    expect(context).toContain('the command no longer exists');
    expect(context).not.toContain(SECRET_CONTENT);
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);

    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: { commandExecution?: unknown };
    };
    expect(sendOptions.experimental_context.commandExecution).toEqual([{
      label: 'release-checklist',
      status: 'skipped',
      reason: 'not_found',
    }]);
  });

  it('command row gone (entry page or drive hard-deleted, FK cascade): skip notice, agent still replies', async () => {
    mockCommandsFindFirst.mockResolvedValue(undefined);

    await triggerMentionedAgentResponses(params);

    expect(askContext()).toContain('the command no longer exists');
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });

  it('command disabled mid-conversation: skip notice now, full injection after re-enable', async () => {
    mockCommandsFindFirst.mockResolvedValueOnce(commandRow({ enabled: false }));
    await triggerMentionedAgentResponses(params);
    expect(askContext()).toContain('the command is disabled');

    vi.clearAllMocks();
    armDefaultMocks();
    mockCommandsFindFirst.mockResolvedValue(commandRow({ enabled: true }));

    await triggerMentionedAgentResponses(params);
    expect(askContext()).toContain(SECRET_CONTENT);
  });

  it('resolver DB failure: command contributes nothing, the agent response proceeds', async () => {
    mockCommandsFindFirst.mockRejectedValue(new Error('db exploded'));

    await expect(triggerMentionedAgentResponses(params)).resolves.toBeUndefined();

    const context = askContext();
    expect(context).not.toContain('COMMAND:');
    expect(context).not.toContain(SECRET_CONTENT);

    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: Record<string, unknown>;
    };
    expect('commandExecution' in sendOptions.experimental_context).toBe(false);
  });

  it('forged command token beside a real mention: hostile id skips without I/O, mention still works', async () => {
    const forged = {
      ...params,
      content: `/[x](../../etc:command) @[Helper](${AGENT_ID}:page) run it`,
    };

    await triggerMentionedAgentResponses(forged);

    expect(mockCommandsFindFirst).not.toHaveBeenCalled();
    const context = askContext();
    expect(context).toContain('the command no longer exists');
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });
});
