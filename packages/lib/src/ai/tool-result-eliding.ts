/**
 * Cross-request tool-result eliding.
 *
 * Replaces stale tool OUTPUT content with a short stub while preserving tool
 * INPUT (args) so the pair structure survives convertToModelMessages and the
 * agent can re-fetch on demand. Write-tool results are never elided.
 *
 * Elision is chunk-aligned: the boundary advances at most once per chunkSize
 * assistant turns, so replayed message bytes are stable within a chunk window
 * and prefix caches survive between requests.
 *
 * No `ai`-package dependency — structural message types only.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

// SDK-dialect fields (input/output) are intentionally preserved here.
// Eliding operates on the same SDK-dialect UIMessage array that flows to
// convertToModelMessages — normalization (normalize-parts.ts) is applied only
// in the summarization pipeline (compaction-service.ts). Removing these fields
// would break elision of the real persisted message format.
export interface ElisionMessagePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  input?: unknown; // SDK: tool args (UIMessage format)
  result?: unknown; // canonical: tool result (CompactionMessage format)
  output?: unknown; // SDK: tool output (UIMessage format)
  [key: string]: unknown;
}

export interface ElisionMessage {
  id?: string;
  role: 'user' | 'assistant';
  parts?: ElisionMessagePart[];
  createdAt?: Date;
}

export interface BoundaryOptions {
  /** How many recent assistant turns to always keep un-elided. Default: 4. */
  keepLastTurns: number;
  /** Advance the boundary at most once per this many assistant turns. Default: 8. */
  chunkSize: number;
  /**
   * When present, directly overrides the computed chunk boundary.
   * Typically the compaction pointer from PR 2 so elision and cache
   * breakpoints coincide.
   */
  compactionPointer?: number;
}

export interface ElisionOptions {
  /**
   * Assistant-turn index (0-based within the message array) below which
   * tool outputs are candidates for elision. 0 means nothing is elided.
   * Derived from computeElisionBoundary before calling this function.
   */
  elisionBoundaryTurnIndex: number;
  /** Minimum output character length to consider for elision. Default: 1000. */
  minOutputChars: number;
  /** Set of tool names whose outputs may be elided (refetchable read tools). */
  elidableTools: Set<string>;
  /** Set of tool names that write content — their results are never elided. */
  writeTools: Set<string>;
  /**
   * Tool names whose MOST RECENT call per distinct serialized input is never
   * elided, regardless of the boundary. Built for load_skill: the newest
   * load of each skill is its active instructions and must survive
   * (agentskills.io: protect active skill content from pruning); older loads
   * of the same skill decay to stubs like any stale read.
   *
   * Byte-stability caveat: a protected old call flips to elidable only when
   * a NEWER call with the same input appears later in the transcript — a
   * rare, forward-only byte change in replayed history, the same class as a
   * chunk-boundary advance.
   */
  protectMostRecentByArgs?: ReadonlySet<string>;
}

// ─── Elidable tool list (canonical; apps/web passes this set) ─────────────────

/**
 * Default set of refetchable read tools whose outputs can safely be elided.
 * Callers in apps/web supply this list; packages/lib carries no platform deps.
 */
export const DEFAULT_ELIDABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_page',
  'read_conversation',
  'list_pages',
  'list_drives',
  'regex_search',
  'glob_search',
  'multi_drive_search',
  'get_activity',
  'web_search',
  'list_calendar_events',
  // Skill bodies are deterministic re-fetchable reads — the stub's "call
  // load_skill again with the same arguments" promise is exactly true. The
  // most recent load per skill is protected via protectMostRecentByArgs
  // (see ElisionOptions): the Agent Skills standard requires ACTIVE skill
  // instructions to survive pruning; only superseded loads decay.
  'load_skill',
  // execute_tool intentionally excluded: in search-exposure mode it can dispatch write
  // operations (task/calendar/trash mutations) whose results must not be re-played.
]);

// ─── Boundary computation ──────────────────────────────────────────────────────

/**
 * Compute the 0-based assistant-turn boundary below which stale outputs should
 * be elided.
 *
 * When `compactionPointer` is provided it is used directly (overrides chunk
 * math) so elision boundaries coincide with the compaction summary boundary
 * that feeds PR 1's cache breakpoint B.
 *
 * Otherwise the boundary is chunk-aligned: it equals
 *   floor(elideCount / chunkSize) * chunkSize
 * where elideCount = max(0, assistantTurnCount - keepLastTurns).
 * This ensures replayed bytes are byte-identical within a chunk window.
 *
 * Returns 0 (no elision) when there are not enough turns.
 */
export function computeElisionBoundary(
  assistantTurnCount: number,
  opts: BoundaryOptions,
): number {
  const { keepLastTurns, chunkSize, compactionPointer } = opts;

  if (compactionPointer !== undefined) {
    return Math.max(0, compactionPointer);
  }

  // Chunk floor: the largest multiple of chunkSize that is ≤ assistantTurnCount.
  // Subtract keepLastTurns to get the boundary (how many assistant turns to elide).
  // This advances only once per chunkSize turns so replayed prefix bytes are
  // stable within each chunk window — identical bytes == cache-friendly.
  const chunkFloor = Math.floor(assistantTurnCount / chunkSize) * chunkSize;
  return Math.max(0, chunkFloor - keepLastTurns);
}

