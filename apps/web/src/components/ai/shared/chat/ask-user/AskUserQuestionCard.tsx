import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HelpCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAskUserAnswerContext } from './AskUserAnswerContext';
import type { AskUserInput, AskUserAnswer } from '@/lib/ai/tools/ask-user-tools';

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
}

interface AskUserQuestionCardProps {
  part: ToolPart;
}

const safeParseInput = (value: unknown): AskUserInput | null => {
  const parsed = typeof value === 'string' ? tryJson(value) : value;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as AskUserInput).questions)) return null;
  return parsed as AskUserInput;
};

const tryJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

type AskUserOutputShape =
  | { answers: AskUserAnswer[] }
  | { dismissed: true; reason: string };

const safeParseOutput = (value: unknown): AskUserOutputShape | null => {
  const parsed = typeof value === 'string' ? tryJson(value) : value;
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as AskUserOutputShape;
};

/** Local per-question selection state before the user submits. */
interface DraftAnswer {
  selectedLabel?: string;
  otherText?: string;
  showOther: boolean;
}

export const AskUserQuestionCard: React.FC<AskUserQuestionCardProps> = ({ part }) => {
  const ctx = useAskUserAnswerContext();
  const input = useMemo(() => safeParseInput(part.input), [part.input]);
  const output = useMemo(() => safeParseOutput(part.output), [part.output]);

  const isAnswerable = Boolean(
    ctx && part.toolCallId && part.state === 'input-available' && ctx.answerableToolCallIds.has(part.toolCallId)
  );

  const [drafts, setDrafts] = useState<DraftAnswer[]>(() =>
    (input?.questions ?? []).map(() => ({ showOther: false }))
  );
  // Multiple questions render as tabs (mirrors Claude Code's AskUserQuestion),
  // one question visible at a time, so a keyboard/mouse-free user navigates
  // with arrow keys instead of tabbing through every option of every question.
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // `input` streams in incrementally (input-streaming state, or a partial/
  // unparsable JSON string) and only becomes the final questions array once
  // streaming completes — well after this component first mounted and ran
  // the lazy useState initializer above. Resync drafts whenever the question
  // count changes so a card that mounted with 0 questions (still streaming)
  // grows real per-question draft slots once input finalizes, instead of
  // permanently holding an empty drafts array.
  const questionCount = input?.questions.length ?? 0;
  useEffect(() => {
    setDrafts((prev) =>
      prev.length === questionCount ? prev : Array.from({ length: questionCount }, () => ({ showOther: false }))
    );
    setActiveIndex((prev) => (prev < questionCount ? prev : 0));
  }, [questionCount]);

  if (!input) return null;

  if (part.state === 'input-streaming') {
    return (
      <div className="my-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Preparing a question…
      </div>
    );
  }

  if (output && 'dismissed' in output) {
    return (
      <div className="my-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Answered in chat instead.
      </div>
    );
  }

  // Answers correspond to questions by POSITION, not by header — headers are
  // free-form model-authored text with no uniqueness constraint, so two
  // questions in the same call can legitimately share a header (e.g. both
  // titled "Approach"). handleSubmit below builds `answers` via
  // `input.questions.map((q, i) => ...)`, so `answers[i]` always answers
  // `input.questions[i]`; keying by header here would silently swap answers
  // whenever two headers collide.
  const answeredList = output && 'answers' in output ? output.answers : undefined;

  const setDraft = (index: number, patch: Partial<DraftAnswer>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const canSubmit =
    isAnswerable &&
    // Defends against a stale drafts array (e.g. mid-resync effect): `.every`
    // on an empty/mismatched array is vacuously true, so the length check
    // must hold before trusting it.
    drafts.length === questionCount &&
    drafts.every((d) => (d.showOther ? d.otherText?.trim() : d.selectedLabel));

  const handleSubmit = () => {
    if (!ctx || !part.toolCallId || !canSubmit || !input) return;
    const answers: AskUserAnswer[] = input.questions.map((q, i) => {
      const draft = drafts[i];
      return draft.showOther
        ? { header: q.header, question: q.question, otherText: draft.otherText }
        : { header: q.header, question: q.question, selectedLabel: draft.selectedLabel };
    });
    ctx.submitAnswers(part.toolCallId, { answers });
  };

  const isQuestionAnswered = (i: number) => {
    if (answeredList?.[i]) return true;
    const d = drafts[i];
    return Boolean(d && (d.showOther ? d.otherText?.trim() : d.selectedLabel));
  };

  const focusTab = (index: number) => {
    setActiveIndex(index);
    tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusTab((index + 1) % questionCount);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusTab((index - 1 + questionCount) % questionCount);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(questionCount - 1);
    }
  };

  // Number-key shortcut: jump straight to option N of the active question
  // without tabbing/clicking into it. Ignored while typing free text (a
  // digit is valid Other… content) and once the question is no longer
  // answerable — mirrors `isAnswerable` disabling the option buttons below.
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isAnswerable) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    const digit = Number(e.key);
    if (!Number.isInteger(digit) || digit < 1) return;
    const q = input.questions[activeIndex];
    if (!q || answeredList?.[activeIndex]) return;
    if (digit <= q.options.length) {
      setDraft(activeIndex, { selectedLabel: q.options[digit - 1].label, showOther: false });
    } else if (digit === q.options.length + 1) {
      setDraft(activeIndex, { showOther: true });
    }
  };

  const activeQuestion = input.questions[activeIndex];
  const answered = answeredList?.[activeIndex];
  const draft = drafts[activeIndex];

  return (
    <div className="my-2 rounded-lg border bg-card p-4 space-y-4" onKeyDown={onCardKeyDown}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <HelpCircle className="h-4 w-4" />
        Question{questionCount > 1 ? 's' : ''}
      </div>

      {questionCount > 1 && (
        <div role="tablist" aria-label="Questions" className="flex flex-wrap gap-1.5">
          {input.questions.map((q, i) => (
            <button
              key={i}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              type="button"
              aria-selected={i === activeIndex}
              tabIndex={i === activeIndex ? 0 : -1}
              onClick={() => setActiveIndex(i)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                i === activeIndex
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              {isQuestionAnswered(i) && <Check className="h-3 w-3" />}
              {i + 1}. {q.header}
            </button>
          ))}
        </div>
      )}

      {activeQuestion && (
        <div role="tabpanel" className="space-y-2">
          <Badge variant="secondary" className="font-normal">
            {activeQuestion.header}
          </Badge>
          <p className="text-sm">{activeQuestion.question}</p>

          <div className="flex flex-wrap gap-2">
            {activeQuestion.options.map((opt, optIndex) => {
              const isChosen = answered
                ? answered.selectedLabel === opt.label
                : draft?.selectedLabel === opt.label && !draft.showOther;
              return (
                <Button
                  key={opt.label}
                  type="button"
                  variant={isChosen ? 'default' : 'outline'}
                  size="sm"
                  disabled={!isAnswerable}
                  onClick={() => setDraft(activeIndex, { selectedLabel: opt.label, showOther: false })}
                  className="flex items-center gap-1.5"
                  title={opt.description}
                >
                  {isChosen && <Check className="h-3.5 w-3.5" />}
                  <span className="tabular-nums opacity-60">{optIndex + 1}</span>
                  {opt.label}
                </Button>
              );
            })}
            {!answered && (
              <Button
                type="button"
                variant={draft?.showOther ? 'default' : 'outline'}
                size="sm"
                disabled={!isAnswerable}
                onClick={() => setDraft(activeIndex, { showOther: true })}
                className="flex items-center gap-1.5"
              >
                <span className="tabular-nums opacity-60">{activeQuestion.options.length + 1}</span>
                Other…
              </Button>
            )}
          </div>

          {answered?.otherText && (
            <p className="text-sm italic text-muted-foreground">&quot;{answered.otherText}&quot;</p>
          )}

          {!answered && draft?.showOther && (
            <Textarea
              value={draft.otherText ?? ''}
              onChange={(e) => setDraft(activeIndex, { otherText: e.target.value })}
              placeholder="Type your answer…"
              disabled={!isAnswerable}
              className="text-sm"
              rows={2}
            />
          )}
        </div>
      )}

      {!output && (
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className={cn(!isAnswerable && 'opacity-50')}
        >
          {isAnswerable ? 'Submit' : 'Waiting for a response…'}
        </Button>
      )}
    </div>
  );
};
