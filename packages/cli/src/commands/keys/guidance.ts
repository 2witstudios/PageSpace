/**
 * Pure post-mint copy shared by `keys create` (`create.ts`) and the wizard
 * (`wizard.ts`) — a separate module rather than `logic.ts` because `create.ts`
 * needs it too, and `logic.ts` already imports from `create.ts`
 * (`buildTokenScope`); importing back the other way would create a cycle.
 */
import { TOKEN_ENV_VAR_NAME } from '../../auth/resolve.js';
import { DEFAULT_HOST } from '../../config/resolve.js';

export const WIZARD_INTRO_HINT =
  'Keys are scoped credentials your agents use to access specific drives. Each key is saved locally as a named profile (a credential in your OS keychain).';

export const SHOW_TOKEN_PROMPT = "Show the token now for .env/CI use? It won't be shown again.";

export interface AgentWiringGuidanceParams {
  readonly profileName: string;
  readonly host: string;
}

/**
 * Ready-to-paste agent-wiring guidance printed after a successful mint.
 * Mirrors the MCP integration docs
 * (`apps/marketing/src/app/docs/integrations/mcp/page.tsx`): profile-based
 * config for this machine, raw-token env var for .env/CI/other machines.
 * `PAGESPACE_API_URL` is included only for a non-default host — against
 * production it would be noise.
 */
export function renderAgentWiringGuidance(params: AgentWiringGuidanceParams): readonly string[] {
  const env: Record<string, string> = { PAGESPACE_PROFILE: params.profileName };
  if (params.host !== DEFAULT_HOST) {
    env.PAGESPACE_API_URL = params.host;
  }
  const config = {
    mcpServers: {
      pagespace: {
        command: 'pagespace',
        args: ['mcp'],
        env,
      },
    },
  };
  return [
    'A profile is a named credential in your OS keychain — agents on this machine reference it by name, never a raw token.',
    '',
    'Add this to your MCP client config (Claude Code, Claude Desktop, Cursor):',
    ...JSON.stringify(config, null, 2).split('\n'),
    '',
    'For .env or CI (or a different machine), use the raw token instead:',
    `${TOKEN_ENV_VAR_NAME}=mcp_...   (shown once, at mint time only)`,
  ];
}
