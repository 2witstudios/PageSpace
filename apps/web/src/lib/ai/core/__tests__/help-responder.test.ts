import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

const mockLoadHelpAnswerText = vi.hoisted(() => vi.fn());

vi.mock('@/lib/commands/help-answer', () => ({
  loadHelpAnswerText: mockLoadHelpAnswerText,
}));

vi.mock('@paralleldrive/cuid2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@paralleldrive/cuid2')>()),
  createId: vi.fn().mockReturnValue('help-message-id'),
}));

import { respondWithHelpAnswer } from '../help-responder';

const ANSWER_TEXT = 'Here are the commands available to you:\n\n- **/help** (built-in) — List the commands.';

const originalMessages: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: '/[help](builtin:help:command)' }] },
];

/** Drains the response body so `execute` (which runs the persist call) settles. */
const drain = async (response: Response): Promise<void> => {
  await new Response(response.body).text();
};

describe('respondWithHelpAnswer', () => {
  beforeEach(() => {
    mockLoadHelpAnswerText.mockReset().mockResolvedValue(ANSWER_TEXT);
  });

  it('loads the answer for the given sender/drive and returns a Response', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);

    const response = await respondWithHelpAnswer({
      senderId: 'user-1',
      driveId: 'drive-1',
      originalMessages,
      persist,
    });

    expect(response).toBeInstanceOf(Response);
    expect(mockLoadHelpAnswerText).toHaveBeenCalledWith('user-1', 'drive-1');
  });

  it('persists exactly once, synchronously inside execute, with the generated messageId and the loaded answer as content', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);

    const response = await respondWithHelpAnswer({
      senderId: 'user-1',
      driveId: null,
      originalMessages,
      persist,
    });
    await drain(response);

    expect(persist).toHaveBeenCalledTimes(1);
    const [payload, messageId] = persist.mock.calls[0];
    expect(messageId).toBe('help-message-id');
    expect(payload.content).toBe(ANSWER_TEXT);
  });

  it('includes a used /help command-execution part in the persisted uiMessage (so the pill survives reload)', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);

    const response = await respondWithHelpAnswer({
      senderId: 'user-1',
      driveId: null,
      originalMessages,
      persist,
    });
    await drain(response);

    const [payload] = persist.mock.calls[0];
    const commandPart = payload.uiMessage.parts.find(
      (p: { type: string }) => p.type === 'data-command-execution'
    );
    expect(commandPart).toMatchObject({ data: { label: 'help', status: 'used' } });
  });

  it('does not fail the response when persist rejects (best-effort, logged not thrown)', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('db down'));

    const response = await respondWithHelpAnswer({
      senderId: 'user-1',
      driveId: null,
      originalMessages,
      persist,
    });

    await expect(drain(response)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
