import {
  estimateMessageTokens,
  getContextWindowSize,
} from '../monitoring/ai-context-calculator';

export interface CompactionMessagePart {
  type: string;
  text?: string;
  mediaType?: string;
  filename?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  output?: unknown; // SDK UIMessage dialect (type: 'tool-{name}')
}

export interface CompactionMessage {
  id?: string;
  role: 'user' | 'assistant';
  parts?: CompactionMessagePart[];
  createdAt?: Date;
}

export interface CompactionState {
  summaryVersion: number;
  compactedUpToMessageId: string | null;
  compactedUpToCreatedAt: Date | null;
  summary: string;
  summaryTokens: number;
  lastCompactedAt: Date | null;
  summarizerModel: string | null;
}

export interface CompactionConfig {
  triggerRatio?: number;
  hardRatio?: number;
  targetRatio?: number;
  minTailMessages?: number;
  minSecondsBetweenCompactions?: number;
  maxSummaryTokens?: number;
}

export type CompactionPlanReason = 'over-soft-threshold' | 'summary-over-cap';

export interface CompactionPlan {
  reason: CompactionPlanReason;
  cutBeforeIndex: number;
  estimatedTailTokens: number;
  messagesToSummarize: CompactionMessage[];
  compactedUpToMessageId: string | null;
  compactedUpToCreatedAt: Date | null;
  currentSummaryVersion: number | null;
  previousSummary: string | null;
}

export interface BuildModelContextResult {
  tailMessages: CompactionMessage[];
  summaryMessage: CompactionMessage | null;
  estimatedTotalTokens: number;
  usageRatio: number;
  needsCompaction: boolean;
  emergencyTruncated: boolean;
  compactionPlan: CompactionPlan | null;
}

export interface BuildModelContextParams {
  messages: CompactionMessage[];
  compaction: CompactionState | null;
  model: string;
  provider?: string;
  systemPromptTokens: number;
  toolTokens: number;
  config?: CompactionConfig;
}

const DEFAULT_CONFIG: Required<CompactionConfig> = {
  triggerRatio: 0.75,
  hardRatio: 0.95,
  targetRatio: 0.40,
  minTailMessages: 6,
  minSecondsBetweenCompactions: 60,
  maxSummaryTokens: 4000,
};

// --- exported internals for tests ---

export function applyPointerCut(
  messages: CompactionMessage[],
  compaction: Pick<CompactionState, 'compactedUpToMessageId' | 'compactedUpToCreatedAt'> | null
): number {
  if (!compaction) return 0;
  if (!compaction.compactedUpToMessageId && !compaction.compactedUpToCreatedAt) return 0;

  // Id match
  if (compaction.compactedUpToMessageId) {
    const idx = messages.findIndex((m) => m.id === compaction.compactedUpToMessageId);
    if (idx !== -1) return idx + 1;
  }

  // createdAt fallback
  if (compaction.compactedUpToCreatedAt) {
    const cutAt = compaction.compactedUpToCreatedAt;
    let idx = messages.findIndex((m) => m.createdAt && m.createdAt > cutAt);
    if (idx === -1) return messages.length; // summary covers everything
    // Walk forward to the next user turn
    while (idx < messages.length && messages[idx].role !== 'user') {
      idx++;
    }
    return idx;
  }

  return 0;
}

export function findUserTurnCut(
  tail: CompactionMessage[],
  options: {
    contextWindow: number;
    systemPromptTokens: number;
    toolTokens: number;
    summaryTokens: number;
    targetRatio: number;
  }
): number {
  const { contextWindow, systemPromptTokens, toolTokens, summaryTokens, targetRatio } = options;
  const targetTokens = Math.floor(contextWindow * targetRatio);
  const overhead = systemPromptTokens + toolTokens + summaryTokens;
  const messagesBudget = Math.max(0, targetTokens - overhead);

  // Walk backward from the end; accumulate until we exceed the budget
  let accumulatedTokens = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(tail[i] as Parameters<typeof estimateMessageTokens>[0]);
    if (accumulatedTokens + msgTokens > messagesBudget) {
      // Would exceed budget; cut here (keep tail[i+1..])
      // Walk forward from i+1 to find the next user-turn boundary
      let cutIdx = i + 1;
      while (cutIdx < tail.length && tail[cutIdx].role !== 'user') {
        cutIdx++;
      }
      return cutIdx;
    }
    accumulatedTokens += msgTokens;
  }

  // All messages fit within budget
  return 0;
}

