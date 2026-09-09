/**
 * The return hop's handler: what the web tier does when the realtime server
 * asks it to run a tool or persist a spoken turn.
 *
 * Separated from the route so the whole dispatch tree is testable without a
 * request, a signature or a server — the shape `attach-handler.ts` established
 * on the other side of the same seam, deliberately mirrored so the two ends of
 * one boundary read the same way.
 *
 * The HMAC check does NOT live here. It runs in the route, over the RAW body,
 * before anything is parsed — a caller that cannot sign is not a caller whose
 * JSON we should be reading.
 */

import {
  voiceBridgeRequestSchema,
  type VoiceAssistant,
  type VoiceBridgeResponse,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { dispatchRealtimeToolCall, type RealtimeToolDispatchDeps } from './tool-dispatch';
import {
  persistVoiceTranscript,
  type TranscriptPersistenceDeps,
} from './transcript-persistence';
import { persistVoiceToolActivity } from './tool-activity-persistence';

export type VoiceBridgeDeps = {
  /**
   * The executable tool set, built under the bound agent's allowlist.
   *
   * Takes the allowlist rather than closing over one because this handler is
   * shared by every live call in the process, and each call is bound to a
   * different assistant.
   */
  /**
   * The executable tool set for this hop. Takes the whole ASSISTANT, not just
   * its allowlist: the per-agent sandbox switch is part of the same decision and
   * is read server-side from the agent's own row (issue #2460), so it may be
   * async. Undefined for an unbound (Global Assistant) call.
   */
  readonly toolDeps: (
    assistant: VoiceAssistant | undefined,
  ) => RealtimeToolDispatchDeps | Promise<RealtimeToolDispatchDeps>;
  readonly transcriptDeps: TranscriptPersistenceDeps;
  /** Resolved from env at the edge, for tool-call attribution. */
  readonly model: string;
};

export type VoiceBridgeHandlerResponse = {
  readonly status: number;
  readonly body: VoiceBridgeResponse;
};

/**
 * Validate, then do the one thing the payload asked for.
 *
 * A TOOL dispatch never answers non-200 for a tool-level failure. The realtime
 * server's next move is `function_call_output`, and the model is blocked until
 * it arrives — so "the tool refused" and "the tool threw" both come back as a
 * successful response whose `output` is a sentence the model can say. Only a
 * malformed payload (a bug on our own wire) is a 400.
 */
export const handleVoiceBridgeRequest = async (
  deps: VoiceBridgeDeps,
  rawBody: string,
): Promise<VoiceBridgeHandlerResponse> => {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: 'Invalid JSON' } };
  }

  const parsed = voiceBridgeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid voice bridge payload',
      },
    };
  }

  const request = parsed.data;

  if (request.kind === 'tool') {
    // Both halves of the allowlist in one place: the set the dispatcher may
    // resolve a name in, and the `enabledTools` that `execute_tool` re-checks
    // off the execution context. An agent with no allowlist configured is
    // `null` — unrestricted — and the Global Assistant has no agent at all.
    const outcome = await dispatchRealtimeToolCall(
      await deps.toolDeps(request.assistant),
      {
        name: request.name,
        argumentsJson: request.argumentsJson,
        userId: request.userId,
        callId: request.callId,
        ...(request.conversationId === undefined
          ? {}
          : { conversationId: request.conversationId }),
        ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
        ...(request.locationContext === undefined
          ? {}
          : { locationContext: request.locationContext }),
        ...(request.assistant === undefined ? {} : { assistant: request.assistant }),
      },
      deps.model,
    );
    return {
      status: 200,
      body: { ok: true, kind: 'tool', output: outcome.output, failed: outcome.failed },
    };
  }

  if (request.kind === 'tool_started' || request.kind === 'tool_finished') {
    // A record, not a dispatch: nothing is waiting on it, and it answers with
    // the row's id so the second phase can update that same row.
    const activity = await persistVoiceToolActivity(deps.transcriptDeps, {
      callId: request.callId,
      userId: request.userId,
      conversationId: request.conversationId,
      toolCallId: request.toolCallId,
      name: request.name,
      argumentsJson: request.argumentsJson,
      ...(request.kind === 'tool_finished'
        ? {
            messageId: request.messageId,
            output: request.output,
            ...(request.errorText === undefined ? {} : { errorText: request.errorText }),
          }
        : {}),
    });

    return {
      status: 200,
      body: {
        ok: true,
        kind: 'tool_activity',
        saved: activity.saved,
        messageId: activity.messageId,
        rev: activity.rev,
      },
    };
  }

  if (request.kind !== 'transcript') {
    // Exhaustiveness, and it is load-bearing. This used to fall through to the
    // transcript write, so a kind added to the schema would have been silently
    // persisted as a spoken turn — a wrong row, written confidently, with no
    // error anywhere.
    const unreachable: never = request;
    throw new Error(`Unhandled voice bridge request kind: ${JSON.stringify(unreachable)}`);
  }

  const result = await persistVoiceTranscript(deps.transcriptDeps, {
    callId: request.callId,
    userId: request.userId,
    conversationId: request.conversationId,
    role: request.role,
    text: request.text,
  });

  // A refused or skipped transcript is still a 200: it is an outcome, not a
  // transport failure, and the realtime server's only sane response either way
  // is to log it and keep the call up. `saved: false` says what happened.
  return {
    status: 200,
    body: {
      ok: true,
      kind: 'transcript',
      saved: result.saved,
      messageId: result.messageId,
      rev: result.rev,
    },
  };
};
