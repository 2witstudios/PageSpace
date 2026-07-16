import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { SANDBOX_GIT_TOOL_ROWS } from '../../tools/registry';
import type { GitToolRow } from '../../tools/types';

// Every row's validator is a new pure precondition wired into both the schema
// and execute. This exercises BOTH outcomes of each validated row so no
// validate branch is left untested, and confirms buildArgs produces string[]
// for a representative input per row.

function rowFor(key: string): GitToolRow {
  const row = SANDBOX_GIT_TOOL_ROWS.find((r) => r.key === key);
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

// { key, pass, fail } — pass makes validate return ok, fail makes it return error.
const VALIDATED: Array<{ key: string; pass: unknown; fail: unknown }> = [
  { key: 'git_clone', pass: { repo_url: 'https://github.com/o/r.git' }, fail: { repo_url: 'git@github.com:o/r.git' } },
  { key: 'git_remote_add', pass: { name: 'origin', url: 'https://x/r.git' }, fail: { name: 'origin', url: 'http://x/r.git' } },
  { key: 'git_add', pass: { all: true }, fail: {} },
  { key: 'git_commit', pass: { message: 'm' }, fail: { message: '' } },
  { key: 'git_show', pass: { ref: 'abc' }, fail: { ref: '--exec=x' } },
  { key: 'git_blame', pass: { path: 'a.ts', start_line: 1, end_line: 2 }, fail: { path: 'a.ts', start_line: 1 } },
  { key: 'git_merge', pass: { branch: 'f' }, fail: {} },
  { key: 'git_rebase', pass: { branch_or_ref: 'f' }, fail: {} },
  { key: 'git_revert', pass: { sha: 'abcd' }, fail: { sha: 'HEAD' } },
  { key: 'git_branch', pass: { action: 'list' }, fail: { action: 'delete' } },
  { key: 'git_checkout', pass: { ref: 'main' }, fail: { ref: '--detach' } },
  { key: 'git_push', pass: { branch: 'feature' }, fail: { force: true, branch: 'main' } },
  { key: 'gh_pr_create', pass: { title: 't', body: 'b' }, fail: { title: '', body: 'b' } },
  { key: 'gh_pr_review_comment', pass: { number: 1, body: 'b', path: 'a.ts', commit_id: 'abc' }, fail: { number: 1, body: '' } },
  { key: 'gh_pr_comment', pass: { number: 1, body: 'b' }, fail: { number: 1, body: '' } },
  { key: 'gh_pr_edit', pass: { number: 1, title: 't' }, fail: { number: 1 } },
  { key: 'gh_pr_thread_resolve', pass: { thread_id: 'x' }, fail: { thread_id: '' } },
  { key: 'gh_workflow_run', pass: { workflow: 'ci.yml', ref: 'main' }, fail: { workflow: '--x', ref: 'main' } },
  { key: 'gh_issue_create', pass: { title: 't', body: 'b' }, fail: { title: '', body: 'b' } },
  { key: 'gh_issue_comment', pass: { number: 1, body: 'b' }, fail: { number: 1, body: '' } },
  { key: 'gh_issue_edit', pass: { number: 1, title: 't' }, fail: { number: 1 } },
  { key: 'gh_repo_view', pass: { repo: 'o/r' }, fail: { repo: '--help' } },
  { key: 'gh_repo_list', pass: { owner: 'acme' }, fail: { owner: '--limit=9' } },
  { key: 'gh_repo_fork', pass: { repo: 'o/r' }, fail: { repo: '--clone' } },
  { key: 'gh_repo_create', pass: { name: 'tool', visibility: 'private' }, fail: { name: '--x', visibility: 'private' } },
  { key: 'gh_search', pass: { type: 'code', query: 'q' }, fail: { type: 'code', query: '' } },
];

describe('row validators — both outcomes', () => {
  for (const { key, pass, fail } of VALIDATED) {
    test(`${key} validate accepts a valid input`, () => {
      const row = rowFor(key);
      assert({ given: `a valid ${key} input`, should: 'pass validate', actual: row.validate!(pass).ok, expected: true });
    });
    test(`${key} validate rejects an invalid input`, () => {
      const row = rowFor(key);
      assert({ given: `an invalid ${key} input`, should: 'fail validate', actual: row.validate!(fail).ok, expected: false });
    });
  }
});

describe('row validators — extra branches', () => {
  test('git_show with no ref passes (undefined short-circuit)', () => {
    assert({ given: 'git_show with no ref', should: 'pass validate', actual: rowFor('git_show').validate!({}).ok, expected: true });
  });
  test('gh_repo_view with no repo passes (undefined short-circuit)', () => {
    assert({ given: 'gh_repo_view with no repo', should: 'pass validate', actual: rowFor('gh_repo_view').validate!({}).ok, expected: true });
  });
  test('gh_repo_list with no owner passes (undefined short-circuit)', () => {
    assert({ given: 'gh_repo_list with no owner', should: 'pass validate', actual: rowFor('gh_repo_list').validate!({}).ok, expected: true });
  });
  test('git_merge abort passes without a branch', () => {
    assert({ given: 'git_merge abort', should: 'pass validate (positional ignored)', actual: rowFor('git_merge').validate!({ action: 'abort' }).ok, expected: true });
  });
  test('git_rebase continue passes without a ref', () => {
    assert({ given: 'git_rebase continue', should: 'pass validate', actual: rowFor('git_rebase').validate!({ action: 'continue' }).ok, expected: true });
  });
  test('git_revert abort passes without a sha', () => {
    assert({ given: 'git_revert abort', should: 'pass validate', actual: rowFor('git_revert').validate!({ action: 'abort' }).ok, expected: true });
  });
  test('git_merge run without a branch fails on the required check', () => {
    assert({ given: 'git_merge run, no branch', should: 'fail validate', actual: rowFor('git_merge').validate!({}).ok, expected: false });
  });
  test('git_merge run with a flag-like branch fails on flag-safety', () => {
    assert({ given: 'git_merge run, --flag branch', should: 'fail validate', actual: rowFor('git_merge').validate!({ branch: '--x' }).ok, expected: false });
  });
  test('git_rebase run with a flag-like ref fails on flag-safety', () => {
    assert({ given: 'git_rebase run, --flag ref', should: 'fail validate', actual: rowFor('git_rebase').validate!({ branch_or_ref: '--x' }).ok, expected: false });
  });
  test('git_revert run without a sha fails on the required check', () => {
    assert({ given: 'git_revert run, no sha', should: 'fail validate', actual: rowFor('git_revert').validate!({}).ok, expected: false });
  });
  test('gh_repo_fork with no repo fails on the required check', () => {
    assert({ given: 'gh_repo_fork, no repo', should: 'fail validate', actual: rowFor('gh_repo_fork').validate!({ repo: '' }).ok, expected: false });
  });
  test('gh_workflow_run missing ref fails', () => {
    assert({ given: 'gh_workflow_run, no ref', should: 'fail validate', actual: rowFor('gh_workflow_run').validate!({ workflow: 'ci.yml', ref: '' }).ok, expected: false });
  });
  test('gh_workflow_run bad input name fails', () => {
    assert({ given: 'gh_workflow_run, bad input key', should: 'fail validate', actual: rowFor('gh_workflow_run').validate!({ workflow: 'ci.yml', ref: 'main', inputs: { 'a=b': 'x' } }).ok, expected: false });
  });
  test('gh_repo_create missing visibility fails (defense-in-depth)', () => {
    assert({ given: 'gh_repo_create with a valid name but no visibility', should: 'fail validate rather than fall through to --public', actual: rowFor('gh_repo_create').validate!({ name: 'tool' }).ok, expected: false });
  });
  test('gh_repo_create invalid name fails before the visibility check', () => {
    assert({ given: 'gh_repo_create with a flag-like name', should: 'fail validate on the name', actual: rowFor('gh_repo_create').validate!({ name: '--x', visibility: 'private' }).ok, expected: false });
  });
  test('git_branch create with a valid name passes', () => {
    assert({ given: 'git_branch create with a normal name', should: 'pass validate', actual: rowFor('git_branch').validate!({ action: 'create', name: 'feature' }).ok, expected: true });
  });
  test('git_branch create with a flag-like name fails', () => {
    assert({ given: 'git_branch create with --contains', should: 'fail validate on flag-safety', actual: rowFor('git_branch').validate!({ action: 'create', name: '--contains' }).ok, expected: false });
  });
  test('git_branch list ignores name entirely', () => {
    assert({ given: 'git_branch list with a flag-like name', should: 'pass validate (name unused in list)', actual: rowFor('git_branch').validate!({ action: 'list', name: '--x' }).ok, expected: true });
  });
  test('gh_pr_review_comment reply (in_reply_to) needs no path/commit_id', () => {
    assert({ given: 'a reply with only in_reply_to + body', should: 'pass validate', actual: rowFor('gh_pr_review_comment').validate!({ number: 1, body: 'b', in_reply_to: 9 }).ok, expected: true });
  });
  test('gh_pr_review_comment non-reply without path fails', () => {
    assert({ given: 'a non-reply comment with no path', should: 'fail validate — not a valid shape', actual: rowFor('gh_pr_review_comment').validate!({ number: 1, body: 'b' }).ok, expected: false });
  });
  test('gh_pr_review_comment non-reply with path but no commit_id fails', () => {
    assert({ given: 'a file-attached comment missing commit_id', should: 'fail validate', actual: rowFor('gh_pr_review_comment').validate!({ number: 1, body: 'b', path: 'a.ts' }).ok, expected: false });
  });
  test('gh_pr_review_comment empty body fails before the shape checks', () => {
    assert({ given: 'an empty body', should: 'fail on the body check', actual: rowFor('gh_pr_review_comment').validate!({ number: 1, body: '', path: 'a.ts', commit_id: 'c' }).ok, expected: false });
  });
});

describe('at-least-one-field validators — each operand', () => {
  // Each single-field input makes a different arm of the `||` chain the one that
  // passes, covering every short-circuit branch.
  const prEdit = rowFor('gh_pr_edit');
  for (const field of [
    { body: 'b' },
    { base: 'main' },
    { add_labels: ['x'] },
    { remove_labels: ['x'] },
    { add_reviewers: ['x'] },
  ]) {
    test(`gh_pr_edit passes with only ${Object.keys(field)[0]}`, () => {
      assert({ given: `only ${Object.keys(field)[0]}`, should: 'pass validate', actual: prEdit.validate!({ number: 1, ...field }).ok, expected: true });
    });
  }
  const issueEdit = rowFor('gh_issue_edit');
  for (const field of [
    { body: 'b' },
    { add_labels: ['x'] },
    { remove_labels: ['x'] },
    { add_assignees: ['x'] },
    { remove_assignees: ['x'] },
  ]) {
    test(`gh_issue_edit passes with only ${Object.keys(field)[0]}`, () => {
      assert({ given: `only ${Object.keys(field)[0]}`, should: 'pass validate', actual: issueEdit.validate!({ number: 1, ...field }).ok, expected: true });
    });
  }
});

// A representative valid input for every row, so buildArgs is invoked once per
// tool — covers the argv wrappers the sampled call-shape suite doesn't reach.
const BUILD_INPUTS: Record<string, unknown> = {
  git_clone: { repo_url: 'https://x/r.git', depth: 1 },
  git_init: {},
  git_config: { key: 'user.name', value: 'Bot', global: true },
  git_remote_add: { name: 'origin', url: 'https://x/r.git' },
  git_status: { path: 'a' },
  git_diff: { base: 'origin/main', head: 'HEAD', path: 'a' },
  git_add: { paths: ['a'] },
  git_reset: { mode: 'hard', ref: 'HEAD~1' },
  git_stash: { action: 'push', message: 'wip' },
  git_commit: { message: 'm', amend: true },
  git_log: { n: 5, path: 'a', oneline: false },
  git_show: { ref: 'abc', stat: true, path: 'a' },
  git_blame: { path: 'a', start_line: 1, end_line: 2 },
  git_merge: { branch: 'f', strategy: 'squash' },
  git_rebase: { branch_or_ref: 'f' },
  git_revert: { sha: 'abcd', mainline: 1 },
  git_checkout: { ref: 'f', create: true },
  git_branch: { action: 'delete', name: 'f' },
  git_fetch: { remote: 'up', branch: 'main' },
  git_pull: { remote: 'up', branch: 'main', rebase: true },
  git_push: { branch: 'f', force: true, set_upstream: false },
  gh_pr_create: { title: 't', body: 'b', base: 'main', head: 'f', draft: true, labels: ['x'] },
  gh_pr_list: { state: 'merged', limit: 5 },
  gh_pr_view: { number: 1 },
  gh_pr_diff: { number: 1 },
  gh_pr_checks: { number: 1 },
  gh_pr_merge: { number: 1, strategy: 'squash' },
  gh_pr_checkout: { number: 1 },
  gh_pr_review: { number: 1, action: 'approve', body: 'ok' },
  gh_pr_review_comment: { number: 1, body: 'b', path: 'a', line: 1, side: 'RIGHT', commit_id: 'c', start_line: 1, start_side: 'RIGHT', in_reply_to: 2, subject_type: 'file' },
  gh_pr_comment: { number: 1, body: 'b' },
  gh_pr_edit: { number: 1, title: 't', body: 'b', base: 'main', add_labels: ['x'], remove_labels: ['y'], add_reviewers: ['z'] },
  gh_pr_update_branch: { number: 1 },
  gh_pr_thread_list: { owner: 'o', repo: 'r', number: 1 },
  gh_pr_thread_resolve: { thread_id: 't' },
  gh_pr_close: { number: 1, comment: 'c' },
  gh_pr_reopen: { number: 1 },
  gh_pr_ready: { number: 1 },
  gh_run_list: { branch: 'b', limit: 5, status: 'completed', event: 'push' },
  gh_run_view: { runId: 1, log: true },
  gh_run_rerun: { runId: 1, failed_only: true },
  gh_workflow_list: { limit: 5 },
  gh_workflow_run: { workflow: 'ci.yml', ref: 'main', inputs: { env: 'staging' } },
  gh_issue_create: { title: 't', body: 'b', labels: ['x'] },
  gh_issue_list: { state: 'all', limit: 5 },
  gh_issue_view: { number: 1 },
  gh_issue_comment: { number: 1, body: 'b' },
  gh_issue_edit: { number: 1, title: 't', body: 'b', add_labels: ['x'], remove_labels: ['y'], add_assignees: ['z'], remove_assignees: ['w'] },
  gh_issue_close: { number: 1, comment: 'c', reason: 'not_planned' },
  gh_issue_reopen: { number: 1 },
  gh_repo_view: { repo: 'o/r' },
  gh_repo_list: { owner: 'acme', limit: 5 },
  gh_repo_fork: { repo: 'o/r' },
  gh_repo_create: { name: 'tool', visibility: 'private', description: 'd' },
  gh_search: { type: 'code', query: 'q', limit: 5 },
  gh_label_list: { repo: 'o/r', limit: 5 },
};

describe('every row buildArgs yields string[] args for a valid input', () => {
  for (const row of SANDBOX_GIT_TOOL_ROWS) {
    test(`${row.key} buildArgs`, () => {
      const built = row.buildArgs(BUILD_INPUTS[row.key]);
      const ok = 'args' in built && Array.isArray(built.args) && built.args.every((a) => typeof a === 'string');
      assert({ given: `a valid ${row.key} input`, should: 'produce string[] args', actual: ok, expected: true });
    });
  }
});

describe('row buildArgs — clone/init path resolution', () => {
  test('git_clone resolves an explicit path', () => {
    const built = rowFor('git_clone').buildArgs({ repo_url: 'https://x/r.git', path: 'repo' });
    assert({ given: 'a clone path', should: 'produce string[] args', actual: 'args' in built && built.args.includes('/workspace/repo'), expected: true });
  });
  test('git_clone denies a path that escapes root', () => {
    const built = rowFor('git_clone').buildArgs({ repo_url: 'https://x/r.git', path: '../../escape' });
    assert({ given: 'an escaping clone path', should: 'return a path_escape denial', actual: 'error' in built && built.reason === 'path_escape', expected: true });
  });
  test('git_init denies a path that escapes root', () => {
    const built = rowFor('git_init').buildArgs({ path: '/etc/foo' });
    assert({ given: 'an escaping init path', should: 'return a path_escape denial', actual: 'error' in built && built.reason === 'path_escape', expected: true });
  });
});