export function validateTailIntegrity(messages: CompactionMessage[]): boolean {
  if (messages.length === 0) return true;
  if (messages[0].role !== 'user') return false;

  for (const msg of messages) {
    const parts = msg.parts ?? [];
    const toolCallIds = new Set(
      parts.filter((p) => p.type === 'tool-call').map((p) => p.toolCallId)
    );
    for (const part of parts) {
      if (part.type === 'tool-result' && !toolCallIds.has(part.toolCallId)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Detect the synthetic summary message produced by formatSummaryMessage.
 * The sentinel is: no DB id AND the first text part starts with the
 * <conversation_summary> wrapper. Every consumer that needs to split summary
 * from tail (context-assembly seam, v1 completions route) must use this helper
 * so the sentinel format lives in exactly one place.
 */
export function isSyntheticSummaryMessage(msg: CompactionMessage): boolean {
  const text = msg.parts?.find((p) => p.type === 'text')?.text ?? '';
  return !msg.id && text.startsWith('<conversation_summary>');
}

export function formatSummaryMessage(summary: string): CompactionMessage {
  const text = [
    '<conversation_summary>',
    summary,
    '</conversation_summary>',
    '',
    'Earlier conversation history has been condensed above. Full history is retrievable via read_conversation or regex_search.',
  ].join('\n');
  return { role: 'user', parts: [{ type: 'text', text }] };
}

export function stripNonTextForSummarizer(messages: CompactionMessage[]): CompactionMessage[] {
  return messages.map((msg) => {
    if (!msg.parts) return msg;
    const parts: CompactionMessagePart[] = msg.parts.map((part) => {
      if (part.type === 'file') {
        const label = part.filename ?? 'unknown';
        const mime = part.mediaType ?? 'unknown';
        return { type: 'text', text: `[attachment: ${label} (${mime})]` };
      }
      return part;
    });
    return { ...msg, parts };
  });
}

function estimateTailTokens(tail: CompactionMessage[]): number {
  return tail.reduce(
    (sum, m) => sum + estimateMessageTokens(m as Parameters<typeof estimateMessageTokens>[0]),
    0
  );
}

const TOOL_RESULT_MAX_CHARS = 8000;

/**
 * Truncate oversized tool-result parts within each message in place.
 *
 * Hard truncation can only drop whole messages; this handles the case where the
 * minTailMessages floor prevents any cut (e.g. 6 messages with 40k-token tool
 * results each). Applied after hard truncation so it's a last-resort safety net.
 */
function isToolOutputPartForCap(part: CompactionMessagePart): boolean {
  if (part.type === 'tool-result') return true;
  // SDK UIMessage dialect: type is 'tool-{name}' with an output field
  if (
    part.type !== 'text' &&
    part.type !== 'file' &&
    part.type !== 'step-start' &&
    part.type.startsWith('tool-') &&
    'output' in part
  ) {
    return true;
  }
  return false;
}

export function capToolResultSize(
  messages: CompactionMessage[],
  maxChars = TOOL_RESULT_MAX_CHARS,
): CompactionMessage[] {
  return messages.map((msg) => {
    if (!msg.parts) return msg;
    let didCap = false;
    const parts = msg.parts.map((part) => {
      if (!isToolOutputPartForCap(part)) return part;
      // Canonical format uses `result`; SDK UIMessage format uses `output`
      // Canonical format: `result` field; SDK UIMessage format: `output` field
      const value = 'result' in part ? part.result : part.output;
      if (typeof value !== 'string' || value.length <= maxChars) return part;
      didCap = true;
      const truncated = value.slice(0, maxChars);
      const capped = `${truncated}\n[truncated: output exceeded ${maxChars} chars]`;
      return 'result' in part ? { ...part, result: capped } : { ...part, output: capped };
    });
    return didCap ? { ...msg, parts } : msg;
  });
}

export function buildModelContext(params: BuildModelContextParams): BuildModelContextResult {
  const {
    messages,
    compaction,
    model,
    provider,
    systemPromptTokens,
    toolTokens,
    config: rawConfig,
  } = params;

  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  const contextWindow = getContextWindowSize(model, provider);

  let tailStart = applyPointerCut(messages, compaction);
  let tail = messages.slice(tailStart);
  // Defensive integrity gate: applyPointerCut lands on user turns for well-formed
  // histories, but edited/imported histories can leave the remainder starting
  // mid-turn. When validation fails because of the start role, advance the cut to
  // the next user turn. The other failure mode (orphaned tool-results inside a
  // message) is repaired upstream by sanitizeMessagesForModel, not by moving the cut.
  if (tail.length > 0 && !validateTailIntegrity(tail) && tail[0].role !== 'user') {
    let next = tailStart + 1;
    while (next < messages.length && messages[next].role !== 'user') next++;
    if (next < messages.length) {
      tailStart = next;
      tail = messages.slice(tailStart);
    }
  }

  const summaryMessage = compaction?.summary ? formatSummaryMessage(compaction.summary) : null;
  // Use the token count of the *formatted* summary (includes wrapper text overhead)
  // rather than the stored raw-summary token count to get accurate budget calculations.
  const summaryTokens = summaryMessage
    ? estimateMessageTokens(summaryMessage as Parameters<typeof estimateMessageTokens>[0])
    : 0;

  const tailTokens = estimateTailTokens(tail);
  const totalTokens = systemPromptTokens + toolTokens + summaryTokens + tailTokens;
  const usageRatio = totalTokens / contextWindow;
  const needsCompaction = usageRatio >= config.triggerRatio;

  let tailMessages = tail;
  let emergencyTruncated = false;
  let compactionPlan: CompactionPlan | null = null;

  // Summary over cap takes priority
  if (compaction && compaction.summaryTokens > config.maxSummaryTokens) {
    compactionPlan = {
      reason: 'summary-over-cap',
      cutBeforeIndex: tailStart,
      estimatedTailTokens: tailTokens,
      messagesToSummarize: [],
      compactedUpToMessageId: compaction.compactedUpToMessageId,
      compactedUpToCreatedAt: compaction.compactedUpToCreatedAt,
      currentSummaryVersion: compaction.summaryVersion,
      previousSummary: compaction.summary,
    };
  }

  const cutOptions = {
    contextWindow,
    systemPromptTokens,
    toolTokens,
    summaryTokens,
    targetRatio: config.targetRatio,
  };

  const hasEnoughTail = tail.length > config.minTailMessages;

  // Soft threshold: emit plan, context unchanged
  if (!compactionPlan && usageRatio >= config.triggerRatio && hasEnoughTail) {
    const cutIdx = findUserTurnCut(tail, cutOptions);
    const preCut = tail.slice(0, cutIdx);
    // Need ≥1 full user turn pre-cut (user + assistant pair)
    const hasFullUserTurnPreCut = preCut.length >= 2 && preCut[0].role === 'user';

    if (hasFullUserTurnPreCut && cutIdx > 0 && cutIdx < tail.length) {
      const messagesToSummarize = preCut;
      const lastMsg = messagesToSummarize[messagesToSummarize.length - 1];
      compactionPlan = {
        reason: 'over-soft-threshold',
        cutBeforeIndex: tailStart + cutIdx,
        estimatedTailTokens: estimateTailTokens(tail.slice(cutIdx)),
        messagesToSummarize,
        compactedUpToMessageId: lastMsg?.id ?? null,
        compactedUpToCreatedAt: lastMsg?.createdAt ?? null,
        currentSummaryVersion: compaction?.summaryVersion ?? null,
        previousSummary: compaction?.summary ?? null,
      };
    }
  }

  // Hard threshold: inline truncation
  if (usageRatio >= config.hardRatio && hasEnoughTail) {
    let cutIdx = findUserTurnCut(tail, cutOptions);
    let newTail = cutIdx > 0 ? tail.slice(cutIdx) : tail;

    // If target ratio is too aggressive and leaves fewer than minTailMessages,
    // fall back to keeping the last minTailMessages (scanning backward to a user turn)
    if (newTail.length < config.minTailMessages) {
      const keepCount = Math.min(config.minTailMessages, tail.length);
      let fallbackStart = tail.length - keepCount;
      // Walk forward to find a user turn
      while (fallbackStart < tail.length && tail[fallbackStart].role !== 'user') {
        fallbackStart++;
      }
      if (fallbackStart < tail.length && fallbackStart > 0) {
        cutIdx = fallbackStart;
        newTail = tail.slice(cutIdx);
      }
    }

    // Guard: kept tail must have at least minTailMessages and cut must be non-trivial
    if (cutIdx > 0 && newTail.length >= config.minTailMessages) {
      tailMessages = newTail;
      emergencyTruncated = true;

      // Update plan for the emergency cut if not already summary-over-cap
      if (!compactionPlan || compactionPlan.reason !== 'summary-over-cap') {
        const messagesToSummarize = tail.slice(0, cutIdx);
        const lastMsg = messagesToSummarize[messagesToSummarize.length - 1];
        compactionPlan = {
          reason: 'over-soft-threshold',
          cutBeforeIndex: tailStart + cutIdx,
          estimatedTailTokens: estimateTailTokens(newTail),
          messagesToSummarize,
          compactedUpToMessageId: lastMsg?.id ?? null,
          compactedUpToCreatedAt: lastMsg?.createdAt ?? null,
          currentSummaryVersion: compaction?.summaryVersion ?? null,
          previousSummary: compaction?.summary ?? null,
        };
      }
    }
  }

  // Safety net: cap oversized tool-result strings within each message.
  // Hard truncation can only drop whole messages; when minTailMessages prevents
  // any cut (e.g. 6 messages each containing 40k-token read_page results) this
  // trims within the remaining messages so the model never sees a 400-error context.
  tailMessages = capToolResultSize(tailMessages);

  const finalTailTokens = estimateTailTokens(tailMessages);
  const finalTotal = systemPromptTokens + toolTokens + summaryTokens + finalTailTokens;

  return {
    tailMessages,
    summaryMessage,
    estimatedTotalTokens: finalTotal,
    usageRatio: finalTotal / contextWindow,
    needsCompaction,
    emergencyTruncated,
    compactionPlan,
  };
}
