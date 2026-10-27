import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, channelsSendHandler, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const SENT_MESSAGE = {
  id: 'm1',
  content: 'hello team',
  createdAt: '2026-07-01T12:00:00.000Z',
  pageId: 'ch1',
  userId: 'u1',
  fileId: null,
  attachmentMeta: null,
  isActive: true,
  editedAt: null,
  aiMeta: null,
  parentId: null,
  replyCount: 0,
  lastReplyAt: null,
  mirroredFromId: null,
  quotedMessageId: null,
  user: { id: 'u1', name: 'Ada', image: null },
  file: null,
  reactions: [],
  mirroredFrom: null,
};

describe('channelsSendHandler', () => {
  it('exits 2 with a usage error when the message is missing', async () => {
    const send = vi.fn(async () => SENT_MESSAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ channels: { send } }) });

    const code = await channelsSendHandler(ctx, commandIntent(['ch1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(send).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when the channelId is missing', async () => {
    const send = vi.fn(async () => SENT_MESSAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ channels: { send } }) });

    const code = await channelsSendHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(send).not.toHaveBeenCalled();
  });

  it('calls channels.send with pageId + content for the given argv', async () => {
    const send = vi.fn(async () => SENT_MESSAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ channels: { send } }) });

    const code = await channelsSendHandler(ctx, commandIntent(['ch1', 'hello team']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(send).toHaveBeenCalledWith({ pageId: 'ch1', content: 'hello team' });
  });

  it('exits 2 with a usage error given more than one message token (must be shell-quoted)', async () => {
    const send = vi.fn(async () => SENT_MESSAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ channels: { send } }) });

    const code = await channelsSendHandler(ctx, commandIntent(['ch1', 'hello', 'team']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(send).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ channels: { send: async () => SENT_MESSAGE } }) });

    const code = await channelsSendHandler(ctx, commandIntent(['ch1', 'hello team', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(SENT_MESSAGE);
  });

  it('renders a confirmation line in human mode', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ channels: { send: async () => SENT_MESSAGE } }) });

    await channelsSendHandler(ctx, commandIntent(['ch1', 'hello team']));

    expect(stdout.lines.join('')).toBe('Sent message m1 to ch1.\n');
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const send = vi.fn(async () => {
      throw new Error('Channel not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ channels: { send } }) });

    const code = await channelsSendHandler(ctx, commandIntent(['ch1', 'hi']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Channel not found');
  });
});
