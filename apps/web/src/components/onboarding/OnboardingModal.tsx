'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Bot, Check, RotateCcw, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils/index';
import { isOnPrem } from '@/lib/deployment-mode';
import {
  SCALE_CONTENT,
  SCALE_OPTIONS,
  UNSURE_PROMPT,
  getExamples,
  getScaleLabel,
  type Scale,
} from './onboarding-content';
import {
  STEP_COUNT,
  canAdvance,
  initialOnboardingState,
  onboardingReducer,
} from './onboarding-state';
import { useOnboardingHandoffStore } from '@/stores/useOnboardingHandoffStore';

interface OnboardingModalProps {
  open: boolean;
  /** Called with what the user told us, once, when they finish or skip. */
  onFinish: (input?: { scaleLabel: string; firstRequest: string }) => void;
}

/**
 * First-run onboarding.
 *
 * Teaches what PageSpace is, then hands the user's own first request to the
 * global assistant. It configures nothing: the Home drive is already seeded by
 * `provisionHomeDriveIfNeeded` before this ever renders.
 */
export function OnboardingModal({ open, onFinish }: OnboardingModalProps) {
  const [state, dispatch] = useReducer(onboardingReducer, initialOnboardingState);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const setPendingRequest = useOnboardingHandoffStore((s) => s.setPendingRequest);

  // isOnPrem, never !isCloud(): tenant deployments keep their integrations, so
  // gating on !isCloud() would wrongly strip examples for tenant users.
  const cloudAllowed = useMemo(() => !isOnPrem(), []);
  const content = state.scale ? SCALE_CONTENT[state.scale] : null;

  // Move focus to the heading on every step change so the new screen is
  // announced. Without this a screen-reader user hears nothing: the body swaps
  // but focus stays on a button whose label did not change.
  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
  }, [state.step, open]);

  const finish = useCallback(
    (send: boolean) => {
      const request = state.prompt.trim();
      if (send && request) {
        // Queue before dismissing so the assistant can pick it up as soon as it
        // has a conversation, even though this component is about to unmount.
        setPendingRequest(request);
      }
      onFinish(
        send && request && state.scale
          ? { scaleLabel: getScaleLabel(state.scale), firstRequest: request }
          : undefined,
      );
    },
    [state.prompt, state.scale, onFinish, setPendingRequest],
  );

  const isLast = state.step === STEP_COUNT - 1;
  const advanceLabel = state.step === 0 ? 'Continue' : state.step === 1 ? 'Show me' : isLast ? 'Ask' : 'Continue';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape and outside-click take the same path as Skip: the user has
        // decided, and re-showing the flow would override that decision.
        if (!next) finish(false);
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="onboarding-modal">
        <div className="flex items-center justify-between gap-3">
          <ol className="flex items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <li
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === state.step ? 'w-5 bg-primary' : i < state.step ? 'w-1.5 bg-primary/40' : 'w-1.5 bg-muted',
                )}
              />
            ))}
          </ol>
          <span className="sr-only" aria-live="polite">
            Step {state.step + 1} of {STEP_COUNT}
          </span>
          <button
            type="button"
            onClick={() => finish(false)}
            className="text-[13px] text-muted-foreground hover:text-foreground hover:underline underline-offset-4 py-1.5 px-1 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Skip — I&apos;ll just start asking
          </button>
        </div>

        {/* Announces chip selections, which otherwise change the textarea silently. */}
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>

        {state.step === 0 && (
          <Step
            headingRef={headingRef}
            title="Who’s this for?"
            sub="Just so I show you the right things — and skip the rest. You can change this any time."
          >
            <div role="radiogroup" aria-label="Who is this for?" className="grid gap-2 sm:grid-cols-2">
              {SCALE_OPTIONS.map((option) => {
                const selected = state.scale === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => dispatch({ type: 'selectScale', scale: option.id })}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-3 text-left shadow-xs transition-colors',
                      'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'bg-card hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                        selected ? 'border-primary bg-primary' : 'border-input',
                      )}
                    >
                      {selected && <Check className="size-2.5 text-primary-foreground" strokeWidth={3.5} />}
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">{option.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Step>
        )}

        {state.step === 1 && content && (
          <Step headingRef={headingRef} title="Just ask." sub="There’s no menu to learn and no right way to start. Tell PageSpace what you need — in your own words, like you’d tell a person — and it gets on with it.">
            <div className="flex flex-col gap-2">
              <p className="self-end max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                {content.sampleRequest}
              </p>
              <div className="flex max-w-[92%] items-start gap-2.5 self-start rounded-lg rounded-bl-sm border bg-card px-3.5 py-2.5 text-sm">
                <Avatar />
                <span>{content.sampleReply}</span>
              </div>
            </div>
            <Reassurance>
              Don’t worry about getting the words right. If it misreads you,{' '}
              <strong className="font-semibold text-foreground">say so and it changes course.</strong>
            </Reassurance>
          </Step>
        )}

        {state.step === 2 && content && (
          <Step
            headingRef={headingRef}
            title="It doesn’t just answer. It does."
            sub={`Most AI gives you advice, and you’re still the one doing the work. This one does the work — in your workspace, where ${content.workspaceNoun} lives.`}
          >
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {content.outcomes.map((outcome) => (
                <li key={outcome} className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-[13px] font-medium shadow-xs">
                  <span aria-hidden="true" className="grid size-[17px] shrink-0 place-items-center rounded-full bg-emerald-500/25">
                    <Check className="size-2.5 text-emerald-700 dark:text-emerald-400" strokeWidth={3} />
                  </span>
                  {outcome}
                </li>
              ))}
            </ul>
            <Reassurance>
              Everything it makes is{' '}
              <strong className="font-semibold text-foreground">yours to edit or throw away</strong>. Nothing is
              locked away. And it remembers — you never start from scratch twice.
            </Reassurance>
          </Step>
        )}

        {state.step === 3 && content && (
          <Step
            headingRef={headingRef}
            title="Ask for a little. Or ask for everything."
            sub="“Write me a note” and “run this whole side of things” are the same kind of request. When a job’s too big for one assistant, it gets more hands on it."
          >
            <div className="flex flex-col gap-2">
              <AskRow said="“Write this up for me.”" got="Done, in about a minute." />
              <AskRow said="“Now keep it up to date.”" got="It checks back on its own, so you don’t have to remember." />
              <AskRow said="“Actually — just handle the whole thing.”" got={content.escalation} emphasised>
                <div className="mt-2.5 flex items-center gap-1.5">
                  {Array.from({ length: content.assistantCount }, (_, i) => (
                    <span key={i} aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-primary">
                      <Bot className="size-3 text-primary-foreground" />
                    </span>
                  ))}
                  <span className="ml-1 text-xs font-medium text-primary">working on it together</span>
                </div>
              </AskRow>
            </div>
            <Reassurance>
              <strong className="font-semibold text-foreground">You can always undo.</strong> And it never sees
              anything you’ve kept private.
            </Reassurance>
          </Step>
        )}

        {state.step === 4 && state.scale && (
          <Step
            headingRef={headingRef}
            title="So. What do you want to get done?"
            sub="Anything at all. Big, small, or half-formed. You can change your mind as many times as you like."
          >
            <Textarea
              id="onboarding-first-request"
              aria-label="What do you want to get done?"
              placeholder="Tell me what you're here to do…"
              value={state.prompt}
              autoFocus
              rows={3}
              onChange={(e) => dispatch({ type: 'setPrompt', text: e.target.value, source: 'user' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && state.prompt.trim()) {
                  e.preventDefault();
                  finish(true);
                }
              }}
              className="min-h-[76px] resize-none text-sm"
            />
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">Press ⏎ to send · ⇧⏎ for a new line</p>

            <p className="mt-4 text-[11.5px] uppercase tracking-wide text-muted-foreground">Or borrow one of these</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {getExamples(state.scale, cloudAllowed).map((example) => (
                <Chip
                  key={example.text}
                  onClick={() => {
                    dispatch({ type: 'setPrompt', text: example.text, source: 'example' });
                    setAnnouncement(`Filled in: ${example.text}`);
                  }}
                >
                  {example.text}
                </Chip>
              ))}
              <Chip
                dashed
                onClick={() => {
                  dispatch({ type: 'setPrompt', text: UNSURE_PROMPT, source: 'example' });
                  setAnnouncement(`Filled in: ${UNSURE_PROMPT}`);
                }}
              >
                {UNSURE_PROMPT}
              </Chip>
            </div>
          </Step>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => dispatch({ type: 'back' })}
            className={cn(state.step === 0 && 'invisible')}
          >
            Back
          </Button>
          <Button
            disabled={!canAdvance(state)}
            onClick={() => (isLast ? finish(true) : dispatch({ type: 'next' }))}
          >
            {advanceLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({
  headingRef,
  title,
  sub,
  children,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <DialogTitle asChild>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight outline-none text-balance"
        >
          {title}
        </h2>
      </DialogTitle>
      <DialogDescription className="mt-1.5 mb-4 text-sm leading-relaxed">{sub}</DialogDescription>
      {children}
    </div>
  );
}

function Avatar() {
  return (
    <span aria-hidden="true" className="mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-md bg-primary">
      <Sparkles className="size-3 text-primary-foreground" />
    </span>
  );
}

function Reassurance({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3.5 flex items-start gap-2.5 rounded-lg bg-muted px-3.5 py-3 text-[13px] leading-snug text-muted-foreground">
      <RotateCcw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span>{children}</span>
    </p>
  );
}

function AskRow({
  said,
  got,
  emphasised,
  children,
}: {
  said: string;
  got: string;
  emphasised?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-lg border p-3 shadow-xs', emphasised ? 'border-primary bg-primary/10' : 'bg-card')}>
      <p className="text-sm font-semibold">{said}</p>
      <p className={cn('text-[13px] leading-snug', emphasised ? 'text-foreground' : 'text-muted-foreground')}>{got}</p>
      {children}
    </div>
  );
}

function Chip({
  children,
  onClick,
  dashed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  dashed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        dashed ? 'border-dashed' : 'bg-card shadow-xs',
      )}
    >
      {children}
    </button>
  );
}
