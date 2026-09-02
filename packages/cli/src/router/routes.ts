/**
 * The single source of truth for the CLI's command tree — path segments,
 * handler, and a one-line summary. `run.ts` routes against this table;
 * `helpHandler` (built here, not in `commands/help.ts`) renders it verbatim,
 * so the built-in help can never drift from what's actually registered
 * (previously `help.ts` hardcoded a stale list of only 5 of the 40+
 * registered commands).
 *
 * `createHelpHandler` lives in `commands/help.ts` and takes the descriptor
 * list as a parameter rather than importing it, specifically so that module
 * never depends on this one — this module already depends on it (for the
 * `help` route's own handler), and a two-way dependency between them would
 * be an import cycle.
 *
 * Adding a route here also means deciding whether its handler belongs in
 * `run.ts`'s `AUTH_EXEMPT_HANDLERS` — see that set's doc comment. The default
 * (not adding it) is safe: an omitted handler is simply gated and fails
 * closed, so forgetting this only breaks that command for users who expect
 * it to manage its own credentials, never leaks a credential.
 */
import { activityHandler } from '../commands/activity.js';
import { agentsAskHandler, agentsConfigHandler, agentsListHandler, modelsListHandler } from '../commands/agents.js';
import { channelsSendHandler } from '../commands/channels.js';
import { conversationsListHandler, conversationsReadHandler } from '../commands/conversations.js';
import {
  drivesCreateHandler,
  drivesListHandler,
  drivesRenameHandler,
  drivesRestoreHandler,
  drivesSetHomePageHandler,
  drivesTrashHandler,
  drivesUpdateContextHandler,
} from '../commands/drives.js';
import { pagesReadHandler, pagesReplaceLinesHandler } from '../commands/content.js';
import { pagesExportHandler } from '../commands/export.js';
import { filesUploadHandler } from '../commands/files.js';
import { createHelpHandler } from '../commands/help.js';
import { loginHandler } from '../commands/login.js';
import { logoutHandler } from '../commands/logout.js';
import { mcpHandler } from '../commands/mcp.js';
import {
  rolesCreateHandler,
  rolesDeleteHandler,
  rolesGetHandler,
  rolesListHandler,
  rolesRemovePagePermissionsHandler,
  rolesSetDriveWidePermissionsHandler,
  rolesSetPagePermissionsHandler,
  rolesUpdateHandler,
} from '../commands/roles.js';
import { searchGlobHandler, searchRegexHandler, searchTextHandler } from '../commands/search.js';
import {
  pagesCreateHandler,
  pagesListHandler,
  pagesMoveHandler,
  pagesReadDetailsHandler,
  pagesRenameHandler,
  pagesRestoreHandler,
  pagesTrashHandler,
  pagesTreeHandler,
} from '../commands/pages.js';
import {
  sheetsAppendHandler,
  sheetsDeleteRowsHandler,
  sheetsDescribeHandler,
  sheetsEditCellsHandler,
  sheetsQueryHandler,
  sheetsRowsHandler,
  sheetsUpdateCellsHandler,
} from '../commands/sheets.js';
import {
  tasksAssignedHandler,
  tasksCreateHandler,
  tasksCreateStatusHandler,
  tasksDeleteHandler,
  tasksListHandler,
  tasksReorderHandler,
  tasksStatusesHandler,
  tasksUpdateHandler,
} from '../commands/tasks.js';
import { trashListHandler } from '../commands/trash.js';
import { whoamiHandler } from '../commands/whoami.js';
import { tokensCreateHandler } from '../commands/keys/create.js';
import { keysDescribeHandler } from '../commands/keys/describe.js';
import { tokensListHandler } from '../commands/keys/list.js';
import { tokensRevokeHandler } from '../commands/keys/revoke.js';
import { keysUseHandler } from '../commands/keys/use.js';
import { keysHandler } from '../commands/keys/wizard.js';
import type { Route } from './router.js';

export interface RouteEntry extends Route {
  readonly summary: string;
}