// ─── Elision ──────────────────────────────────────────────────────────────────

function buildStub(toolName: string): string {
  return `[output elided to save context — call ${toolName} again with the same arguments, or search past conversation with regex_search]`;
}

function getOutputValue(part: ElisionMessagePart): unknown {
  // Dual-format: canonical CompactionMessage uses `result`; SDK UIMessage uses `output`.
  // Both paths are live — eliding operates on SDK-dialect messages (normalize-parts.ts
  // is applied only in the summarization pipeline, not here).
  return 'result' in part ? part.result : part.output;
}

function outputCharLength(part: ElisionMessagePart): number {
  const val = getOutputValue(part);
  if (typeof val === 'string') return val.length;
  if (val === undefined || val === null) return 0;
  return JSON.stringify(val).length;
}

/**
 * Return true for parts that carry tool output, in either format:
 * - `type: 'tool-result'` (canonical CompactionMessage format)
 * - `type: 'tool-{name}'` with an output field (SDK UIMessage format)
 *
 * Both arms are intentionally kept: eliding runs on SDK-dialect messages
 * (normalize-parts.ts is applied only in the summarization pipeline, not here).
 * Text, file, and step-start parts are excluded.
 */
function isToolOutputPart(part: ElisionMessagePart): boolean {
  if (part.type === 'tool-result') return true;
  // SDK dialect: type is 'tool-{name}' with output field set
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

/**
 * Return a new messages array with stale tool outputs replaced by a stub.
 *
 * Dual-format: handles both canonical `type: 'tool-result'`/`result` field
 * (CompactionMessage) and SDK-dialect `type: 'tool-{name}'`/`output` field
 * (UIMessage). Both paths are live — eliding runs on SDK-dialect messages
 * so that convertToModelMessages receives them intact (see normalize-parts.ts
 * for why normalization is confined to the summarization pipeline).
 *
 * Tool inputs/args are never touched so the call/result pair structure
 * survives `convertToModelMessages`. Write-tool results are never elided.
 * Outputs below `minOutputChars` are never elided. Pure: never mutates.
 */
/** The tool name a part refers to, in either message dialect. */
function partToolName(part: ElisionMessagePart): string {
  return part.toolName ?? part.type.replace(/^tool-/, '');
}

/**
 * For each protected tool, locate the LAST call per distinct serialized
 * input across the whole transcript. Returns identity keys
 * (`messageIndex:partIndex`) of the parts that must not be elided.
 */
function computeProtectedParts(
  messages: ElisionMessage[],
  protectedTools: ReadonlySet<string>,
): Set<string> {
  if (protectedTools.size === 0) return new Set();

  // toolName + serialized input → identity of the latest matching part.
  const latestByInput = new Map<string, string>();
  messages.forEach((msg, msgIdx) => {
    if (msg.role !== 'assistant' || !msg.parts) return;
    msg.parts.forEach((part, partIdx) => {
      if (!isToolOutputPart(part)) return;
      const toolName = partToolName(part);
      if (!protectedTools.has(toolName)) return;
      const input = part.input ?? part.args;
      latestByInput.set(`${toolName}:${JSON.stringify(input) ?? ''}`, `${msgIdx}:${partIdx}`);
    });
  });

  return new Set(latestByInput.values());
}

export function elideStaleToolOutputs(
  messages: ElisionMessage[],
  opts: ElisionOptions,
): ElisionMessage[] {
  const { elisionBoundaryTurnIndex, minOutputChars, elidableTools, writeTools } = opts;

  if (elisionBoundaryTurnIndex <= 0) return messages;

  const protectedParts = computeProtectedParts(
    messages,
    opts.protectMostRecentByArgs ?? new Set(),
  );

  let assistantTurnsSeen = 0;

  return messages.map((msg, msgIdx): ElisionMessage => {
    if (msg.role !== 'assistant') return msg;

    const thisTurnIndex = assistantTurnsSeen;
    assistantTurnsSeen++;

    // Keep turns at or above the boundary
    if (thisTurnIndex >= elisionBoundaryTurnIndex) return msg;

    if (!msg.parts || msg.parts.length === 0) return msg;

    let didElide = false;
    const newParts = msg.parts.map((part, partIdx): ElisionMessagePart => {
      if (!isToolOutputPart(part)) return part;

      // UIMessage parts carry the tool name in `type` as 'tool-{name}' when toolName is absent
      const toolName = partToolName(part);

      // Never elide write-tool results
      if (writeTools.has(toolName)) return part;

      // Only elide tools in the elidable set
      if (!elidableTools.has(toolName)) return part;

      // The newest call per input of a protected tool is active content
      if (protectedParts.has(`${msgIdx}:${partIdx}`)) return part;

      // Size guard
      if (outputCharLength(part) < minOutputChars) return part;

      const stub = buildStub(toolName);
      didElide = true;
      // Replace whichever field carried the output
      if ('result' in part) {
        return { ...part, result: stub };
      }
      return { ...part, output: stub };
    });

    if (!didElide) return msg;
    return { ...msg, parts: newParts };
  });
}
