/**
 * Pure post-mint copy shared by `keys create` (`create.ts`) and the wizard
 * (`wizard.ts`) — a separate module rather than `logic.ts` because `create.ts`
 * needs it too, and `logic.ts` already imports from `create.ts`
 * (`buildTokenScope`); importing back the other way would create a cycle.
 */
import { KEY_ENV_VAR_NAME, TOKEN_ENV_VAR_NAME } from '../../auth/resolve.js';
import { DEFAULT_HOST } from '../../config/resolve.js';

export const WIZARD_INTRO_HINT =
  'Keys are scoped credentials your agents use to access specific drives. Each key is saved locally as a named credential in your OS keychain.';

export const SHOW_TOKEN_PROMPT = "Show the token now for .env/CI use? It won't be shown again.";

/**
 * The pointer to `keys describe`, printed once at the end of a successful mint.
 *
 * A key's role is not its capability — `member` means different things in a
 * drive with custom roles than in one without, and on a private page than on a
 * channel — so "you granted role X" is not an answer to "what can this key do".
 * `keys describe` asks the server, which resolves it the same way every content
 * request will (issue #2470).
 *
 * `--key <name>` is load-bearing, not decoration. `keys describe` reports the
 * credential a CONTENT command would use, so unlike its `keys` siblings it is
 * not auth-exempt and is subject to `run.ts`'s explicit-credential gate: with
 * a personal login and no active key — the state a user is in immediately
 * after `keys create` — a bare `pagespace keys describe` is refused outright.
 * Naming the key that was just minted is what makes the printed command one
 * the reader can actually run.
 */
export function keysDescribeHint(keyName: string): string {
  return `Run "pagespace keys describe --key ${keyName}" at any time to see this key's drives, role and effective permissions.`;
}

export interface AgentWiringGuidanceParams {
  readonly keyName: string;
  readonly host: string;
}

/**
 * Ready-to-paste agent-wiring guidance printed after a successful mint.
 * Mirrors the zero-install block in the README (`## pagespace mcp`):
 * named-key config for this machine, raw-token env var for .env/CI/other
 * machines. `PAGESPACE_API_URL` is included only for a non-default host —
 * against production it would be noise.
 *
 * The `npx` form leads rather than `{command: 'pagespace', args: ['mcp']}`
 * because nothing here knows how the CLI was invoked: the mint may well have
 * run through `npx -y -p @pagespace/cli pagespace keys`, leaving no
 * `pagespace` on PATH at all. Even after a global install, GUI MCP clients
 * (Claude Desktop, Cursor) launch without the shell's PATH and often can't
 * find a bare `pagespace`. `npx` works in every one of those cases, so the
 * global-install shorthand is offered as a follow-up line instead.
 *
 * `-p` is load-bearing: this package publishes two bins (`pagespace` and
 * `pagespace-mcp`) and neither is named `cli`, so without it npx takes
 * `@pagespace/cli` as the command and exits "could not determine executable
 * to run".
 */
export function renderAgentWiringGuidance(params: AgentWiringGuidanceParams): readonly string[] {
  const env: Record<string, string> = { [KEY_ENV_VAR_NAME]: params.keyName };
  if (params.host !== DEFAULT_HOST) {
    env.PAGESPACE_API_URL = params.host;
  }
  const config = {
    mcpServers: {
      pagespace: {
        command: 'npx',
        args: ['-y', '-p', '@pagespace/cli', 'pagespace-mcp'],
        env,
      },
    },
  };
  return [
    'A key is a named credential in your OS keychain — agents on this machine reference it by name, never a raw token.',
    '',
    'Add this to your MCP client config (Claude Code, Claude Desktop, Cursor):',
    ...JSON.stringify(config, null, 2).split('\n'),
    '',
    'Installed globally and on your MCP client\'s PATH? "command": "pagespace", "args": ["mcp"] does the same thing.',
    '',
    'For .env or CI (or a different machine), use the raw token instead:',
    `${TOKEN_ENV_VAR_NAME}=mcp_...   (shown once, at mint time only)`,
    '',
    // The ONE place this sentence is printed. The mint's permission summary
    // above it already shows the answer inline; repeating the pointer there
    // (and again here) put the same line on screen twice.
    keysDescribeHint(params.keyName),
  ];
}
