import { KEY_ENV_VAR_NAME } from '../auth/resolve.js';
import { EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';

/** Pure path+summary pair for one registered command — no handler reference, so this module stays a leaf (no dependency on the route table). */
export interface HelpCommandDescriptor {
  readonly path: readonly string[];
  readonly summary: string;
}

export interface HelpGroup {
  readonly title: string;
  readonly example: string;
  readonly commands: readonly HelpCommandDescriptor[];
}

const GLOBAL_FLAG_LINES = [
  'Global flags:',
  '  --json          Emit machine-readable JSON on stdout only',
  '  --host <url>    Override the API host',
  '  --token <tok>   Override the credential',
  `  --key <name>    Use a stored key by name (env: ${KEY_ENV_VAR_NAME})`,
  '  --device        Approve on another device via a code, without a local browser',
  '  --yes           Assume yes to confirmation prompts',
  '  --all           Apply to every stored credential (logout)',
  '  --force         Proceed despite a non-fatal failure (logout)',
  '  --help          Show help',
  '  --version       Show the CLI version',
];

interface GroupDefinition {
  readonly key: string;
  readonly title: string;
  readonly example: string;
  readonly resources: readonly string[];
}

/**
 * Fixed display order and one runnable example per resource group. A
 * command's first path segment (its resource) decides its group; anything
 * whose resource isn't listed here falls into "Other" rather than being
 * dropped, so every registered command still appears exactly once.
 */
const GROUP_DEFINITIONS: readonly GroupDefinition[] = [
  { key: 'auth', title: 'Auth', example: 'pagespace login', resources: ['login', 'logout', 'whoami'] },
  { key: 'drives', title: 'Drives', example: 'pagespace drives list', resources: ['drives', 'trash', 'roles'] },
  { key: 'pages', title: 'Pages', example: 'pagespace pages read <pageId>', resources: ['pages', 'sheets'] },
  { key: 'search', title: 'Search', example: 'pagespace search text <query> --drive <id>', resources: ['search'] },
  { key: 'tasks', title: 'Tasks', example: 'pagespace tasks create <pageId> --title <title>', resources: ['tasks'] },
  { key: 'agents', title: 'Agents', example: 'pagespace agents ask <agentPageId> <message>', resources: ['agents', 'models'] },
  { key: 'keys', title: 'Keys', example: 'pagespace keys', resources: ['keys'] },
  { key: 'mcp', title: 'MCP', example: 'pagespace mcp', resources: ['mcp'] },
  { key: 'other', title: 'Other', example: 'pagespace activity <driveId>', resources: [] },
];

function resourceOf(command: HelpCommandDescriptor): string {
  return command.path[0] ?? '';
}

/** Groups commands by resource for display — pure over the descriptor list, no I/O. */
export function groupHelpCommands(commands: readonly HelpCommandDescriptor[]): readonly HelpGroup[] {
  const otherIndex = GROUP_DEFINITIONS.length - 1;
  const grouped = GROUP_DEFINITIONS.map(() => [] as HelpCommandDescriptor[]);

  for (const command of commands) {
    const resource = resourceOf(command);
    const index = GROUP_DEFINITIONS.findIndex((group) => group.resources.includes(resource));
    grouped[index === -1 ? otherIndex : index].push(command);
  }

  return GROUP_DEFINITIONS.map((group, index) => ({
    title: group.title,
    example: group.example,
    commands: grouped[index],
  })).filter((group) => group.commands.length > 0);
}

function commandLines(commands: readonly HelpCommandDescriptor[], width: number): string[] {
  return commands.map((c) => `    ${c.path.join(' ').padEnd(width)}  ${c.summary}`);
}

/**
 * The summary column's width is computed once across every command in every
 * group (not per group) so the column lines up across group boundaries —
 * e.g. Auth's longest name ("whoami") is much shorter than Tokens', but both
 * groups' summaries still start in the same place.
 */
function groupedLines(groups: readonly HelpGroup[]): string[] {
  const width = Math.max(...groups.flatMap((group) => group.commands.map((c) => c.path.join(' ').length)));
  return groups.flatMap((group) => [
    `${group.title}:`,
    ...commandLines(group.commands, width),
    `    e.g. ${group.example}`,
    '',
  ]);
}

/**
 * Builds the `help` handler from the full command list (path + summary for
 * every registered route). Takes the list as a parameter, rather than
 * importing the route table itself, so this module never depends on
 * `router/routes.ts` — which itself depends on this module to build the
 * `help` route's own handler. `router/routes.ts` is the sole caller.
 */
export function createHelpHandler(commands: readonly HelpCommandDescriptor[]): CommandHandler {
  const lines = [
    'pagespace <command> [flags]',
    '',
    ...groupedLines(groupHelpCommands(commands)),
    ...GLOBAL_FLAG_LINES,
  ];

  return async (ctx, intent) => {
    if (intent.flags.json) {
      ctx.stdout.write(JSON.stringify({ usage: lines }));
    } else {
      ctx.stdout.write(`${lines.join('\n')}\n`);
    }
    return EXIT_SUCCESS;
  };
}
