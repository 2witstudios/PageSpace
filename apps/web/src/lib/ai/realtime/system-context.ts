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
import type { RealtimeTool } from './session';
import { buildVoiceInstructions } from './instructions';
import type { PersonalizationInfo } from '../core/system-prompt';
import { buildBuiltinSkillCatalog } from '../core/skill-catalog';
import {
  buildRealtimeToolExposure,
  toRealtimeTool,
  type RealtimeToolExposure,
  type ToolAllowlist,
} from './tools';

/**
 * What the session is told, and what it is given — from ONE exposure.
 *
 * They ship together because they are two projections of a single decision, and
 * the whole bug this module exists to fix was those two disagreeing: the
 * session carried `tool_search` while the prompt never named it. Computing the
 * exposure once also keeps a second full registry build off the handshake,
 * which the caller is waiting on.
 */
export type VoiceCallContext = {
  /** The system prompt for the bound surface, capped with the spoken override. */
  readonly instructions: string;
  /** The tool definitions to advertise, already on the realtime wire shape. */
  readonly tools: readonly RealtimeTool[];
};

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
 * Cap the assembled prompt with the spoken-medium override.
 *
 * Done here rather than a layer up because the override has to know what the
 * model can actually call: an agent allowed only core tools is given no
 * `tool_search`, so the rule sending it to search before refusing would name a
 * tool that is not there. This is the only place holding both halves of that —
 * the exposed set and the reachable one — so it is the only place that can
 * decide.
 */
const withVoiceOverride = (
  exposure: RealtimeToolExposure,
  agentSystemPrompt: string,
  title?: string,
): string =>
  buildVoiceInstructions({
    agentSystemPrompt,
    ...(title === undefined ? {} : { title }),
    tools: {
      exposed: Object.keys(exposure.tools),
      reachable: exposure.allowedToolNames,
    },
  });

/** The exposure's tool half, projected onto the realtime wire shape. */
const advertise = (exposure: RealtimeToolExposure): readonly RealtimeTool[] =>
  Object.entries(exposure.tools).map(([name, tool]) => toRealtimeTool(name, tool));

/**
 * Assemble everything the session is opened with.
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
 * THE EAGER AGENT LIST IS OMITTED FOR A DIFFERENT REASON: WHAT IT COSTS TO GET.
 * `buildAgentAwarenessPrompt` selects every non-trashed drive in the deployment
 * and then awaits an access check per drive and a view check per agent, one
 * after another. Everything here runs BEFORE the SDP exchange, with the caller
 * holding a dead line waiting to be heard, so that work would put a
 * whole-deployment scan on the most latency-sensitive path in the product. The
 * capability is not lost: the AGENTS guidance is still in the prompt, and
 * `list_agents` fetches the list on the one turn that actually needs it rather
 * than on every call that might.
 *
 * Read-only mode is `false`: it is a property of a typed session's toggles, and
 * a call has none. An agent whose owner restricted its tools is still restricted
 * — that rides `enabledTools` through the exposure, which is a different
 * mechanism and is applied.
 */
export const buildVoiceCallContext = async (
  deps: VoiceSystemContextDeps,
  request: VoiceSystemContextRequest,
): Promise<VoiceCallContext> => {
  const allowlist: ToolAllowlist = request.agent?.enabledTools ?? null;
  const exposure = buildRealtimeToolExposure(deps.buildTools(), allowlist);
  // The PRE-split names, not `Object.keys(exposure.tools)`. After the split that
  // object holds the core tools and the two scaffolding tools, so gating on its
  // keys would drop the task-management, delegation and automation guidance for
  // exactly the capabilities the discovery catalog goes on to advertise.
  const { allowedToolNames } = exposure;
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

    const systemPrompt = buildAgentSystemPrompt({
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

    return {
      instructions: withVoiceOverride(exposure, systemPrompt, request.agent.title),
      tools: advertise(exposure),
    };
  }

  const systemPrompt = buildAgentSystemPrompt({
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
    // Not the eager agent list the typed surface renders — see the note above.
    agentAwareness: '',
    nonCoreToolNames: exposure.nonCoreToolNames,
  });

  return { instructions: withVoiceOverride(exposure, systemPrompt), tools: advertise(exposure) };
};