const OTHER_ROUTES: readonly RouteEntry[] = [
  { path: ['login'], handler: loginHandler, summary: 'Log in via the browser, or --device for a headless machine' },
  { path: ['logout'], handler: logoutHandler, summary: 'Revoke and remove a stored credential' },
  { path: ['whoami'], handler: whoamiHandler, summary: 'Show the currently authenticated identity' },
  // `keys` (Phase 9 task 5, consolidated Phase 9 follow-up) is the sole
  // surface for minting/listing/revoking/activating scoped access keys — the
  // earlier `tokens create/list/revoke` command family was folded into it.
  // Every keys route below is ambient-credential-eligible (see `run.ts`'s
  // `AUTH_EXEMPT_HANDLERS`): a bare `pagespace login` (manage_keys-scoped,
  // zero extra setup) can drive every one of them end-to-end. There is no
  // `keys edit`/`update` flag subcommand — per this phase's plan,
  // scope-editing is wizard-only.
  { path: ['keys'], handler: keysHandler, summary: 'Guided wizard to create/list/edit/revoke access keys' },
  { path: ['keys', 'create'], handler: tokensCreateHandler, summary: 'Mint a new access key (--device for a headless machine)' },
  { path: ['keys', 'list'], handler: tokensListHandler, summary: 'List access keys' },
  // The one keys verb a KEY itself can run: it describes the credential this
  // machine would use, never the other keys its owner holds — so it resolves
  // like a content command (active key included) rather than riding the
  // ambient login the management verbs need.
  { path: ['keys', 'describe'], handler: keysDescribeHandler, summary: "Show this credential's drives, role and effective permissions" },
  { path: ['keys', 'revoke'], handler: tokensRevokeHandler, summary: 'Revoke an access key' },
  { path: ['keys', 'use'], handler: keysUseHandler, summary: "Set this machine's active key (--device for a headless machine)" },
  { path: ['mcp'], handler: mcpHandler, longRunning: true, summary: 'Serve the full operation registry as an MCP stdio server' },
  { path: ['drives', 'list'], handler: drivesListHandler, summary: 'List drives' },
  { path: ['drives', 'create'], handler: drivesCreateHandler, summary: 'Create a drive' },
  { path: ['drives', 'rename'], handler: drivesRenameHandler, summary: 'Rename a drive' },
  { path: ['drives', 'update-context'], handler: drivesUpdateContextHandler, summary: "Update a drive's AI context prompt" },
  { path: ['drives', 'set-home-page'], handler: drivesSetHomePageHandler, summary: "Set (or --clear) a drive's landing page" },
  { path: ['drives', 'trash'], handler: drivesTrashHandler, summary: 'Trash a drive' },
  { path: ['drives', 'restore'], handler: drivesRestoreHandler, summary: 'Restore a trashed drive' },
  { path: ['roles', 'list'], handler: rolesListHandler, summary: 'List custom roles in a drive' },
  { path: ['roles', 'get'], handler: rolesGetHandler, summary: 'Get a role and its permissions' },
  { path: ['roles', 'create'], handler: rolesCreateHandler, summary: 'Create a custom role' },
  { path: ['roles', 'update'], handler: rolesUpdateHandler, summary: "Update a role's fields and drive-wide permissions" },
  { path: ['roles', 'delete'], handler: rolesDeleteHandler, summary: 'Delete a role' },
  { path: ['roles', 'set-page-permissions'], handler: rolesSetPagePermissionsHandler, summary: "Grant a role's permissions on a page" },
  {
    path: ['roles', 'set-drive-wide-permissions'],
    handler: rolesSetDriveWidePermissionsHandler,
    summary: "Set a role's drive-wide baseline permissions",
  },
  {
    path: ['roles', 'remove-page-permissions'],
    handler: rolesRemovePagePermissionsHandler,
    summary: "Remove a role's per-page permission override",
  },
  { path: ['pages', 'list'], handler: pagesListHandler, summary: 'List pages in a drive' },
  { path: ['pages', 'tree'], handler: pagesTreeHandler, summary: 'Show a page subtree' },
  { path: ['pages', 'read-details'], handler: pagesReadDetailsHandler, summary: 'Read page metadata' },
  { path: ['pages', 'create'], handler: pagesCreateHandler, summary: 'Create a page' },
  { path: ['pages', 'rename'], handler: pagesRenameHandler, summary: 'Rename a page' },
  { path: ['pages', 'move'], handler: pagesMoveHandler, summary: 'Move a page' },
  { path: ['pages', 'trash'], handler: pagesTrashHandler, summary: 'Trash a page' },
  { path: ['pages', 'restore'], handler: pagesRestoreHandler, summary: 'Restore a trashed page' },
  { path: ['pages', 'read'], handler: pagesReadHandler, summary: 'Read page content' },
  { path: ['pages', 'replace-lines'], handler: pagesReplaceLinesHandler, summary: 'Replace a line range in a page' },
  { path: ['pages', 'export'], handler: pagesExportHandler, summary: 'Export a page to a file' },
  { path: ['files', 'upload'], handler: filesUploadHandler, summary: 'Upload a local file into a drive' },
  { path: ['sheets', 'describe'], handler: sheetsDescribeHandler, summary: 'Show a sheet\'s tabs and dimensions' },
  { path: ['sheets', 'query'], handler: sheetsQueryHandler, summary: 'Filter and sort sheet rows' },
  { path: ['sheets', 'rows'], handler: sheetsRowsHandler, summary: 'Read sheet rows by position' },
  { path: ['sheets', 'append'], handler: sheetsAppendHandler, summary: 'Append rows to a sheet' },
  { path: ['sheets', 'update-cells'], handler: sheetsUpdateCellsHandler, summary: 'Write sheet cells by address (supports --tab)' },
  { path: ['sheets', 'delete-rows'], handler: sheetsDeleteRowsHandler, summary: 'Delete a range of sheet rows' },
  { path: ['sheets', 'edit-cells'], handler: sheetsEditCellsHandler, summary: 'Edit sheet cells' },
  { path: ['trash', 'list'], handler: trashListHandler, summary: 'List trashed pages/drives' },
  { path: ['tasks', 'list'], handler: tasksListHandler, summary: 'List tasks' },
  { path: ['tasks', 'create'], handler: tasksCreateHandler, summary: 'Create a task' },
  { path: ['tasks', 'update'], handler: tasksUpdateHandler, summary: 'Update a task' },
  { path: ['tasks', 'delete'], handler: tasksDeleteHandler, summary: 'Delete a task' },
  { path: ['tasks', 'reorder'], handler: tasksReorderHandler, summary: 'Reorder a task' },
  { path: ['tasks', 'statuses'], handler: tasksStatusesHandler, summary: 'List task statuses' },
  { path: ['tasks', 'create-status'], handler: tasksCreateStatusHandler, summary: 'Create a task status' },
  { path: ['tasks', 'assigned'], handler: tasksAssignedHandler, summary: 'List tasks assigned to you' },
  { path: ['search', 'text'], handler: searchTextHandler, summary: 'Full-text search' },
  { path: ['search', 'regex'], handler: searchRegexHandler, summary: 'Regex search' },
  { path: ['search', 'glob'], handler: searchGlobHandler, summary: 'Glob path search' },
  { path: ['agents', 'list'], handler: agentsListHandler, summary: 'List agents' },
  { path: ['agents', 'ask'], handler: agentsAskHandler, summary: 'Ask an agent' },
  { path: ['agents', 'config'], handler: agentsConfigHandler, summary: 'Read/update agent config' },
  { path: ['models', 'list'], handler: modelsListHandler, summary: 'List available AI models' },
  { path: ['conversations', 'list'], handler: conversationsListHandler, summary: 'List an agent\'s conversations' },
  { path: ['conversations', 'read'], handler: conversationsReadHandler, summary: 'Read a conversation\'s messages' },
  { path: ['activity'], handler: activityHandler, summary: 'Show recent activity' },
  { path: ['channels', 'send'], handler: channelsSendHandler, summary: 'Send a channel message' },
];

const HELP_DESCRIPTOR = { path: ['help'], summary: 'Show this help message' };

// RouteEntry is structurally a superset of HelpCommandDescriptor (path +
// summary), so OTHER_ROUTES can be passed straight through — no projection
// needed to drop the `handler` field.
export const helpHandler = createHelpHandler([HELP_DESCRIPTOR, ...OTHER_ROUTES]);

export const ROUTES: readonly RouteEntry[] = [{ ...HELP_DESCRIPTOR, handler: helpHandler }, ...OTHER_ROUTES];
