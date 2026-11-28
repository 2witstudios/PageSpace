/**
 * Pure arg mapping for the agent-account commands (`signup --agent`,
 * `login --agent`, `agent claim|rotate-secret|create-key`). The global
 * grammar (`argv/parse.ts`) hands every command-specific `--flag` through
 * verbatim; this turns them into a typed record or a usage error. Never
 * echoes a value back (a value may be a secret pasted in the wrong place).
 */

export interface AgentArgs {
  readonly agent: boolean;
  readonly name: string | undefined;
  readonly source: string | undefined;
  readonly showSecret: boolean;
  readonly revokeTokens: boolean;
  readonly noWait: boolean;
}

export type AgentArgsResult = { readonly ok: true; readonly args: AgentArgs } | { readonly ok: false; readonly message: string };

type BooleanFlag = '--agent' | '--show-secret' | '--revoke-tokens' | '--no-wait';
type ValueFlag = '--name' | '--source';

export interface AgentArgsSpec {
  readonly booleans: readonly BooleanFlag[];
  readonly values: readonly ValueFlag[];
}

export function parseAgentArgs(rest: readonly string[], spec: AgentArgsSpec): AgentArgsResult {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq === -1 ? token : token.slice(0, eq);

    if ((spec.values as readonly string[]).includes(name)) {
      const value = eq === -1 ? rest[i + 1] : token.slice(eq + 1);
      if (value === undefined || value.trim().length === 0 || (eq === -1 && value.startsWith('--'))) {
        return { ok: false, message: `Flag ${name} requires a value.` };
      }
      values.set(name, value.trim());
      if (eq === -1) i += 1;
      continue;
    }
    if ((spec.booleans as readonly string[]).includes(token)) {
      flags.add(token);
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, message: `Unknown flag: ${name}` };
    }
    return { ok: false, message: 'Unexpected argument. This command takes flags only (see "pagespace help").' };
  }

  return {
    ok: true,
    args: {
      agent: flags.has('--agent'),
      name: values.get('--name'),
      source: values.get('--source'),
      showSecret: flags.has('--show-secret'),
      revokeTokens: flags.has('--revoke-tokens'),
      noWait: flags.has('--no-wait'),
    },
  };
}
