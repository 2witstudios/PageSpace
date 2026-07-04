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
 */
import { activityHandler } from '../commands/activity.js';
import { agentsAskHandler, agentsConfigHandler, agentsListHandler, modelsListHandler } from '../commands/agents.js';
import { channelsSendHandler } from '../commands/channels.js';
import {
  drivesCreateHandler,
  drivesListHandler,
  drivesRenameHandler,
  drivesRestoreHandler,
  drivesTrashHandler,
} from '../commands/drives.js';
import { pagesReadHandler, pagesReplaceLinesHandler } from '../commands/content.js';
import { pagesExportHandler } from '../commands/export.js';
import { createHelpHandler } from '../commands/help.js';
import { loginHandler } from '../commands/login.js';
import { logoutHandler } from '../commands/logout.js';
import { mcpHandler } from '../commands/mcp.js';
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
import { sheetsEditCellsHandler } from '../commands/sheets.js';
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
import { tokensCreateHandler } from '../commands/tokens/create.js';
import { tokensListHandler } from '../commands/tokens/list.js';
import { tokensRevokeHandler } from '../commands/tokens/revoke.js';
import type { Route } from './router.js';

export interface RouteEntry extends Route {
  readonly summary: string;
}

const OTHER_ROUTES: readonly RouteEntry[] = [
  { path: ['login'], handler: loginHandler, summary: 'Log in via the browser (loopback + PKCE)' },
  { path: ['logout'], handler: logoutHandler, summary: 'Revoke and remove a stored credential' },
  { path: ['whoami'], handler: whoamiHandler, summary: 'Show the currently authenticated identity' },
  { path: ['tokens', 'create'], handler: tokensCreateHandler, summary: 'Mint a new MCP access token' },
  { path: ['tokens', 'list'], handler: tokensListHandler, summary: 'List MCP access tokens' },
  { path: ['tokens', 'revoke'], handler: tokensRevokeHandler, summary: 'Revoke an MCP access token' },
  { path: ['mcp'], handler: mcpHandler, summary: 'Serve the full operation registry as an MCP stdio server' },
  { path: ['drives', 'list'], handler: drivesListHandler, summary: 'List drives' },
  { path: ['drives', 'create'], handler: drivesCreateHandler, summary: 'Create a drive' },
  { path: ['drives', 'rename'], handler: drivesRenameHandler, summary: 'Rename a drive' },
  { path: ['drives', 'trash'], handler: drivesTrashHandler, summary: 'Trash a drive' },
  { path: ['drives', 'restore'], handler: drivesRestoreHandler, summary: 'Restore a trashed drive' },
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
  { path: ['activity'], handler: activityHandler, summary: 'Show recent activity' },
  { path: ['channels', 'send'], handler: channelsSendHandler, summary: 'Send a channel message' },
];

const HELP_ROUTE: Omit<RouteEntry, 'handler'> = { path: ['help'], summary: 'Show this help message' };

export const helpHandler = createHelpHandler([HELP_ROUTE, ...OTHER_ROUTES.map((r) => ({ path: r.path, summary: r.summary }))]);

export const ROUTES: readonly RouteEntry[] = [{ ...HELP_ROUTE, handler: helpHandler }, ...OTHER_ROUTES];
