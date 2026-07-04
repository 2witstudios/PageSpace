/**
 * Slash command operations (Phase 3 task 8).
 *
 * Route-verified against `apps/web/src/app/api/commands/route.ts` (GET/POST)
 * and `apps/web/src/app/api/commands/[commandId]/route.ts` (PATCH/DELETE)
 * (docs/sdk/operations-inventory.md §2.11, parity with MCP tools
 * `list_commands`, `create_command`, `update_command`, `delete_command`).
 *
 * Commands are slash commands scoped to EITHER a user (personal) OR a drive
 * (shared with every drive member), never both (`commands_scope_chk`,
 * `packages/db/src/schema/commands.ts`) — the Universal Commands epic's
 * Agent Skills surface: a command's entry page is the skill body, its direct
 * children are discoverable resources. Trigger/description validation
 * (`triggerSchema`/`descriptionSchema` below) mirrors
 * `@pagespace/lib/commands/command-core`'s constants (inlined, not imported —
 * see below), drift-guarded by `commands.test.ts`.
 *
 * DISCREPANCY vs the old MCP tool (`list_commands`, tools.js:1032): the tool
 * accepted an optional `driveId` filter, but the CURRENT GET route
 * (`commands/route.ts`) reads no query parameters at all — it always
 * returns every command visible to the caller (personal + every drive they
 * belong to, MCP-scope-filtered server-side). `commands.list` below takes no
 * input, matching route truth; filter the returned array client-side for a
 * single drive.
 *
 * `requiredScope: 'account'` on every write op here is the safe common
 * floor: an unscoped (account-level) principal can always create/update/
 * delete a PERSONAL command, and a personal command is what happens when
 * `driveId` is omitted. Supplying `driveId` additionally requires drive
 * owner/admin authority server-side — a per-call condition this static
 * registry field cannot express (same limitation the ADR 0002 scope grammar
 * accepts for every operation whose authority depends on its own input).
 *
 * The trigger/description validation constants below are INLINED, not
 * imported from `@pagespace/lib` — that package is dev-only workspace tooling
 * and a value-import of it survives into `dist/`, breaking any consumer that
 * installs `@pagespace/sdk` outside this monorepo (`ERR_MODULE_NOT_FOUND`).
 * `commands.test.ts` drift-guards these values against
 * `packages/lib/src/commands/command-core.ts` directly.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const commandScopeEnum = z.enum(['user', 'drive']);
const commandTypeEnum = z.enum(['document', 'prompt_template', 'builtin']);

/** Mirrors `packages/lib/src/commands/command-core.ts` (Agent Skills 'name' rules: lowercase alphanumeric + single hyphens). Inlined — see file header. */
export const COMMAND_TRIGGER_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const COMMAND_TRIGGER_MAX_LENGTH = 64;
export const COMMAND_DESCRIPTION_MAX_LENGTH = 1024;

/** Agent Skills 'name' rules (`packages/lib/src/commands/command-core.ts`), mirrored so an invalid trigger is rejected before the network call. */
const triggerSchema = z.string().min(1).max(COMMAND_TRIGGER_MAX_LENGTH).regex(COMMAND_TRIGGER_PATTERN);
const descriptionSchema = z.string().min(1).max(COMMAND_DESCRIPTION_MAX_LENGTH);

/** `CommandResponse` (`commands/command-route-helpers.ts`), Date fields ISO-serialized over JSON. */
const commandResponseSchema = z.object({
  id: z.string(),
  scope: commandScopeEnum,
  driveId: z.string().nullable(),
  trigger: z.string(),
  description: z.string(),
  entryPageId: z.string(),
  type: commandTypeEnum,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `CommandListItem` — what GET /api/commands adds for the settings lists. */
const commandListItemSchema = commandResponseSchema.extend({
  entryPageTitle: z.string().nullable(),
  entryPageDriveId: z.string().nullable(),
  entryPageAvailable: z.boolean(),
  authorName: z.string().nullable(),
});

const commandEnvelopeSchema = z.object({ command: commandResponseSchema });

export const listCommands = defineOperation({
  name: 'commands.list',
  method: 'GET',
  path: '/api/commands',
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ commands: z.array(commandListItemSchema) }),
  requiredScope: 'account',
  description:
    "List every command visible to the caller: their personal commands plus every command from a drive they belong to. Takes no filter — the route ignores driveId entirely.",
});

export const createCommand = defineOperation({
  name: 'commands.create',
  method: 'POST',
  path: '/api/commands',
  inputSchema: z
    .object({
      trigger: triggerSchema,
      description: descriptionSchema,
      entryPageId: z.string().min(1),
      driveId: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  outputSchema: commandEnvelopeSchema,
  requiredScope: 'account',
  description:
    'Create a slash command. Omit driveId for a personal command visible only to you; provide driveId for a drive command shared with every member (requires owner/admin authority on that drive). The entry page must exist, not be trashed, be viewable by you, and — for drive commands — live in the same drive.',
});

export const updateCommand = defineOperation({
  name: 'commands.update',
  method: 'PATCH',
  path: '/api/commands/:commandId',
  inputSchema: z
    .object({
      commandId: z.string(),
      trigger: triggerSchema.optional(),
      description: descriptionSchema.optional(),
      entryPageId: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  outputSchema: commandEnvelopeSchema,
  requiredScope: 'account',
  description:
    "Update a command's trigger, description, entry page, or enabled state. A command's scope (personal vs. drive) can never be changed once created. Personal commands require ownership; drive commands require owner/admin authority on that drive.",
});

export const deleteCommand = defineOperation({
  name: 'commands.delete',
  method: 'DELETE',
  path: '/api/commands/:commandId',
  inputSchema: z.object({ commandId: z.string() }).strict(),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'account',
  destructive: true,
  description:
    'Delete a command, permanently discarding its trigger. Personal commands require ownership; drive commands require owner/admin authority on that drive. Irreversible — the CLI requires --yes.',
});
