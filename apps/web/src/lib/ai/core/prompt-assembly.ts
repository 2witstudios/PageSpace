/**
 * Prompt assembly helpers for prefix-stable, cache-friendly AI requests.
 *
 * Two halves of one story:
 * - `buildAgentSystemPrompt` owns the STABLE system prefix — which blocks an
 *   agent is given and in what order.
 * - `buildVolatileTurnContext` owns the per-turn half, which deliberately does
 *   NOT go in the system prompt.
 *
 * Key invariants enforced here:
 * - Volatile per-turn data (timestamp, location, mention, command) lives on
 *   the last user message, NOT in the system prompt, so the system prefix
 *   stays byte-identical across turns and provider prefix caches survive.
 * - Cache breakpoints are placed at message-level via providerOptions so
 *   OpenRouter's Anthropic prefix cache can be activated per turn/step.
 * - Nothing in this module reads the clock, performs I/O, or mutates its
 *   inputs. Every block is fetched by the caller and handed in as a string.
 *   The one environment read is the code-execution kill switch, and only as a
 *   default a caller may state instead — evaluated per call, never at import.
 */

import type { ModelMessage } from 'ai';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  buildSystemPrompt,
  buildPersonalizationPrompt,
  READ_ONLY_CONSTRAINT,
  TOOL_DISCOVERY_PROMPT,
  type PersonalizationInfo,
} from './system-prompt';
import {
  ASK_USER_SECTION,
  buildInlineInstructions,
  buildGlobalAssistantInstructions,
} from './inline-instructions';

// ─── The stable system prefix ─────────────────────────────────────────────────

/** Blocks every surface takes, already fetched by the caller. '' means omitted. */
interface SharedAgentPromptInput {
  readonly readOnly: boolean;
  /**
   * Whether the sandbox instructions apply. Defaults to the global
   * kill switch, which is what every caller was passing — it is one
   * environment-wide switch, not a per-surface decision. Stated explicitly by
   * tests so they stay deterministic. Evaluated per call, never at import, so
   * no caller freezes the environment as it looked when the module loaded.
   */
  readonly codeExecutionEnabled?: boolean;
  /**
   * `null` and `undefined` both mean "none". Both callers load this from a
   * repository that returns `null`, so the coercion happens once here rather
   * than as a `?? undefined` at every call site.
   */
  readonly personalization?: PersonalizationInfo | null;
  /**
   * The tool names the model can actually reach. Gates the workspace-knowledge
   * sections, so a capability the agent's owner switched off is never described
   * to it — a named tool it does not have is an invitation to fail a turn.
   */
  readonly allowedToolNames: string[];
  /** `buildBuiltinSkillCatalog(allowedToolNames)`. */
  readonly skillCatalog: string;
  /** `buildActivePlanPrompt(...)`. */
  readonly activePlan: string;
  /** The workspace-structure block, when the agent is configured to carry one. */
  readonly pageTree: string;
}

interface PageAgentPromptInput extends SharedAgentPromptInput {
  readonly surface: 'page';
  /**
   * The agent owner's own prompt. Present ⇒ a BLANK SLATE: the default persona
   * and the workspace-knowledge block are both skipped, because an owner who
   * wrote their own prompt opted out of ours. The skill catalog and plan
   * pointer are still appended — those are capability metadata, not persona,
   * and `load_skill` ships with nothing behind it otherwise.
   */
  readonly customSystemPrompt?: string | null;
  /** Drive-owner instructions, prepended to a custom prompt only. */
  readonly drivePromptPrefix: string;
  /** Cross-drive membership context. Applies to both branches. */
  readonly memberDriveContextPrefix: string;
  /** The agent's own memory page. */
  readonly agentMemory: string;
  /** `TOOL_DISCOVERY_PROMPT` + the deferred tool catalog, as one block. */
  readonly toolDiscovery: string;
}

