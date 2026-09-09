/**
 * The owner's prompt for `ask` mode (invariant 5). The daemon asks once per
 * new (principal, session) and per op that is not pre-approved in the
 * policy; an approval is remembered for the life of the process, a decline is
 * not (the next request asks again). What the owner sees is EXACTLY the
 * `NormalizedRequest` the `ask` verdict carried — confined cwd and paths,
 * scrubbed env, clamped caps — because that is what `decideExecution` will
 * re-normalize and compare against on approval (`approval_mismatch`).
 *
 * The prompt primitive is injected: `env connect` supplies `@clack/prompts`'
 * confirm; tests supply a function. A prompt that throws (stdin closed) is
 * a decline.
 */
import type { GrantOp, GrantPrincipal } from './lib-core.js';
import type { NormalizedRequest } from './lib-core.js';

export interface AskInput {
  readonly grantId: string;
  readonly principal: GrantPrincipal;
  readonly op: GrantOp;
  readonly request: NormalizedRequest;
}

export interface AskPrompter {
  ask(input: AskInput): Promise<boolean>;
}

export interface AskPrompterDeps {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly write: (chunk: string) => void;
}

/** One approval covers one (user, session, op); the conversation is not part of the key. */
export function approvalKey(principal: GrantPrincipal, op: GrantOp): string {
  return `${principal.userId} ${principal.sessionId} ${op}`;
}

export function renderAskPrompt(input: AskInput): string {
  const { request } = input;
  const lines = [
    `PageSpace asks to run on this machine (grant ${input.grantId}):`,
    `  principal  user ${input.principal.userId}, session ${input.principal.sessionId}, conversation ${input.principal.conversationId}`,
    `  op         ${input.op}`,
  ];
  if (request.cmd !== undefined) lines.push(`  command    ${[request.cmd, ...(request.args ?? [])].join(' ')}`);
  lines.push(`  cwd        ${request.cwd}`);
  if (request.paths.length > 0) lines.push(`  paths      ${request.paths.join(', ')}`);
  const env = Object.entries(request.env).map(([name, value]) => `${name}=${value}`);
  lines.push(`  env        ${env.length > 0 ? env.join(' ') : '(none)'}`);
  lines.push(`  limits     timeout ${request.timeoutMs} ms, output ${request.maxBytes} bytes${request.clamped ? ' (clamped to your policy)' : ''}`);
  lines.push('Approving also covers further requests for this op from the same user and session while this daemon runs.');
  return lines.join('\n');
}

export function createAskPrompter(deps: AskPrompterDeps): AskPrompter {
  const approved = new Set<string>();
  return {
    async ask(input) {
      const key = approvalKey(input.principal, input.op);
      if (approved.has(key)) return true;
      deps.write(`${renderAskPrompt(input)}\n`);
      let answer = false;
      try {
        answer = await deps.confirm('Allow?');
      } catch {
        answer = false;
      }
      if (answer) approved.add(key);
      return answer;
    },
  };
}
