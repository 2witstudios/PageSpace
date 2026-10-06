/**
 * THE ASSISTANT SURFACE — what the Global Assistant's turn is given, as ONE
 * piece of code both of its hosts run.
 *
 * Imago replaces the Global Assistant one for one (owner decision 2026-10-06,
 * IMG-10.10). Imago is an AI_CHAT page and runs on `runPageChatTurn`, while the
 * Global Assistant runs on `runGlobalChatTurn` — so "Imago gets what the
 * Global Assistant gets" holds only if neither turn assembles that surface
 * itself. Both call this module instead:
 *
 *  - `selectAssistantTools`: the full `pageSpaceTools` registry through the
 *    Global Assistant's filters (sandbox tier, agent-account tools, read-only,
 *    the web_search toggle, the admin image-generation gate), split into the
 *    core tools sent up front and the rest behind `tool_search` /
 *    `execute_tool`, with the user's command catalog joined to the search
 *    corpus.
 *  - `buildAssistantContext`: the stable and turn-volatile context — the
 *    current location with the Home-drive hint, the drive prompt, the drive
 *    tree (or the all-drives summary), personalization and timezone, and the
 *    agents the user can consult.
 *
 * Integrations come from the one shared resolver
 * (`resolveAssistantIntegrationTools`); desktop MCP tools, `finish` and
 * `ask_user` are merged by each turn on the same rules.
 *
 * The one input Imago adds is `excludedDriveIds` — the drives its user keeps it
 * out of. For the Global Assistant it is empty and the output is what that
 * turn assembled before this module existed.
 */
import type { ToolSet } from 'ai';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import {
  filterToolsForAgentAccounts,
  filterToolsForImageGen,
  filterToolsForMcpScope,
  filterToolsForReadOnly,
  filterToolsForSandboxTier,
  filterToolsForWebSearch,
} from '@/lib/ai/core/tool-filtering';
import { shouldExposeImageGen } from '@/lib/ai/core/image-gen-access';
import { splitToolsForExposure, excludeAlwaysUpfront, ALWAYS_UPFRONT_TOOLS } from '@/lib/ai/tools/tool-exposure';
import { createExecuteTool } from '@/lib/ai/tools/execute-tool';
import { createToolSearchTool } from '@/lib/ai/tools/tool-search-tool';
import { listEligibleSkills } from '@/lib/ai/core/skill-catalog';
import { loadUserCommandCatalog, type UserCommandCatalog } from '@/lib/commands/command-catalog-loader';
import { buildLocationTurnPrompt, type LocationAgentAccess } from '@/lib/ai/core/location-prompt';
import { resolveHomeDriveHint } from '@/lib/ai/core/home-drive-hint';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import { buildAgentAwarenessPrompt } from '@/lib/ai/core/agent-awareness';
import { getPageTreeContext, getDriveListSummary } from '@/lib/ai/core/page-tree-context';
import { getUserPersonalization, getUserTimezone } from '@/lib/ai/core/personalization-utils';
import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { TurnTimer } from '@/lib/ai/core/turn-timing';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

export interface AssistantToolSelectionInput {
  userId: string;
  readOnly: boolean;
  webSearch: boolean;
  imageGen: boolean;
  isAdmin: boolean;
  /** The payer's sandbox eligibility for this conversation (`resolveSandboxToolEligibilityForConversation`). */
  sandboxTierEligible: boolean;
  /**
   * Whether the caller is confined to a drive set (`isDriveScopedPrincipal` —
   * a drive-scoped MCP token, or a dispatched worker carrying its ceiling).
   * Account-level-only tools (create_drive) are stripped BEFORE the split, so
   * every advertised surface — the core tools, tool_search's corpus,
   * execute_tool's dispatch map and the non-core catalog — agrees with the
   * listing invariant the non-Imago page branch upholds with the same filter.
   */
  driveScoped: boolean;
  /** The drive whose commands join the catalog: the drive in view, or null. */
  commandDriveId: string | null;
  timer?: TurnTimer;
}

export interface AssistantToolSelection {
  /**
   * Every allowed tool by name — the `execute_tool` dispatch map and
   * `tool_search` catalog, and the set integration suppression must read (the
   * final set never carries non-core tool names as top-level keys).
   */
  allTools: ToolSet;
  /** What the model is handed: the core tools plus `tool_search` and `execute_tool`. */
  tools: ToolSet;
  /** The names behind `execute_tool`, for the catalog prompt. */
  nonCoreToolNames: string[];
  userCommandCatalog: UserCommandCatalog;
}

/** The Global Assistant's tools for a user and their toggles. */
export async function selectAssistantTools(input: AssistantToolSelectionInput): Promise<AssistantToolSelection> {
  // The COMPUTE tools (bash/files, git+gh, PTY shells — not the free
  // chat-session family) are stripped for a tier-ineligible payer BEFORE
  // anything reads this set — including integration resolution, whose
  // sandbox-git-overlap suppression keys on these tool NAMES.
  const allTools = filterToolsForImageGen(
    filterToolsForWebSearch(
      filterToolsForReadOnly(
        filterToolsForAgentAccounts(
          filterToolsForSandboxTier(
            filterToolsForMcpScope(pageSpaceTools, input.driveScoped),
            input.sandboxTierEligible,
          ),
        ),
        input.readOnly,
      ),
      input.webSearch,
    ),
    shouldExposeImageGen({ imageGenEnabled: input.imageGen, isAdmin: input.isAdmin, hasToolDef: true }),
  ) as ToolSet;

  // Core tools (plus the always-upfront runtime toggles) go to the model with
  // full schemas; everything else is reachable only via execute_tool.
  const { coreTools, nonCoreTools } = splitToolsForExposure(allTools, ALWAYS_UPFRONT_TOOLS);

  // Built-in skills and the per-viewer command list feed tool_search's corpus,
  // so discovery has one search surface.
  const toolNames = Object.keys(allTools);
  const userCommandCatalog = await loadUserCommandCatalog(input.userId, input.commandDriveId, toolNames);
  input.timer?.mark('commands_loaded');

  const tools: ToolSet = {
    ...coreTools,
    tool_search: createToolSearchTool(
      excludeAlwaysUpfront(allTools, ALWAYS_UPFRONT_TOOLS),
      [...listEligibleSkills(toolNames), ...userCommandCatalog.searchEntries],
    ),
    execute_tool: createExecuteTool(nonCoreTools),
  };

  return { allTools, tools, nonCoreToolNames: Object.keys(nonCoreTools), userCommandCatalog };
}

