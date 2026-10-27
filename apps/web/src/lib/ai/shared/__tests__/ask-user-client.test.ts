/**
 * Tests for askUserAnswersComplete — the sendAutomaticallyWhen predicate that
 * auto-resumes an agent turn once a pending ask_user question is answered.
 *
 * The critical invariant: this must NEVER be true for a turn that ended with
 * the executed `finish` tool (which always has output-available), or every
 * normal agent turn would auto-resubmit forever. See ask-user-client.ts.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { askUserAnswersComplete } from '../ask-user-client';

// `parts` is loosely typed here (test fixtures build minimal tool-part shapes,
// not the full discriminated UIMessagePart union) and cast at the boundary.
const msg = (role: UIMessage['role'], parts: unknown[]): UIMessage =>
  ({ id: 'm1', role, parts } as UIMessage);

describe('askUserAnswersComplete', () => {
  it('is false for a turn ending with the executed finish tool (no ask_user present)', () => {
    expect(
      askUserAnswersComplete({
        messages: [
          msg('assistant', [
            { type: 'tool-finish', toolCallId: 'f1', state: 'output-available', output: { done: true } },
          ]),
        ],
      })
    ).toBe(false);
  });

  it('is false while an ask_user question is still pending (input-available)', () => {
    expect(
      askUserAnswersComplete({
        messages: [
          msg('assistant', [
            { type: 'tool-ask_user', toolCallId: 'q1', state: 'input-available', input: { questions: [] } },
          ]),
        ],
      })
    ).toBe(false);
  });

  it('is true once every ask_user part on the last message is answered', () => {
    expect(
      askUserAnswersComplete({
        messages: [
          msg('assistant', [
            { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-available', output: { answers: [] } },
          ]),
        ],
      })
    ).toBe(true);
  });

  it('is false if only SOME of multiple ask_user parts are answered', () => {
    expect(
      askUserAnswersComplete({
        messages: [
          msg('assistant', [
            { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-available', output: { answers: [] } },
            { type: 'tool-ask_user', toolCallId: 'q2', state: 'input-available', input: { questions: [] } },
          ]),
        ],
      })
    ).toBe(false);
  });

  it('is true for an errored ask_user tool part (output-error also unblocks the loop)', () => {
    expect(
      askUserAnswersComplete({
        messages: [
          msg('assistant', [
            { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-error', errorText: 'boom' },
          ]),
        ],
      })
    ).toBe(true);
  });

  it('is false when the last message is not from the assistant', () => {
    expect(
      askUserAnswersComplete({
        messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      })
    ).toBe(false);
  });

  it('is false for an empty message list', () => {
    expect(askUserAnswersComplete({ messages: [] })).toBe(false);
  });
});
