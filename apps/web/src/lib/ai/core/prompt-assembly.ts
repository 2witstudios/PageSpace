/**
 * Prompt assembly helpers for prefix-stable, cache-friendly AI requests.
 *
 * Key invariants enforced here:
 * - Volatile per-turn data (timestamp, mention, command) lives on the last
 *   user message, NOT in the system prompt, so the system prefix stays
 *   byte-identical across turns and provider prefix caches survive.
 * - Cache breakpoints are placed at message-level via providerOptions so
 *   OpenRouter's Anthropic prefix cache can be activated per turn/step.
 * - Nothing in this module reads the clock or mutates its inputs.
 */

import type { ModelMessage } from 'ai';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VolatileTurnContextInput {
  timestampPrompt: string;
  mentionPrompt: string;
  commandPrompt: string;
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
 * Build the volatile per-turn context block from the three prompt fragments.
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
