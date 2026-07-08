/**
 * AskUserQuestionCard tests.
 *
 * Regression coverage for a real bug caught in review: `drafts` was seeded
 * ONCE via a lazy useState initializer keyed off `part.input` at mount time.
 * Since a tool part streams in incrementally (input-streaming with partial/
 * unparsable JSON, THEN input-available with the final questions array),
 * a card that first mounted before input finished parsing permanently held
 * an empty `drafts` array. `drafts.every(...)` on that empty array is
 * vacuously true, so Submit could enable with nothing selected, and
 * `handleSubmit` would then crash dereferencing `drafts[i]` (undefined).
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AskUserQuestionCard } from '../ask-user/AskUserQuestionCard';
import { AskUserAnswerProvider } from '../ask-user/AskUserAnswerContext';

const QUESTIONS_INPUT = {
  questions: [
    {
      header: 'Auth method',
      question: 'Which auth method should we use?',
      options: [{ label: 'OAuth' }, { label: 'API key' }],
    },
  ],
};

const answerablePart = (input: unknown, toolCallId = 'q1') => ({
  type: 'tool-ask_user',
  toolCallId,
  state: 'input-available' as const,
  input,
});

function renderAnswerable(
  part: ReturnType<typeof answerablePart>,
  submitAnswers: (toolCallId: string, output: unknown) => void = () => {}
) {
  return render(
    <AskUserAnswerProvider value={{ answerableToolCallIds: new Set([part.toolCallId]), submitAnswers }}>
      <AskUserQuestionCard part={part} />
    </AskUserAnswerProvider>
  );
}

describe('AskUserQuestionCard', () => {
  it('renders nothing while input is streaming and not yet parsable JSON', () => {
    const part = { type: 'tool-ask_user', toolCallId: 'q1', state: 'input-streaming' as const, input: '{"quest' };
    const { container } = renderAnswerable(part as never);
    expect(container.textContent).toBe('');
  });

  it('does NOT enable Submit before any option is selected (no vacuous empty-drafts bypass)', () => {
    const part = answerablePart(QUESTIONS_INPUT);
    const { getByText } = renderAnswerable(part);
    const submitButton = getByText('Submit') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });

  it('enables Submit only after selecting an option, and submits the correct answer', () => {
    let submitted: unknown = null;
    const part = answerablePart(QUESTIONS_INPUT);
    const { getByText } = renderAnswerable(part, (_toolCallId, output) => {
      submitted = output;
    });

    fireEvent.click(getByText('OAuth'));
    const submitButton = getByText('Submit') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);

    fireEvent.click(submitButton);
    expect(submitted).toEqual({
      answers: [{ header: 'Auth method', question: 'Which auth method should we use?', selectedLabel: 'OAuth' }],
    });
  });

  it('resyncs drafts (and does not crash on submit) when a card mounts before input finishes streaming', () => {
    // Mount with unparsable/streaming input (drafts seeds to []), THEN
    // transition to the finalized questions array on a re-render — mirrors
    // the real tool-part lifecycle (input-streaming -> input-available).
    const streamingPart = {
      type: 'tool-ask_user',
      toolCallId: 'q1',
      state: 'input-streaming' as const,
      input: '{"quest',
    };
    const finalPart = answerablePart(QUESTIONS_INPUT);

    const { rerender, getByText, queryByText } = renderAnswerable(streamingPart as never);
    expect(queryByText('Submit')).toBeNull();

    rerender(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['q1']), submitAnswers: () => {} }}>
        <AskUserQuestionCard part={finalPart} />
      </AskUserAnswerProvider>
    );

    // Drafts must have resynced to length 1 (not stuck at the initial []) —
    // Submit starts disabled (no vacuous empty-array bypass)...
    const submitButton = getByText('Submit') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    // ...and clicking an option + Submit works without throwing.
    expect(() => {
      fireEvent.click(getByText('OAuth'));
      fireEvent.click(getByText('Submit'));
    }).not.toThrow();
  });

  it('renders read-only (no interactive buttons disabled-state crash) when not answerable', () => {
    const part = answerablePart(QUESTIONS_INPUT);
    const { getByText } = render(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(), submitAnswers: () => {} }}>
        <AskUserQuestionCard part={part} />
      </AskUserAnswerProvider>
    );
    const submitButton = getByText('Waiting for a response…') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});
