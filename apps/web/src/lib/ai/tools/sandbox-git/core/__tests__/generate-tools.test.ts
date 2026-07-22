import { describe, test } from 'vitest';
import { z } from 'zod';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { defineRow, type GitToolRow } from '../../tools/types';
import { generateSandboxGitTools, deriveToolNames, type GeneratorSeams } from '../../generate-tools';
import { SANDBOX_GIT_TOOL_ROWS } from '../../tools/registry';

// The generator is now the single place that could violate the exec contract:
// cmd must stay a literal 'git' | 'gh', args must stay string[], and nothing is
// shell-interpolated. These branch tests pin that contract.

interface Captured {
  cmd: string;
  args: string[];
  cwd?: string;
  token?: string;
}

function makeSeams() {
  const calls: Captured[] = [];
  const ctx = { userId: 'u1' } as never;
  const seams: GeneratorSeams = {
    open: async () => ({ ok: true, userId: 'u1', ctx }),
    git: async (cmd, args, _ctx, cwd) => {
      calls.push({ cmd, args, cwd });
      return { success: true };
    },
    withToken: async (_options, _target, run) => run(ctx, 'ghp_test'),
    gitR: async (cmd, args, _ctx, token, cwd) => {
      calls.push({ cmd, args, cwd, token });
      return { success: true };
    },
  };
  return { seams, calls };
}

const localRow: GitToolRow = defineRow({
  key: 'demo_local',
  group: 'worktree',
  cmd: 'git',
  exec: 'local',
  description: 'demo',
  schema: z.object({ cwd: z.string().optional() }).strict(),
  buildArgs: () => ({ args: ['status', '--porcelain'] }),
});

const tokenRow: GitToolRow = defineRow({
  key: 'demo_token',
  group: 'pr',
  cmd: 'gh',
  exec: 'token',
  description: 'demo',
  schema: z.object({ cwd: z.string().optional() }).strict(),
  buildArgs: () => ({ args: ['pr', 'list'] }),
});

const guardedRow: GitToolRow = defineRow({
  key: 'demo_guarded',
  group: 'remote',
  cmd: 'git',
  exec: 'token',
  description: 'demo',
  schema: z.object({ bad: z.boolean().optional() }).strict(),
  validate: (input) => (input.bad ? { ok: false, error: 'nope' } : { ok: true }),
  buildArgs: () => ({ args: ['push'] }),
});

const denyingRow: GitToolRow = defineRow({
  key: 'demo_deny',
  group: 'repo',
  cmd: 'git',
  exec: 'local',
  description: 'demo',
  schema: z.object({ path: z.string().optional() }).strict(),
  buildArgs: () => ({ error: 'escapes root', reason: 'path_escape' }),
});

describe('generateSandboxGitTools — local exec seam', () => {
  test('routes a local row through open + git with a literal cmd and string[] args', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([localRow], seams);
    await tools.demo_local.execute!({}, {} as never);
    assert({
      given: 'a local row',
      should: 'call git with cmd "git" and string[] args',
      actual: calls[0].cmd === 'git' && Array.isArray(calls[0].args) && calls[0].args.every((a) => typeof a === 'string'),
      expected: true,
    });
  });
  test('threads cwd from input into the seam', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([localRow], seams);
    await tools.demo_local.execute!({ cwd: 'repo' }, {} as never);
    assert({ given: 'a cwd', should: 'forward it to the seam', actual: calls[0].cwd, expected: 'repo' });
  });
});

describe('generateSandboxGitTools — token exec seam', () => {
  test('routes a token row through withToken + gitR', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([tokenRow], seams);
    await tools.demo_token.execute!({}, {} as never);
    assert({
      given: 'a token row',
      should: 'call gitR with cmd "gh" and a resolved token',
      actual: calls[0].cmd === 'gh' && calls[0].token === 'ghp_test',
      expected: true,
    });
  });
});

describe('generateSandboxGitTools — validation seam', () => {
  test('a failing validator denies before any effect (no seam call)', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([guardedRow], seams);
    const result = await tools.demo_guarded.execute!({ bad: true }, {} as never);
    assert({ given: 'a failing validator', should: 'return success:false and touch no seam', actual: (result as { success: boolean }).success === false && calls.length === 0, expected: true });
  });
  test('a passing validator proceeds to the seam', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([guardedRow], seams);
    await tools.demo_guarded.execute!({}, {} as never);
    assert({ given: 'a passing validator', should: 'reach the seam', actual: calls.length, expected: 1 });
  });
  test('the validator is wired into the schema (same function drives safeParse)', () => {
    const tools = generateSandboxGitTools([guardedRow], makeSeams().seams);
    const parse = (tools.demo_guarded.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
    assert({ given: 'input the validator rejects', should: 'also fail safeParse', actual: parse({ bad: true }).success, expected: false });
  });
});

const denyNoReasonRow: GitToolRow = defineRow({
  key: 'demo_deny_plain',
  group: 'repo',
  cmd: 'git',
  exec: 'local',
  description: 'demo',
  schema: z.object({}).strict(),
  buildArgs: () => ({ error: 'plain denial' }),
});

describe('generateSandboxGitTools — buildArgs denial', () => {
  test('a buildArgs error denies with its reason and no seam call', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([denyingRow], seams);
    const result = await tools.demo_deny.execute!({ path: '../escape' }, {} as never);
    assert({ given: 'a buildArgs path_escape', should: 'return the reason and touch no seam', actual: (result as { success: boolean; reason?: string }).reason === 'path_escape' && calls.length === 0, expected: true });
  });
  test('a buildArgs error WITHOUT a reason still denies without a reason field', async () => {
    const { seams, calls } = makeSeams();
    const tools = generateSandboxGitTools([denyNoReasonRow], seams);
    const result = await tools.demo_deny_plain.execute!({}, {} as never);
    assert({ given: 'a reasonless buildArgs error', should: 'return success:false with no reason and no seam call', actual: (result as { success: boolean; reason?: string }).success === false && !('reason' in (result as object)) && calls.length === 0, expected: true });
  });
});

describe('deriveToolNames', () => {
  test('derives exactly the 56 row keys', () => {
    assert({ given: 'the real tool rows', should: 'derive 56 unique names', actual: deriveToolNames(SANDBOX_GIT_TOOL_ROWS).length, expected: 56 });
  });
  test('names are unique', () => {
    const names = deriveToolNames(SANDBOX_GIT_TOOL_ROWS);
    assert({ given: 'the derived names', should: 'have no duplicates', actual: new Set(names).size, expected: names.length });
  });
});

describe('real rows honor the exec contract', () => {
  test('every row cmd is a literal git or gh', () => {
    assert({ given: 'all rows', should: 'use only git/gh', actual: SANDBOX_GIT_TOOL_ROWS.every((r) => r.cmd === 'git' || r.cmd === 'gh'), expected: true });
  });
  test('every row exec is local or token', () => {
    assert({ given: 'all rows', should: 'use only local/token', actual: SANDBOX_GIT_TOOL_ROWS.every((r) => r.exec === 'local' || r.exec === 'token'), expected: true });
  });
  test('gh_search keeps its "--" separator immediately before the query', () => {
    const row = SANDBOX_GIT_TOOL_ROWS.find((r) => r.key === 'gh_search')!;
    const built = row.buildArgs({ type: 'code', query: '-1 x' });
    const args = 'args' in built ? built.args : [];
    const dd = args.indexOf('--');
    assert({ given: 'a leading-hyphen query', should: 'place it right after "--"', actual: dd > -1 && args[dd + 1] === '-1 x' && dd === args.length - 2, expected: true });
  });
});
