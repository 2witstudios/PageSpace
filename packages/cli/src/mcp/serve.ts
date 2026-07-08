/**
 * `pagespace mcp`'s stdio server (Phase 6 task 1) — a thin shell over the
 * operation registry. All decision logic (tool conversion, input
 * validation, error mapping) lives in `tool-convert.ts`; this file only:
 * (1) assembles every SDK-exported operation into one full registry, and
 * (2) wires the low-level MCP `Server`'s `tools/list` and `tools/call`
 * handlers to that registry.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  askAgent,
  createCalendarEvent,
  createCommand,
  createDrive,
  createDriveRole,
  createPage,
  createTask,
  createTaskStatus,
  createWorkflow,
  deleteCalendarEvent,
  deleteCalendarTrigger,
  deleteChannelMessage,
  deleteCommand,
  deleteDriveRole,
  deleteLines,
  deleteTask,
  deleteTaskTrigger,
  deleteWorkflow,
  editSheetCells,
  exportPageMarkdown,
  exportSheetCsv,
  getActivity,
  getAssignedTasks,
  getCalendarEvent,
  getDriveRole,
  getPageDetails,
  globSearch,
  insertLines,
  inviteCalendarAttendees,
  listAgents,
  listCalendarEvents,
  listCollaborators,
  listCommands,
  listConversations,
  listDriveMembers,
  listDriveRoles,
  listDrives,
  listModels,
  listPages,
  listTrash,
  listWorkflows,
  movePage,
  multiDriveListAgents,
  multiDriveSearch,
  readConversation,
  readDocument,
  regexSearch,
  removeCalendarAttendee,
  removeRolePagePermissions,
  renameDrive,
  renamePage,
  reorderTask,
  replaceLines,
  restoreDrive,
  restorePage,
  rsvpCalendarEvent,
  sendChannelMessage,
  setCalendarTrigger,
  setHomePage,
  setRoleDriveWidePermissions,
  setRolePagePermissions,
  setTaskTrigger,
  trashDrive,
  trashPage,
  updateAgentConfig,
  updateCalendarEvent,
  updateCommand,
  updateDriveContext,
  updateDriveRole,
  updateTask,
  updateWorkflow,
  createRegistry,
  getOperation,
  listOperations,
  type Operation,
  type OperationRegistry,
} from '@pagespace/sdk';
import {
  formatInvalidInputResult,
  formatSdkErrorResult,
  formatSuccessResult,
  formatUnknownToolResult,
  operationToMcpTool,
  validateToolInput,
} from './tool-convert.js';
import { CLI_VERSION } from '../commands/version.js';

/**
 * Every operation the SDK exports, across every domain (drives, pages,
 * documents, roles, tasks, agents, conversations, channels, activity,
 * calendar, search, commands, workflows, members, collaborators, export).
 * `buildOperationRegistry` is the ONLY place this list is assembled — the
 * MCP tool surface is derived from it mechanically (`listOperations` +
 * `operationToMcpTool`), so drift between "operations the SDK has" and
 * "tools MCP serves" is structurally impossible.
 */
const ALL_OPERATIONS: readonly Operation[] = [
  askAgent,
  createCalendarEvent,
  createCommand,
  createDrive,
  createDriveRole,
  createPage,
  createTask,
  createTaskStatus,
  createWorkflow,
  deleteCalendarEvent,
  deleteCalendarTrigger,
  deleteChannelMessage,
  deleteCommand,
  deleteDriveRole,
  deleteLines,
  deleteTask,
  deleteTaskTrigger,
  deleteWorkflow,
  editSheetCells,
  exportPageMarkdown,
  exportSheetCsv,
  getActivity,
  getAssignedTasks,
  getCalendarEvent,
  getDriveRole,
  getPageDetails,
  globSearch,
  insertLines,
  inviteCalendarAttendees,
  listAgents,
  listCalendarEvents,
  listCollaborators,
  listCommands,
  listConversations,
  listDriveMembers,
  listDriveRoles,
  listDrives,
  listModels,
  listPages,
  listTrash,
  listWorkflows,
  movePage,
  multiDriveListAgents,
  multiDriveSearch,
  readConversation,
  readDocument,
  regexSearch,
  removeCalendarAttendee,
  removeRolePagePermissions,
  renameDrive,
  renamePage,
  reorderTask,
  replaceLines,
  restoreDrive,
  restorePage,
  rsvpCalendarEvent,
  sendChannelMessage,
  setCalendarTrigger,
  setHomePage,
  setRoleDriveWidePermissions,
  setRolePagePermissions,
  setTaskTrigger,
  trashDrive,
  trashPage,
  updateAgentConfig,
  updateCalendarEvent,
  updateCommand,
  updateDriveContext,
  updateDriveRole,
  updateTask,
  updateWorkflow,
];

/** Pure: assembles the full operation registry. Rejects duplicate names at construction (`createRegistry`). */
export function buildOperationRegistry(): OperationRegistry {
  return createRegistry(ALL_OPERATIONS);
}

/**
 * The only slice of `PageSpaceClient` this server needs. Deliberately not
 * `Pick<PageSpaceClient, 'invoke'>`: `PageSpaceClient.invoke` is generic per
 * call (`Operation<string, TInputSchema, TOutputSchema>` narrows its own
 * input/output types), and every operation flowing through here is the
 * type-erased `Operation` `listOperations` returns — a plain, non-generic
 * shape is what a fake `invoke` in tests needs to satisfy too.
 */
export interface McpSdkClient {
  invoke(op: Operation, input: unknown): Promise<unknown>;
}

export interface CreateMcpServerOptions {
  readonly registry: OperationRegistry;
  readonly sdk: McpSdkClient;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

// CLI_VERSION (drift-guarded against package.json by commands/__tests__/
// version.test.ts) so the MCP initialize handshake reports the real release
// — a hand-maintained copy here is exactly the drift the 1.5.0 guards kill.
const DEFAULT_SERVER_INFO = { name: 'pagespace', version: CLI_VERSION } as const;

/**
 * Wires `tools/list` and `tools/call` to `registry`. The only I/O this
 * function's handlers perform is `sdk.invoke` — everything else (listing,
 * validation, error formatting) delegates to the pure functions in
 * `tool-convert.ts`.
 */
export function createMcpServer(options: CreateMcpServerOptions): Server {
  const { registry, sdk } = options;
  const server = new Server(
    { name: options.serverInfo?.name ?? DEFAULT_SERVER_INFO.name, version: options.serverInfo?.version ?? DEFAULT_SERVER_INFO.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listOperations(registry).map(operationToMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const op = getOperation(registry, name);
    if (!op) {
      return formatUnknownToolResult(name) as CallToolResult;
    }

    const validated = validateToolInput(op, rawArgs ?? {});
    if (!validated.ok) {
      return formatInvalidInputResult(op, validated.issues) as CallToolResult;
    }

    try {
      const output = await sdk.invoke(op, validated.data);
      return formatSuccessResult(output) as CallToolResult;
    } catch (error) {
      return formatSdkErrorResult(op, error) as CallToolResult;
    }
  });

  return server;
}
