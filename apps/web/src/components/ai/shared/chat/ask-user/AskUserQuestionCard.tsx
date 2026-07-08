import React, { useMemo, useState } from 'react';
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

  const answeredByHeader = new Map(
    output && 'answers' in output ? output.answers.map((a) => [a.header, a]) : []
  );

  const setDraft = (index: number, patch: Partial<DraftAnswer>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const canSubmit =
    isAnswerable &&
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

  return (
    <div className="my-2 rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <HelpCircle className="h-4 w-4" />
        Question{input.questions.length > 1 ? 's' : ''}
      </div>

      {input.questions.map((q, i) => {
        const answered = answeredByHeader.get(q.header);
        const draft = drafts[i];

        return (
          <div key={i} className="space-y-2">
            <Badge variant="secondary" className="font-normal">
              {q.header}
            </Badge>
            <p className="text-sm">{q.question}</p>

            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
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
                    onClick={() => setDraft(i, { selectedLabel: opt.label, showOther: false })}
                    className="flex items-center gap-1.5"
                    title={opt.description}
                  >
                    {isChosen && <Check className="h-3.5 w-3.5" />}
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
                  onClick={() => setDraft(i, { showOther: true })}
                >
                  Other…
                </Button>
              )}
            </div>

            {answered?.otherText && (
              <p className="text-sm italic text-muted-foreground">"{answered.otherText}"</p>
            )}

            {!answered && draft?.showOther && (
              <Textarea
                value={draft.otherText ?? ''}
                onChange={(e) => setDraft(i, { otherText: e.target.value })}
                placeholder="Type your answer…"
                disabled={!isAnswerable}
                className="text-sm"
                rows={2}
              />
            )}
          </div>
        );
      })}

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