interface GlobalAssistantPromptInput extends SharedAgentPromptInput {
  readonly surface: 'global';
  /** The conversation's own type/context, reported back to the model. */
  readonly conversationType: string;
  readonly conversationContextId: string | null;
  /** Whether this caller's auth permits the `ask_user` tool. */
  readonly includeAskUser: boolean;
  /** Drive-owner instructions for the drive the caller is in. */
  readonly drivePromptSection: string;
  /** The agents this user can consult. */
  readonly agentAwareness: string;
  /**
   * Only the deferred tool CATALOG. This surface states
   * `TOOL_DISCOVERY_PROMPT` up front, near the exploration rules that depend on
   * it, so the catalog arrives on its own later.
   */
  readonly nonCoreToolNames: string;
}

/**
 * The two assistants the product has — not two settings of one. A page agent
 * may carry its owner's own prompt and its own memory; the Global Assistant
 * carries exploration guidance and an awareness of the agents it can consult.
 * They are kept side by side in one function so the next person to change one
 * can see the other, which is the whole reason this exists: the Global
 * Assistant previously held a bespoke copy of the workspace rules that drifted
 * until it described a page type the product does not create.
 *
 * Voice is not a third surface. A call binds to a page agent or to the Global
 * Assistant, so it asks for whichever of the two it is bound to and appends its
 * own spoken-medium override.
 */
export type AgentSystemPromptInput = PageAgentPromptInput | GlobalAssistantPromptInput;

/**
 * Guidance that belongs only to the Global Assistant, because only it is
 * reached from the dashboard with no page to anchor on and has to decide for
 * itself which drive "here" means.
 */
const globalAssistantGuidance = (
  conversationType: string,
  conversationContextId: string | null,
): string => `

You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.

SMART EXPLORATION RULES:
1. When in a drive context (see your current LOCATION context for the driveId) - ALWAYS explore it first:
   - ALWAYS use list_pages on the current drive when:
     • User asks about the drive, its contents, or what's available
     • User wants to create, write, or modify ANYTHING
     • User mentions something that MAY exist in the drive
     • User asks general questions about content or organization
     • You need to understand the workspace structure
   - Start with list_pages on the current drive BEFORE other actions
2. Context-first approach:
   - Default scope: current drive/location (see LOCATION context) is your primary workspace
   - Only explore OTHER drives when explicitly mentioned
   - When user says "here" or "this", they mean current context
   - If LOCATION context shows no drive, you're in the dashboard — use list_drives when you need to work across multiple workspaces; always check existing drives before suggesting new drive creation — never fall back to the Home drive as a guess
3. Efficient exploration pattern:
   - FIRST: list_pages on the current drive — omit driveId and it uses the drive in your LOCATION context
   - THEN: read specific pages as needed
   - ONLY IF NEEDED: explore other drives/workspaces
4. Proactive assistance:
   - Don't ask "what's in your drive" - use list_pages to discover
   - Suggest creating AI_CHAT and CHANNEL pages for organization
   - Be autonomous within current context

CONVERSATION TYPE: ${conversationType.toUpperCase()}${conversationContextId ? ` (Context: ${conversationContextId})` : ''}`;

/**
 * Assemble an agent's stable system prompt: which blocks, in which order.
 *
 * THE ORDER IS THE POINT. Every block here is already a tested builder; what
 * used to live in no single place was the sequence they go in and the branch
 * that skips half of them for an agent carrying its own prompt. That sequence
 * was written out inline in three files, and the copies drifted.
 *
 * NOTHING TURN-VOLATILE MAY BE ADDED HERE. Timestamp, location, mention and
 * command blocks ride the last user message (`buildVolatileTurnContext` below)
 * so this string stays byte-identical across turns and provider prefix caches
 * survive. A block that changes when the user walks to another page belongs
 * there, not here.
 *
 * Pure: every section is handed in already fetched.
 */
