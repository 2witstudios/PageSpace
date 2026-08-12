/**
 * The system prompt a call is given — the SAME one the typed surface builds.
 *
 * A voice call binds to a conversation that is either a page agent's or the
 * Global Assistant's. Those are exactly the two surfaces `buildAgentSystemPrompt`
 * assembles, so this module gathers that assembly's inputs for whichever one
 * the call is bound to and asks for it. It does not compose a prompt of its own:
 * a third assembly is a third thing to drift, and the Global Assistant's
 * bespoke copy already drifted far enough to describe a page type the product
 * does not create.
 *
 * Split out of `binding-loader.ts` rather than added to it. That module answers
 * one question — what is this call bound to? — behind one read and one access
 * check, and the answer is small. Assembling a prompt is several independent
 * reads with different failure modes, and putting them there would have buried
 * the access decision in the middle of them.
 *
 * NO BLOCK IS WORTH A CALL. Every read here is individually best-effort: a
 * block that throws is omitted and logged, and the call still connects with
 * everything else intact. That is `binding-loader.ts`'s rule ("a binding is
 * never a reason to fail a call") applied one level down — a missing plan
 * pointer should cost the plan pointer, not the conversation.
 */

import type { ToolSet } from 'ai';
import { buildAgentSystemPrompt } from '../core/prompt-assembly';
import type { PersonalizationInfo } from '../core/system-prompt';
import { buildBuiltinSkillCatalog } from '../core/skill-catalog';
import { buildRealtimeToolExposure, type ToolAllowlist } from './tools';

/** The agent a call is bound to, when it is bound to one rather than to the Global Assistant. */
export type BoundAgent = {
  readonly pageId: string;
  readonly title: string;
  readonly systemPrompt: string | null;
  readonly enabledTools: string[] | null;
};

/** The conversation's own coordinates, which the Global Assistant reports back to the model. */
export type BoundConversation = {
  readonly type: string;
  readonly contextId: string | null;
};

export type VoiceSystemContextDeps = {
  /** The registry to expose. A parameter because building it reads the code-execution kill switch. */
  readonly buildTools: () => ToolSet;
  /** The agent's own memory page, already rendered as a prompt section. */
  readonly loadAgentMemory: (pageId: string, userId: string) => Promise<string>;
  /** The active plan pointer, already rendered. Empty string when there is none. */
  readonly loadActivePlan: (conversationId: string, userId: string) => Promise<string>;
  /** The agents this caller can consult, already rendered. */
  readonly loadAgentAwareness: (userId: string) => Promise<string>;
  /** The caller's own bio, style and rules, when they enabled them. */
  readonly loadPersonalization: (userId: string) => Promise<PersonalizationInfo | null>;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type VoiceSystemContextRequest = {
  readonly userId: string;
  readonly conversationId?: string;
  readonly agent?: BoundAgent;
  readonly conversation?: BoundConversation;
};

/**
 * Run one prompt block's read, and let it fail alone.
 *
 * The name of the block is logged rather than inferred from a stack, because
 * the symptom of a silently-dropped block is a model that has simply stopped
 * knowing something — which is invisible in a transcript and impossible to
 * bisect without knowing which read gave up.
 */
const softly = async <T>(
  deps: VoiceSystemContextDeps,
  block: string,
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    deps.logger.warn('Realtime voice prompt block could not be loaded; continuing without it', {
      block,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return whenMissing;
  }
};

/**
 * Assemble the call's system prompt.
 *
 * THREE BLOCKS THE TYPED SURFACE CARRIES ARE DELIBERATELY OMITTED, and the
 * reason is the same for all three — a realtime session's instructions are sent
 * once, at socket open, and there is no path that sends a second one:
 *
 * - the PAGE TREE, because it is the largest block by far and a call's context
 *   window is shared with the audio flowing through it for the length of the
 *   call. It is also the first thing a token budget would cut, so it is cut.
 * - the DRIVE prompt and the CROSS-DRIVE MEMBER context, because both are keyed
 *   to the drive the caller is standing in, and on a call they can walk to
 *   another one without the session rebinding. A drive's instructions frozen at
 *   the moment the call connected would go quietly wrong the first time that
 *   happened; the tools read the live location instead.
 *
 * Read-only mode is `false`: it is a property of a typed session's toggles, and
 * a call has none. An agent whose owner restricted its tools is still restricted
 * — that rides `enabledTools` through the exposure, which is a different
 * mechanism and is applied.
 */
export const buildVoiceSystemContext = async (
  deps: VoiceSystemContextDeps,
  request: VoiceSystemContextRequest,
): Promise<string> => {
  const allowlist: ToolAllowlist = request.agent?.enabledTools ?? null;
  const exposure = buildRealtimeToolExposure(deps.buildTools(), allowlist);
  const allowedToolNames = Object.keys(exposure.tools);
  const skillCatalog = buildBuiltinSkillCatalog(allowedToolNames);

  const [activePlan, personalization] = await Promise.all([
    request.conversationId
      ? softly(
          deps,
          'activePlan',
          () => deps.loadActivePlan(request.conversationId as string, request.userId),
          '',
        )
      : Promise.resolve(''),
    softly(deps, 'personalization', () => deps.loadPersonalization(request.userId), null),
  ]);

  if (request.agent) {
    const agentMemory = await softly(
      deps,
      'agentMemory',
      () => deps.loadAgentMemory((request.agent as BoundAgent).pageId, request.userId),
      '',
    );

    return buildAgentSystemPrompt({
      surface: 'page',
      readOnly: false,
      personalization,
      allowedToolNames,
      skillCatalog,
      activePlan,
      pageTree: '',
      customSystemPrompt: request.agent.systemPrompt,
      drivePromptPrefix: '',
      memberDriveContextPrefix: '',
      agentMemory,
      toolDiscovery: exposure.toolDiscoveryPrompt,
    });
  }

  const agentAwareness = await softly(
    deps,
    'agentAwareness',
    () => deps.loadAgentAwareness(request.userId),
    '',
  );

  return buildAgentSystemPrompt({
    surface: 'global',
    readOnly: false,
    personalization,
    allowedToolNames,
    skillCatalog,
    activePlan,
    pageTree: '',
    // An unbound call has no conversation row yet — the same state a brand-new
    // typed thread is in before its first message lands.
    conversationType: request.conversation?.type ?? 'global',
    conversationContextId: request.conversation?.contextId ?? null,
    // `ask_user` draws a card on a screen. The override block tells the model to
    // ask out loud instead, so describing the tool here would only argue with it.
    includeAskUser: false,
    drivePromptSection: '',
    agentAwareness,
    nonCoreToolNames: exposure.nonCoreToolNames,
  });
};
