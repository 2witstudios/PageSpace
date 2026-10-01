import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { describeToolCall, formatToolName } from '@/lib/ai/tools/tool-labels';
// From tool-significance (client-safe), not approval-policy: that module reaches the
// server tool registry through tool-filtering and must never enter the client bundle.
import { resolveEffectiveToolName } from '@/components/ai/shared/chat/tool-calls/tool-significance';
import { useToolApprovalContext } from './ToolApprovalContext';

interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  approval?: { id?: string; approved?: boolean; reason?: string };
}

interface ToolApprovalCardProps {
  part: ToolPart;
}

const parseInput = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
};

const MAX_PREVIEW_CHARS = 1200;

const inputTextOf = (params: Record<string, unknown> | null): string | null => {
  if (!params || Object.keys(params).length === 0) return null;
  return JSON.stringify(params, null, 2);
};

/**
 * The card a paused tool call shows while the harness waits for the user —
 * the human-in-the-loop gate's one interactive surface.
 *
 * States it renders:
 *  - `approval-requested`: what the agent wants to do (effective tool, its
 *    parameters) and the four answers — Allow once · Allow for this
 *    conversation · Always allow · Deny (with an optional reason).
 *  - `approval-responded`: answered — running, or (approved) waiting until
 *    every sibling approval on the turn is answered and the turn resumes.
 *
 * One polite live region stays mounted across both states, so assistive tech
 * hears the request arrive and the answer land.
 *
 * Buttons are live only when the surface's provider says this toolCallId is
 * answerable (last message, chat idle, not already claimed). Without a
 * provider — history views, other viewers — the card is read-only.
 */
export const ToolApprovalCard: React.FC<ToolApprovalCardProps> = ({ part }) => {
  const ctx = useToolApprovalContext();
  const outerName = part.toolName ?? part.type.replace(/^tool-/, '');
  const rawInput = useMemo(() => parseInput(part.input), [part.input]);
  const effectiveName = resolveEffectiveToolName(outerName, rawInput);
  const params = useMemo(
    () => (effectiveName !== outerName ? parseInput(rawInput?.parameters) : rawInput),
    [effectiveName, outerName, rawInput],
  );
  const label = formatToolName(effectiveName);
  const title = describeToolCall(effectiveName, params, label);
  const inputText = useMemo(() => inputTextOf(params), [params]);
  const isLongInput = inputText !== null && inputText.length > MAX_PREVIEW_CHARS;
  // The user approves what they can read: a long input is cut only until they ask for all of it.
  const [showFullInput, setShowFullInput] = useState(false);
  const preview = inputText && isLongInput && !showFullInput ? `${inputText.slice(0, MAX_PREVIEW_CHARS)}\n…` : inputText;

  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const approvalId = part.approval?.id;
  const isAnswerable = Boolean(
    ctx && part.toolCallId && approvalId && part.state === 'approval-requested' && ctx.approvableToolCallIds.has(part.toolCallId),
  );

  const decide = (decision: { approved: boolean; scope?: 'once' | 'conversation' | 'always'; reason?: string }) => {
    if (!ctx || !part.toolCallId || !approvalId || !isAnswerable) return;
    ctx.respond(part.toolCallId, { approvalId, ...decision });
  };

  const isResponded = part.state === 'approval-responded';
  const approved = part.approval?.approved === true;
  const awaitingSiblings = Boolean(approved && part.toolCallId && ctx?.awaitingToolCallIds?.has(part.toolCallId));
  const respondedLabel = !approved ? 'Denied' : awaitingSiblings ? 'Approved · waiting for the other approvals' : 'Approved · running';
  const statusText = isResponded ? `${title}: ${respondedLabel}` : `Approval needed: ${title}`;

  return (
    <div
      className={cn('my-2 rounded-lg border bg-card', isResponded ? 'p-3 text-sm' : 'border-amber-500/40 p-4 space-y-3')}
      data-testid="tool-approval-card"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {statusText}
      </span>
      {isResponded ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          {approved && !awaitingSiblings ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : approved ? (
            <ShieldCheck className="h-4 w-4" />
          ) : (
            <ShieldX className="h-4 w-4" />
          )}
          <span className="font-medium text-foreground">{title}</span>
          <Badge variant="secondary" className="font-normal">
            {respondedLabel}
          </Badge>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            Approval needed
            <Badge variant="secondary" className="font-normal">
              {label}
            </Badge>
          </div>

          <p className="text-sm">
            The assistant wants to run <span className="font-medium">{title}</span>.
          </p>

          {preview && (
            <div className="space-y-1">
              <pre className={cn('overflow-auto rounded-md bg-muted/50 p-2 text-[12px] leading-snug', showFullInput ? 'max-h-96' : 'max-h-48')}>
                {preview}
              </pre>
              {isLongInput && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  aria-expanded={showFullInput}
                  onClick={() => setShowFullInput((open) => !open)}
                >
                  {showFullInput ? 'Show less' : `Show all (${inputText.length.toLocaleString()} characters)`}
                </button>
              )}
            </div>
          )}

          {!denying ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={!isAnswerable} onClick={() => decide({ approved: true, scope: 'once' })}>
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                Allow once
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={!isAnswerable} onClick={() => decide({ approved: true, scope: 'conversation' })}>
                Allow for this conversation
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={!isAnswerable} onClick={() => decide({ approved: true, scope: 'always' })}>
                Always allow {label}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={!isAnswerable} onClick={() => setDenying(true)} className={cn('text-destructive hover:text-destructive')}>
                <ShieldX className="mr-1.5 h-3.5 w-3.5" />
                Deny
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                ref={reasonRef}
                aria-label="Reason for denying (optional)"
                placeholder="Why not? (optional — the assistant will read this)"
                disabled={!isAnswerable}
                className="text-sm"
                rows={2}
                maxLength={500}
              />
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" disabled={!isAnswerable} onClick={() => decide({ approved: false, reason: reason.trim() || undefined })}>
                  Deny
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDenying(false)}>
                  Back
                </Button>
              </div>
            </div>
          )}

          {isAnswerable ? (
            <p className="text-xs text-muted-foreground">Sending a message instead will deny this request.</p>
          ) : (
            <p className="text-xs text-muted-foreground">Waiting for a response…</p>
          )}
        </>
      )}
    </div>
  );
};