export function buildAgentSystemPrompt(input: AgentSystemPromptInput): string {
  const codeExecutionEnabled = input.codeExecutionEnabled ?? isCodeExecutionEnabled();

  if (input.surface === 'global') {
    const base = buildSystemPrompt(
      input.readOnly,
      input.personalization ?? undefined,
      codeExecutionEnabled,
      input.allowedToolNames,
    );

    // TOOL_DISCOVERY_PROMPT explains how to reach the tools that were deferred,
    // by name — so with nothing deferred it explains how to reach nothing, using
    // two tools (`tool_search`, `execute_tool`) that are not registered in that
    // case. Gated on the catalog it introduces, which is the same condition
    // `applyToolExposureMode` uses to decide whether to register them at all.
    // The text routes always defer something, so this changes nothing there.
    const toolDiscovery = input.nonCoreToolNames ? '\n\n' + TOOL_DISCOVERY_PROMPT : '';

    const persona =
      base +
      toolDiscovery +
      globalAssistantGuidance(input.conversationType, input.conversationContextId) +
      (input.includeAskUser ? `\n\n${ASK_USER_SECTION}` : '') +
      input.drivePromptSection;

    return (
      persona +
      '\n' +
      buildGlobalAssistantInstructions(input.allowedToolNames) +
      (input.agentAwareness ? '\n\n' + input.agentAwareness : '') +
      input.pageTree +
      (input.nonCoreToolNames ? '\n\n' + input.nonCoreToolNames : '') +
      input.skillCatalog +
      input.activePlan
    );
  }

  let systemPrompt: string;
  // Blank is not a prompt. An owner who cleared the field has no instructions,
  // not empty ones — and because a custom prompt suppresses the default persona
  // and the workspace knowledge, a stray space used to buy an agent a blank
  // slate it never asked for. The value itself is passed through untrimmed:
  // only the emptiness test trims, so a real prompt still arrives verbatim.
  const customSystemPrompt = input.customSystemPrompt?.trim()
    ? input.customSystemPrompt
    : undefined;
  if (customSystemPrompt) {
    systemPrompt = input.drivePromptPrefix + customSystemPrompt;

    const personalizationPrompt = buildPersonalizationPrompt(
      input.personalization ?? undefined,
    );
    if (personalizationPrompt) {
      systemPrompt += `\n\n${personalizationPrompt}`;
    }
    if (input.readOnly) {
      systemPrompt += `\n\n${READ_ONLY_CONSTRAINT}`;
    }
  } else {
    systemPrompt = buildSystemPrompt(
      input.readOnly,
      input.personalization ?? undefined,
      codeExecutionEnabled,
      input.allowedToolNames,
    );
    systemPrompt += buildInlineInstructions(input.allowedToolNames);
  }

  // Cross-drive membership applies uniformly, unlike drivePromptPrefix above.
  systemPrompt = input.memberDriveContextPrefix + systemPrompt;
  systemPrompt += input.skillCatalog;
  systemPrompt += input.activePlan;

  return systemPrompt + input.pageTree + input.agentMemory + input.toolDiscovery;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VolatileTurnContextInput {
  timestampPrompt: string;
  mentionPrompt: string;
  commandPrompt: string;
  /**
   * The per-viewer AVAILABLE COMMANDS catalog (see skill-catalog.ts). Lives
   * here — not the system prompt — because the list varies per user/drive
   * and changes whenever anyone edits a command; putting it ahead of the
   * stable prefix would churn provider prompt caches (the palette-readiness
   * memo's placement requirement).
   */
  commandCatalogPrompt?: string;
  /**
   * The user's current page/drive, rebuilt fresh every turn (see
   * location-prompt.ts). Lives here — not the stable system prompt — so a
   * turn where only the user's location changed doesn't bust the provider
   * prompt-cache prefix, and so a long tool-call loop still reflects
   * wherever the user actually was when they sent this turn's message.
   */
  locationPrompt?: string;
}

// ─── Volatile context assembly ────────────────────────────────────────────────

/**
 * Build the volatile per-turn context block from the prompt fragments.
 * Empty/whitespace-only fragments are omitted. The result is suitable for
 * appending to the last user message (not the system prompt).
 *
 * Deterministic: same inputs → byte-identical output. No clock reads.
 */
export function buildVolatileTurnContext(input: VolatileTurnContextInput): string {
  const parts: string[] = [];

  if (input.timestampPrompt.trim()) parts.push(input.timestampPrompt.trim());
  if (input.locationPrompt?.trim()) parts.push(input.locationPrompt.trim());
  if (input.mentionPrompt.trim()) parts.push(input.mentionPrompt.trim());
  if (input.commandCatalogPrompt?.trim()) parts.push(input.commandCatalogPrompt.trim());
  if (input.commandPrompt.trim()) parts.push(input.commandPrompt.trim());

  return parts.join('\n\n');
}

// ─── Last-user-message injection ──────────────────────────────────────────────

type TextPart = { type: 'text'; text: string };

/**
 * Return a NEW messages array with the volatile turn context appended as a
 * trailing text part on the last user message.
 *
 * - If `turnContext` is empty, returns the original array unchanged.
 * - Handles both string content (legacy) and parts arrays.
 * - Never mutates the input array or any of its messages.
 * - The volatile block is assembly-time only — it MUST NOT be persisted to DB.
 */
export function appendTurnContextToLastUserMessage(
  messages: ModelMessage[],
  turnContext: string,
): ModelMessage[] {
  if (!turnContext.trim()) return messages;

  // Find last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;

  const lastUser = messages[lastUserIdx];
  const suffix = '\n\n' + turnContext;

  let updatedMessage: ModelMessage;

  if (typeof (lastUser as { content?: unknown }).content === 'string') {
    // String content form
    updatedMessage = {
      ...lastUser,
      content: ((lastUser as { content: string }).content + suffix) as string,
    } as ModelMessage;
  } else {
    // Parts array form — append as a new text part
    const existingParts = Array.isArray((lastUser as { content?: unknown }).content)
      ? ((lastUser as { content: unknown[] }).content as Array<{ type: string; text?: string }>)
      : [];

    const appendedPart: TextPart = { type: 'text', text: suffix };

    updatedMessage = {
      ...lastUser,
      content: [...existingParts, appendedPart],
    } as ModelMessage;
  }

  const result = [...messages];
  result[lastUserIdx] = updatedMessage;
  return result;
}

// ─── Cache breakpoints ────────────────────────────────────────────────────────

const EPHEMERAL_CACHE = { type: 'ephemeral' as const };

/**
 * Return a NEW messages array with Anthropic/OpenRouter prompt-cache breakpoints
 * applied at two points:
 *
 * A) The last message in the array (covers system+tools+full-history on every
 *    loop step after step 1, at 0.1× read cost).
 *
 * B) The message at `stableBoundaryIndex` if ≥ 1 (survives across requests;
 *    in future PRs this becomes the summary/elision chunk boundary).
 *
 * Rules:
 * - Never places a cross-request breakpoint on a message at or after
 *   `stableBoundaryIndex` that could have different bytes than when it was
 *   originally sent (only messages older than the latest user turn are stable).
 * - providerOptions is no-op-safe for non-Anthropic models and local providers
 *   (ollama/lmstudio/azure/glm ignore the openrouter key).
 * - Does NOT mutate the input array.
 */
export function withCacheBreakpoints(
  messages: ModelMessage[],
  stableBoundaryIndex: number,
): ModelMessage[] {
  if (messages.length === 0) return messages;

  const result = [...messages];

  // A: always mark the final message
  const lastIdx = result.length - 1;
  result[lastIdx] = addCacheBreakpoint(result[lastIdx]);

  // B: stable boundary (only if it's a different index and is ≥ 1)
  if (stableBoundaryIndex >= 1 && stableBoundaryIndex < lastIdx) {
    result[stableBoundaryIndex] = addCacheBreakpoint(result[stableBoundaryIndex]);
  }

  return result;
}

function addCacheBreakpoint(message: ModelMessage): ModelMessage {
  const existing = (message as { providerOptions?: Record<string, unknown> }).providerOptions ?? {};
  return {
    ...message,
    providerOptions: {
      ...existing,
      openrouter: {
        ...((existing.openrouter as Record<string, unknown>) ?? {}),
        cacheControl: EPHEMERAL_CACHE,
      },
    },
  };
}