export interface AssistantContextInput {
  userId: string;
  location: LocationContext | null;
  readOnly: boolean;
  /** Whether the drive tree / all-drives summary is included. */
  showPageTree: boolean;
  /** The caller's token drive scope (empty = unscoped), for the Home-drive hint. */
  allowedDriveIds: readonly string[];
  /** Imago only: the drives its user keeps it out of. */
  excludedDriveIds?: ReadonlySet<string>;
  timer?: TurnTimer;
}

export interface AssistantContext {
  personalization: Awaited<ReturnType<typeof getUserPersonalization>>;
  /** The user's timezone, for the tool context. */
  timezone: Awaited<ReturnType<typeof getUserTimezone>>;
  /** Turn-volatile: rides the last user message, never the system prompt. */
  timestampPrompt: string;
  /** Turn-volatile, as above. */
  locationPrompt: string;
  drivePromptSection: string;
  agentAwarenessPrompt: string;
  pageTreePrompt: string;
}

/** The Global Assistant's context for a user at a location. */
export async function buildAssistantContext(input: AssistantContextInput): Promise<AssistantContext> {
  const { userId, location, readOnly, showPageTree, allowedDriveIds, timer } = input;
  const excludedDriveIds = input.excludedDriveIds ?? NO_EXCLUSIONS;

  const [personalization, userTimezone] = await Promise.all([
    getUserPersonalization(userId),
    getUserTimezone(userId),
  ]);
  timer?.mark('personalization');

  // "Current page/drive" is turn-volatile: built as `locationPrompt` and
  // injected via buildVolatileTurnContext, never baked into the system prompt,
  // so that string stays byte-identical across turns wherever the user goes.
  const hasLocation = Boolean(location?.currentPage || location?.currentDrive);
  const homeDriveId = await resolveHomeDriveHint(userId, hasLocation, allowedDriveIds);
  timer?.mark('home_drive_resolved');

  const viewedDriveId = location?.currentDrive?.id ?? null;
  const excludedInView = viewedDriveId !== null && excludedDriveIds.has(viewedDriveId);
  // The drive in view as the assistant may use it: none when it is kept out.
  const driveInView = excludedInView ? null : viewedDriveId;
  const agentAccess: LocationAgentAccess | undefined = excludedInView ? { kind: 'excluded' } : undefined;

  const locationPrompt = buildLocationTurnPrompt(location ? {
    currentPage: location.currentPage,
    currentDrive: location.currentDrive,
    breadcrumbs: location.breadcrumbs,
    homeDriveId,
    ...(agentAccess && { agentAccess }),
  } : { homeDriveId });

  let drivePromptSection = '';
  if (driveInView) {
    try {
      const [drive] = await db
        .select({ drivePrompt: drives.drivePrompt })
        .from(drives)
        .where(eq(drives.id, driveInView))
        .limit(1);
      if (drive?.drivePrompt?.trim()) {
        drivePromptSection = `\n\n## DRIVE INSTRUCTIONS\n\nThe following custom instructions have been set for this drive by the drive owner:\n\n${drive.drivePrompt}`;
      }
    } catch (error) {
      loggers.api.error('Assistant context: failed to fetch drive prompt', error as Error);
    }
    timer?.mark('drive_prompt_loaded');
  }

  // `canDelegate` mirrors the session-tool gate: spawn_session is stripped by
  // `filterToolsForReadOnly` as a write tool, and a prompt that names a tool
  // the model does not have makes it attempt delegation that silently fails.
  const agentAwarenessPrompt = await buildAgentAwarenessPrompt(userId, {
    canDelegate: !readOnly,
    ...(excludedDriveIds.size > 0 && { excludedDriveIds }),
  });
  timer?.mark('agent_awareness_built');

  let pageTreePrompt = '';
  if (showPageTree) {
    if (driveInView) {
      const treeContext = await getPageTreeContext(userId, { scope: 'drive', driveId: driveInView });
      timer?.mark('page_tree_loaded');
      if (treeContext) {
        pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the complete workspace structure:\n\n${treeContext}`;
      }
    } else {
      const driveSummary = await getDriveListSummary(userId, excludedDriveIds.size > 0 ? { excludedDriveIds } : {});
      timer?.mark('drive_summary_loaded');
      if (driveSummary) {
        pageTreePrompt = `\n\n## ACCESSIBLE WORKSPACES\n\n${driveSummary}`;
      }
    }
  }

  return {
    personalization,
    timezone: userTimezone,
    timestampPrompt: buildTimestampSystemPrompt(userTimezone),
    locationPrompt,
    drivePromptSection,
    agentAwarenessPrompt,
    pageTreePrompt,
  };
}
