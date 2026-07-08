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
    const { getByRole, getByText } = renderAnswerable(part, (_toolCallId, output) => {
      submitted = output;
    });

    fireEvent.click(getByRole('button', { name: /OAuth/ }));
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

    const { rerender, getByRole, getByText, queryByText } = renderAnswerable(streamingPart as never);
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
      fireEvent.click(getByRole('button', { name: /OAuth/ }));
      fireEvent.click(getByText('Submit'));
    }).not.toThrow();
  });

  it('matches answers to questions by position, not by header — duplicate headers do not collide', () => {
    // Two questions sharing the identical header ("Approach") — headers have
    // no uniqueness constraint. handleSubmit builds `answers` positionally
    // (input.questions.map((q, i) => ...)), so rendering must read answers
    // back the same way, or one question would display the other's answer.
    const duplicateHeaderInput = {
      questions: [
        { header: 'Approach', question: 'Which approach for the backend?', options: [{ label: 'REST' }, { label: 'GraphQL' }] },
        { header: 'Approach', question: 'Which approach for the frontend?', options: [{ label: 'SSR' }, { label: 'CSR' }] },
      ],
    };
    const part = {
      type: 'tool-ask_user',
      toolCallId: 'q1',
      state: 'output-available' as const,
      input: duplicateHeaderInput,
      output: {
        answers: [
          { header: 'Approach', question: 'Which approach for the backend?', selectedLabel: 'REST' },
          { header: 'Approach', question: 'Which approach for the frontend?', selectedLabel: 'CSR' },
        ],
      },
    };
    // With >1 question, only the active tab's question is in the DOM at a
    // time — the first tab (backend/REST-GraphQL) is active by default.
    const { getByRole, getAllByRole } = renderAnswerable(part as never);

    const isChosen = (name: RegExp) =>
      (getByRole('button', { name }) as HTMLButtonElement).querySelector('svg') !== null;

    expect(isChosen(/REST/)).toBe(true);
    expect(isChosen(/GraphQL/)).toBe(false);

    // Switch to the second tab ("2. Approach") — its OWN answer (CSR) must
    // show as chosen, not the first question's (this is exactly the bug the
    // positional-matching fix guards against: keying by header would have
    // shown REST's checkmark here too, since both tabs share the header).
    fireEvent.click(getAllByRole('tab')[1]);
    expect(isChosen(/CSR/)).toBe(true);
    expect(isChosen(/SSR/)).toBe(false);
  });

  it('renders a tab per question only when there is more than one question', () => {
    const { queryAllByRole } = renderAnswerable(answerablePart(QUESTIONS_INPUT));
    expect(queryAllByRole('tab')).toHaveLength(0);
  });

  it('arrow-key navigation between tabs moves the active question', () => {
    const twoQuestions = {
      questions: [
        { header: 'Q1', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { header: 'Q2', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    };
    const { getAllByRole, getByText } = renderAnswerable(answerablePart(twoQuestions));
    const tabs = getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(getByText('Second?')).toBeTruthy();

    fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(getByText('First?')).toBeTruthy();
  });

  it('number-key shortcut selects the Nth option of the active question without a click', () => {
    let submitted: unknown = null;
    const part = answerablePart(QUESTIONS_INPUT);
    const { getByRole, getByText, container } = renderAnswerable(part, (_toolCallId, output) => {
      submitted = output;
    });

    fireEvent.keyDown(container.firstChild as HTMLElement, { key: '2' });
    expect(getByRole('button', { name: /API key/ }).querySelector('svg')).not.toBeNull();

    fireEvent.click(getByText('Submit'));
    expect(submitted).toEqual({
      answers: [{ header: 'Auth method', question: 'Which auth method should we use?', selectedLabel: 'API key' }],
    });
  });

  it('does not treat digits typed into the Other… textarea as the number-key shortcut', () => {
    const part = answerablePart(QUESTIONS_INPUT);
    const { getByRole, getByPlaceholderText } = renderAnswerable(part);

    fireEvent.click(getByRole('button', { name: /Other…/ }));
    const textarea = getByPlaceholderText('Type your answer…');
    fireEvent.keyDown(textarea, { key: '1' });

    // OAuth (option 1) must NOT become selected just because '1' was
    // pressed while focus was in the free-text field.
    expect(getByRole('button', { name: /OAuth/ }).querySelector('svg')).toBeNull();
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
