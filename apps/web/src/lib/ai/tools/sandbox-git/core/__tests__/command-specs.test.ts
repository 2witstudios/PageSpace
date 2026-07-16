import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  buildCloneArgs,
  buildInitArgs,
  buildConfigArgs,
  buildRemoteAddArgs,
} from '../command-specs/repo';
import {
  buildStatusArgs,
  buildDiffArgs,
  buildAddArgs,
  buildResetArgs,
  buildStashArgs,
} from '../command-specs/worktree';
import {
  buildCommitArgs,
  buildLogArgs,
  buildShowArgs,
  buildBlameArgs,
  buildMergeArgs,
  buildRebaseArgs,
  buildRevertArgs,
  buildCheckoutArgs,
  buildBranchArgs,
} from '../command-specs/history';
import { buildFetchArgs, buildPullArgs, buildPushArgs } from '../command-specs/remote';
import {
  buildPrCreateArgs,
  buildPrListArgs,
  buildPrViewArgs,
  buildPrDiffArgs,
  buildPrChecksArgs,
  buildPrMergeArgs,
  buildPrCheckoutArgs,
  buildPrReviewArgs,
  buildPrReviewCommentArgs,
  buildPrCommentArgs,
  buildPrEditArgs,
  buildPrUpdateBranchArgs,
  buildPrThreadListArgs,
  buildPrThreadResolveArgs,
  buildPrCloseArgs,
  buildPrReopenArgs,
  buildPrReadyArgs,
} from '../command-specs/pr';
import {
  buildRunListArgs,
  buildRunViewArgs,
  buildRunRerunArgs,
  buildWorkflowListArgs,
  buildWorkflowRunArgs,
} from '../command-specs/actions';
import {
  buildIssueCreateArgs,
  buildIssueListArgs,
  buildIssueViewArgs,
  buildIssueCommentArgs,
  buildIssueEditArgs,
  buildIssueCloseArgs,
  buildIssueReopenArgs,
} from '../command-specs/issues';
import {
  buildRepoViewArgs,
  buildRepoListArgs,
  buildRepoForkArgs,
  buildRepoCreateArgs,
  buildSearchArgs,
  buildLabelListArgs,
} from '../command-specs/repos-search';

// ── repo ──────────────────────────────────────────────────────────────────
describe('buildCloneArgs', () => {
  test('with depth', () => assert({ given: 'a depth', should: 'emit --no-single-branch --depth N in order', actual: buildCloneArgs({ repoUrl: 'https://x/r.git', path: '/workspace', depth: 1 }), expected: ['clone', '--no-single-branch', '--depth', '1', 'https://x/r.git', '/workspace'] }));
  test('without depth', () => assert({ given: 'no depth', should: 'omit the depth flags', actual: buildCloneArgs({ repoUrl: 'https://x/r.git', path: '/workspace/r' }), expected: ['clone', 'https://x/r.git', '/workspace/r'] }));
});
describe('buildInitArgs', () => {
  test('path', () => assert({ given: 'a resolved path', should: 'emit init <path>', actual: buildInitArgs('/workspace'), expected: ['init', '/workspace'] }));
});
describe('buildConfigArgs', () => {
  test('global', () => assert({ given: 'global: true', should: 'include --global', actual: buildConfigArgs({ key: 'user.name', value: 'Bot', global: true }), expected: ['config', '--global', 'user.name', 'Bot'] }));
  test('local', () => assert({ given: 'no global', should: 'omit --global', actual: buildConfigArgs({ key: 'user.name', value: 'Bot' }), expected: ['config', 'user.name', 'Bot'] }));
});
describe('buildRemoteAddArgs', () => {
  test('adds a remote', () => assert({ given: 'name + url', should: 'emit remote add', actual: buildRemoteAddArgs({ name: 'origin', url: 'https://x/r.git' }), expected: ['remote', 'add', 'origin', 'https://x/r.git'] }));
});

// ── worktree ─────────────────────────────────────────────────────────────
describe('buildStatusArgs', () => {
  test('with path', () => assert({ given: 'a path', should: 'add -- <path>', actual: buildStatusArgs('src'), expected: ['status', '--porcelain', '--', 'src'] }));
  test('no path', () => assert({ given: 'no path', should: 'omit the filter', actual: buildStatusArgs(), expected: ['status', '--porcelain'] }));
});
describe('buildDiffArgs', () => {
  test('base only → three-dot to HEAD', () => assert({ given: 'a base', should: 'three-dot to HEAD', actual: buildDiffArgs({ base: 'origin/master' }), expected: ['diff', 'origin/master...HEAD'] }));
  test('base + head', () => assert({ given: 'base + head', should: 'three-dot to head', actual: buildDiffArgs({ base: 'origin/master', head: 'feat' }), expected: ['diff', 'origin/master...feat'] }));
  test('base + path', () => assert({ given: 'base + path', should: 'add -- path', actual: buildDiffArgs({ base: 'origin/master', path: 'a.ts' }), expected: ['diff', 'origin/master...HEAD', '--', 'a.ts'] }));
  test('staged', () => assert({ given: 'staged', should: 'use --cached', actual: buildDiffArgs({ staged: true }), expected: ['diff', '--cached'] }));
  test('staged + path', () => assert({ given: 'staged + path', should: '--cached and -- path', actual: buildDiffArgs({ staged: true, path: 'a.ts' }), expected: ['diff', '--cached', '--', 'a.ts'] }));
  test('working-tree', () => assert({ given: 'nothing', should: 'plain diff', actual: buildDiffArgs({}), expected: ['diff'] }));
});
describe('buildAddArgs', () => {
  test('all', () => assert({ given: 'all: true', should: 'emit -A', actual: buildAddArgs({ all: true }), expected: ['add', '-A'] }));
  test('paths', () => assert({ given: 'paths', should: 'list the paths', actual: buildAddArgs({ paths: ['a', 'b'] }), expected: ['add', 'a', 'b'] }));
  test('neither (defensive)', () => assert({ given: 'no all and no paths', should: 'emit just add', actual: buildAddArgs({}), expected: ['add'] }));
});
describe('buildResetArgs', () => {
  test('mode + ref', () => assert({ given: 'hard + ref', should: '--hard ref', actual: buildResetArgs({ mode: 'hard', ref: 'HEAD~1' }), expected: ['reset', '--hard', 'HEAD~1'] }));
  test('mode only', () => assert({ given: 'soft, no ref', should: 'omit ref', actual: buildResetArgs({ mode: 'soft' }), expected: ['reset', '--soft'] }));
});
describe('buildStashArgs', () => {
  test('push + message', () => assert({ given: 'push + message', should: '-m message', actual: buildStashArgs({ action: 'push', message: 'wip' }), expected: ['stash', 'push', '-m', 'wip'] }));
  test('push no message', () => assert({ given: 'push, no message', should: 'omit -m', actual: buildStashArgs({ action: 'push' }), expected: ['stash', 'push'] }));
  test('list', () => assert({ given: 'list', should: 'stash list', actual: buildStashArgs({ action: 'list' }), expected: ['stash', 'list'] }));
});

// ── history ──────────────────────────────────────────────────────────────
describe('buildCommitArgs', () => {
  test('amend', () => assert({ given: 'amend', should: 'add --amend --no-edit', actual: buildCommitArgs({ message: 'm', amend: true }), expected: ['commit', '-m', 'm', '--amend', '--no-edit'] }));
  test('plain', () => assert({ given: 'no amend', should: 'plain commit', actual: buildCommitArgs({ message: 'm' }), expected: ['commit', '-m', 'm'] }));
});
describe('buildLogArgs', () => {
  test('defaults', () => assert({ given: 'nothing', should: '--oneline -20', actual: buildLogArgs({}), expected: ['log', '--oneline', '-20'] }));
  test('n + path + oneline false', () => assert({ given: 'n, path, oneline:false', should: 'omit --oneline, use -5, -- path', actual: buildLogArgs({ n: 5, path: 'a.ts', oneline: false }), expected: ['log', '-5', '--', 'a.ts'] }));
});
describe('buildShowArgs', () => {
  test('stat + ref + path', () => assert({ given: 'stat, ref, path', should: '--stat ref -- path', actual: buildShowArgs({ ref: 'abc', stat: true, path: 'a.ts' }), expected: ['show', '--stat', 'abc', '--', 'a.ts'] }));
  test('defaults to HEAD', () => assert({ given: 'nothing', should: 'show HEAD', actual: buildShowArgs({}), expected: ['show', 'HEAD'] }));
});
describe('buildBlameArgs', () => {
  test('line range', () => assert({ given: 'start+end', should: '-L range -- path', actual: buildBlameArgs({ path: 'a.ts', start_line: 5, end_line: 20 }), expected: ['blame', '-L', '5,20', '--', 'a.ts'] }));
  test('no range', () => assert({ given: 'no lines', should: 'blame -- path', actual: buildBlameArgs({ path: 'a.ts' }), expected: ['blame', '--', 'a.ts'] }));
});
describe('buildMergeArgs', () => {
  test('abort ignores branch', () => assert({ given: 'action abort with a branch', should: 'ignore the branch — only --abort', actual: buildMergeArgs({ action: 'abort', branch: 'x' }), expected: ['merge', '--abort'] }));
  test('continue', () => assert({ given: 'action continue', should: '--continue', actual: buildMergeArgs({ action: 'continue' }), expected: ['merge', '--continue'] }));
  test('squash', () => assert({ given: 'squash', should: '--squash branch', actual: buildMergeArgs({ branch: 'f', strategy: 'squash' }), expected: ['merge', '--squash', 'f'] }));
  test('ff-only', () => assert({ given: 'ff-only', should: '--ff-only branch', actual: buildMergeArgs({ branch: 'f', strategy: 'ff-only' }), expected: ['merge', '--ff-only', 'f'] }));
  test('plain merge', () => assert({ given: 'no strategy', should: 'merge branch', actual: buildMergeArgs({ branch: 'f' }), expected: ['merge', 'f'] }));
});
describe('buildRebaseArgs', () => {
  test('abort ignores ref', () => assert({ given: 'action abort with a ref', should: 'ignore the ref', actual: buildRebaseArgs({ action: 'abort', branch_or_ref: 'x' }), expected: ['rebase', '--abort'] }));
  test('run', () => assert({ given: 'a ref', should: 'rebase ref', actual: buildRebaseArgs({ branch_or_ref: 'origin/main' }), expected: ['rebase', 'origin/main'] }));
});
describe('buildRevertArgs', () => {
  test('continue ignores sha', () => assert({ given: 'action continue with a sha', should: 'ignore the sha', actual: buildRevertArgs({ action: 'continue', sha: 'abc1234' }), expected: ['revert', '--continue'] }));
  test('run with sha', () => assert({ given: 'a sha', should: 'revert --no-edit sha', actual: buildRevertArgs({ sha: 'abc1234' }), expected: ['revert', '--no-edit', 'abc1234'] }));
  test('run with mainline', () => assert({ given: 'sha + mainline', should: 'add -m N', actual: buildRevertArgs({ sha: 'abc1234', mainline: 1 }), expected: ['revert', '--no-edit', '-m', '1', 'abc1234'] }));
});
describe('buildCheckoutArgs', () => {
  test('create', () => assert({ given: 'create', should: '-b ref', actual: buildCheckoutArgs({ ref: 'feat', create: true }), expected: ['checkout', '-b', 'feat'] }));
  test('switch', () => assert({ given: 'no create', should: 'checkout ref', actual: buildCheckoutArgs({ ref: 'feat' }), expected: ['checkout', 'feat'] }));
});
describe('buildBranchArgs', () => {
  test('list', () => assert({ given: 'list', should: 'branch -a', actual: buildBranchArgs({ action: 'list' }), expected: ['branch', '-a'] }));
  test('delete', () => assert({ given: 'delete', should: 'branch -d name', actual: buildBranchArgs({ action: 'delete', name: 'f' }), expected: ['branch', '-d', 'f'] }));
  test('create', () => assert({ given: 'create', should: 'branch name', actual: buildBranchArgs({ action: 'create', name: 'f' }), expected: ['branch', 'f'] }));
});

// ── remote ───────────────────────────────────────────────────────────────
describe('buildFetchArgs', () => {
  test('defaults', () => assert({ given: 'nothing', should: 'fetch origin', actual: buildFetchArgs({}), expected: ['fetch', 'origin'] }));
  test('remote + branch', () => assert({ given: 'remote+branch', should: 'fetch remote branch', actual: buildFetchArgs({ remote: 'up', branch: 'main' }), expected: ['fetch', 'up', 'main'] }));
});
describe('buildPullArgs', () => {
  test('rebase', () => assert({ given: 'rebase', should: '--rebase origin', actual: buildPullArgs({ rebase: true }), expected: ['pull', '--rebase', 'origin'] }));
  test('plain', () => assert({ given: 'nothing', should: 'pull origin', actual: buildPullArgs({}), expected: ['pull', 'origin'] }));
});
describe('buildPushArgs', () => {
  test('force + upstream default', () => assert({ given: 'force + branch', should: '--force-with-lease -u origin branch', actual: buildPushArgs({ force: true, branch: 'feat' }), expected: ['push', '--force-with-lease', '-u', 'origin', 'feat'] }));
  test('set_upstream false omits -u', () => assert({ given: 'set_upstream false', should: 'omit -u', actual: buildPushArgs({ branch: 'feat', set_upstream: false }), expected: ['push', 'origin', 'feat'] }));
  test('no branch', () => assert({ given: 'nothing', should: '-u origin only', actual: buildPushArgs({}), expected: ['push', '-u', 'origin'] }));
});

// ── pr ───────────────────────────────────────────────────────────────────
describe('buildPrCreateArgs', () => {
  test('full', () => assert({ given: 'base/head/draft/labels', should: 'build all flags', actual: buildPrCreateArgs({ title: 'T', body: 'B', base: 'main', head: 'feat', draft: true, labels: ['bug', 'ui'] }), expected: ['pr', 'create', '--title', 'T', '--body', 'B', '--base', 'main', '--head', 'feat', '--draft', '--label', 'bug,ui'] }));
  test('minimal', () => assert({ given: 'title+body only', should: 'omit optionals', actual: buildPrCreateArgs({ title: 'T', body: 'B' }), expected: ['pr', 'create', '--title', 'T', '--body', 'B'] }));
});
describe('buildPrListArgs', () => {
  test('defaults', () => assert({ given: 'nothing', should: 'open, limit 30', actual: buildPrListArgs({}), expected: ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,state,url,headRefName,createdAt'] }));
  test('explicit', () => assert({ given: 'state+limit', should: 'use them', actual: buildPrListArgs({ state: 'merged', limit: 5 }).slice(0, 6), expected: ['pr', 'list', '--state', 'merged', '--limit', '5'] }));
});
describe('buildPrViewArgs', () => {
  test('with number', () => assert({ given: 'a number', should: 'include it', actual: buildPrViewArgs(42).slice(0, 3), expected: ['pr', 'view', '42'] }));
  test('no number', () => assert({ given: 'no number', should: 'omit it', actual: buildPrViewArgs().slice(0, 2), expected: ['pr', 'view'] }));
});
describe('buildPrDiffArgs', () => {
  test('with number', () => assert({ given: 'a number', should: 'pr diff N --color never', actual: buildPrDiffArgs(42), expected: ['pr', 'diff', '42', '--color', 'never'] }));
  test('no number', () => assert({ given: 'no number', should: 'omit the number', actual: buildPrDiffArgs(), expected: ['pr', 'diff', '--color', 'never'] }));
});
describe('buildPrChecksArgs', () => {
  test('with number', () => assert({ given: 'a number', should: 'include it', actual: buildPrChecksArgs(42).slice(0, 3), expected: ['pr', 'checks', '42'] }));
  test('no number', () => assert({ given: 'no number', should: 'omit it', actual: buildPrChecksArgs().slice(0, 2), expected: ['pr', 'checks'] }));
});
describe('buildPrMergeArgs', () => {
  test('squash', () => assert({ given: 'squash', should: '--squash --auto', actual: buildPrMergeArgs({ number: 1, strategy: 'squash' }), expected: ['pr', 'merge', '1', '--squash', '--auto'] }));
  test('rebase', () => assert({ given: 'rebase', should: '--rebase', actual: buildPrMergeArgs({ number: 1, strategy: 'rebase' }), expected: ['pr', 'merge', '1', '--rebase', '--auto'] }));
  test('merge, no number', () => assert({ given: 'merge, no number', should: '--merge --auto', actual: buildPrMergeArgs({ strategy: 'merge' }), expected: ['pr', 'merge', '--merge', '--auto'] }));
});
describe('buildPrCheckoutArgs', () => {
  test('number', () => assert({ given: 'a number', should: 'pr checkout N', actual: buildPrCheckoutArgs(42), expected: ['pr', 'checkout', '42'] }));
});
describe('buildPrReviewArgs', () => {
  test('approve + body', () => assert({ given: 'approve + body', should: '--approve --body', actual: buildPrReviewArgs({ number: 1, action: 'approve', body: 'LGTM' }), expected: ['pr', 'review', '1', '--approve', '--body', 'LGTM'] }));
  test('request_changes', () => assert({ given: 'request_changes', should: '--request-changes', actual: buildPrReviewArgs({ number: 1, action: 'request_changes' }), expected: ['pr', 'review', '1', '--request-changes'] }));
  test('comment', () => assert({ given: 'comment', should: '--comment', actual: buildPrReviewArgs({ number: 1, action: 'comment' }), expected: ['pr', 'review', '1', '--comment'] }));
});
describe('buildPrReviewCommentArgs', () => {
  test('inline', () => assert({ given: 'path/line/side/commit', should: 'build -f/-F fields', actual: buildPrReviewCommentArgs({ number: 42, body: 'x', path: 'a.ts', line: 10, side: 'RIGHT', commit_id: 'abc' }), expected: ['api', 'repos/{owner}/{repo}/pulls/42/comments', '-f', 'body=x', '-f', 'path=a.ts', '-F', 'line=10', '-f', 'side=RIGHT', '-f', 'commit_id=abc'] }));
  test('multi-line + subject_type', () => assert({ given: 'start_line/start_side/subject_type', should: 'include them', actual: buildPrReviewCommentArgs({ number: 42, body: 'x', start_line: 5, start_side: 'RIGHT', subject_type: 'file' }), expected: ['api', 'repos/{owner}/{repo}/pulls/42/comments', '-f', 'body=x', '-F', 'start_line=5', '-f', 'start_side=RIGHT', '-f', 'subject_type=file'] }));
  test('reply only', () => assert({ given: 'in_reply_to + body', should: 'body + in_reply_to only', actual: buildPrReviewCommentArgs({ number: 42, body: 'x', in_reply_to: 9 }), expected: ['api', 'repos/{owner}/{repo}/pulls/42/comments', '-f', 'body=x', '-F', 'in_reply_to=9'] }));
});
describe('buildPrCommentArgs', () => {
  test('builds comment', () => assert({ given: 'number + body', should: 'pr comment N --body', actual: buildPrCommentArgs({ number: 42, body: 'hi' }), expected: ['pr', 'comment', '42', '--body', 'hi'] }));
});
describe('buildPrEditArgs', () => {
  test('all fields', () => assert({ given: 'title/body/base/labels/reviewers', should: 'build all', actual: buildPrEditArgs({ number: 42, title: 'T', body: 'B', base: 'main', add_labels: ['bug'], remove_labels: ['wip'], add_reviewers: ['oct'] }), expected: ['pr', 'edit', '42', '--title', 'T', '--body', 'B', '--base', 'main', '--add-label', 'bug', '--remove-label', 'wip', '--add-reviewer', 'oct'] }));
  test('empty-string title kept (!== undefined)', () => assert({ given: 'title: ""', should: 'still emit --title ""', actual: buildPrEditArgs({ number: 42, title: '' }), expected: ['pr', 'edit', '42', '--title', ''] }));
  test('no fields', () => assert({ given: 'just number', should: 'only pr edit N', actual: buildPrEditArgs({ number: 42 }), expected: ['pr', 'edit', '42'] }));
});
describe('buildPrUpdateBranchArgs', () => {
  test('builds', () => assert({ given: 'a number', should: 'pr update-branch N', actual: buildPrUpdateBranchArgs(42), expected: ['pr', 'update-branch', '42'] }));
});
describe('buildPrThreadListArgs', () => {
  test('vars as flags, not interpolated', () => {
    const args = buildPrThreadListArgs({ owner: 'acme', repo: 'web', number: 42 });
    const q = args[args.indexOf('-f') + 1];
    assert({ given: 'owner/repo/number', should: 'pass vars as flags and keep the query literal', actual: q.startsWith('query=') && !q.includes('acme') && args.includes('owner=acme') && args.includes('repo=web') && args.includes('number=42'), expected: true });
  });
});
describe('buildPrThreadResolveArgs', () => {
  test('fixed mutation + threadId flag', () => {
    const args = buildPrThreadResolveArgs('PRRT_x');
    const q = args[args.indexOf('-f') + 1];
    assert({ given: 'a thread id', should: 'use the fixed mutation and pass threadId as a flag', actual: q.includes('resolveReviewThread') && !q.includes('PRRT_x') && args.includes('threadId=PRRT_x'), expected: true });
  });
});
describe('buildPrCloseArgs', () => {
  test('with comment', () => assert({ given: 'a comment', should: '--comment', actual: buildPrCloseArgs({ number: 42, comment: 'dup' }), expected: ['pr', 'close', '42', '--comment', 'dup'] }));
  test('no comment', () => assert({ given: 'no comment', should: 'omit it', actual: buildPrCloseArgs({ number: 42 }), expected: ['pr', 'close', '42'] }));
});
describe('buildPrReopenArgs', () => {
  test('builds', () => assert({ given: 'a number', should: 'pr reopen N', actual: buildPrReopenArgs(42), expected: ['pr', 'reopen', '42'] }));
});
describe('buildPrReadyArgs', () => {
  test('builds', () => assert({ given: 'a number', should: 'pr ready N', actual: buildPrReadyArgs(42), expected: ['pr', 'ready', '42'] }));
});

// ── actions ──────────────────────────────────────────────────────────────
describe('buildRunListArgs', () => {
  test('defaults', () => assert({ given: 'nothing', should: 'limit 10', actual: buildRunListArgs({}).slice(0, 3), expected: ['run', 'list', '--limit'] }));
  test('filters', () => assert({ given: 'branch/status/event', should: 'include each filter', actual: buildRunListArgs({ branch: 'f', status: 'completed', event: 'push' }).slice(0, 9), expected: ['run', 'list', '--limit', '10', '--branch', 'f', '--status', 'completed', '--event'] }));
});
describe('buildRunViewArgs', () => {
  test('json when no log', () => assert({ given: 'no log', should: 'use --json, not --log-failed', actual: buildRunViewArgs({ runId: 1 }).includes('--json') && !buildRunViewArgs({ runId: 1 }).includes('--log-failed'), expected: true }));
  test('log-failed when log', () => assert({ given: 'log:true', should: 'use --log-failed, not --json', actual: buildRunViewArgs({ runId: 1, log: true }).includes('--log-failed') && !buildRunViewArgs({ runId: 1, log: true }).includes('--json'), expected: true }));
});
describe('buildRunRerunArgs', () => {
  test('failed_only', () => assert({ given: 'failed_only', should: '--failed', actual: buildRunRerunArgs({ runId: 1, failed_only: true }), expected: ['run', 'rerun', '1', '--failed'] }));
  test('all', () => assert({ given: 'no failed_only', should: 'omit --failed', actual: buildRunRerunArgs({ runId: 1 }), expected: ['run', 'rerun', '1'] }));
});
describe('buildWorkflowListArgs', () => {
  test('default limit', () => assert({ given: 'no limit', should: 'limit 50', actual: buildWorkflowListArgs(), expected: ['workflow', 'list', '--limit', '50', '--json', 'id,name,path,state'] }));
});
describe('buildWorkflowRunArgs', () => {
  test('with inputs', () => assert({ given: 'inputs', should: 'flatten to -f k=v', actual: buildWorkflowRunArgs({ workflow: 'ci.yml', ref: 'main', inputs: { env: 'staging' } }), expected: ['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'env=staging'] }));
  test('no inputs', () => assert({ given: 'no inputs', should: 'just workflow + ref', actual: buildWorkflowRunArgs({ workflow: 'ci.yml', ref: 'main' }), expected: ['workflow', 'run', 'ci.yml', '--ref', 'main'] }));
});

// ── issues ───────────────────────────────────────────────────────────────
describe('buildIssueCreateArgs', () => {
  test('with labels', () => assert({ given: 'labels', should: '--label csv', actual: buildIssueCreateArgs({ title: 'T', body: 'B', labels: ['a'] }), expected: ['issue', 'create', '--title', 'T', '--body', 'B', '--label', 'a'] }));
  test('no labels', () => assert({ given: 'no labels', should: 'omit --label', actual: buildIssueCreateArgs({ title: 'T', body: 'B' }), expected: ['issue', 'create', '--title', 'T', '--body', 'B'] }));
});
describe('buildIssueListArgs', () => {
  test('defaults', () => assert({ given: 'nothing', should: 'open, 30', actual: buildIssueListArgs({}).slice(0, 6), expected: ['issue', 'list', '--state', 'open', '--limit', '30'] }));
});
describe('buildIssueViewArgs', () => {
  test('builds', () => assert({ given: 'a number', should: 'issue view N --json', actual: buildIssueViewArgs(7).slice(0, 3), expected: ['issue', 'view', '7'] }));
});
describe('buildIssueCommentArgs', () => {
  test('builds', () => assert({ given: 'number+body', should: 'issue comment N --body', actual: buildIssueCommentArgs({ number: 7, body: 'ok' }), expected: ['issue', 'comment', '7', '--body', 'ok'] }));
});
describe('buildIssueEditArgs', () => {
  test('labels + assignees', () => assert({ given: 'add_labels + add_assignees', should: 'build both', actual: buildIssueEditArgs({ number: 7, add_labels: ['bug'], add_assignees: ['oct'] }), expected: ['issue', 'edit', '7', '--add-label', 'bug', '--add-assignee', 'oct'] }));
  test('title/body defined', () => assert({ given: 'title + body', should: 'emit them', actual: buildIssueEditArgs({ number: 7, title: 'T', body: 'B' }), expected: ['issue', 'edit', '7', '--title', 'T', '--body', 'B'] }));
  test('remove flags', () => assert({ given: 'remove_labels + remove_assignees', should: 'build removes', actual: buildIssueEditArgs({ number: 7, remove_labels: ['x'], remove_assignees: ['y'] }), expected: ['issue', 'edit', '7', '--remove-label', 'x', '--remove-assignee', 'y'] }));
});
describe('buildIssueCloseArgs', () => {
  test('not_planned maps to "not planned"', () => assert({ given: 'reason not_planned + comment', should: 'map to "not planned"', actual: buildIssueCloseArgs({ number: 7, comment: 'dup', reason: 'not_planned' }), expected: ['issue', 'close', '7', '--comment', 'dup', '--reason', 'not planned'] }));
  test('completed reason', () => assert({ given: 'reason completed', should: 'emit completed', actual: buildIssueCloseArgs({ number: 7, reason: 'completed' }), expected: ['issue', 'close', '7', '--reason', 'completed'] }));
  test('no reason', () => assert({ given: 'no reason/comment', should: 'just close', actual: buildIssueCloseArgs({ number: 7 }), expected: ['issue', 'close', '7'] }));
});
describe('buildIssueReopenArgs', () => {
  test('builds', () => assert({ given: 'a number', should: 'issue reopen N', actual: buildIssueReopenArgs(7), expected: ['issue', 'reopen', '7'] }));
});

// ── repos-search ─────────────────────────────────────────────────────────
describe('buildRepoViewArgs', () => {
  test('with repo', () => assert({ given: 'a repo', should: 'include it', actual: buildRepoViewArgs('a/b').slice(0, 3), expected: ['repo', 'view', 'a/b'] }));
  test('no repo', () => assert({ given: 'no repo', should: 'omit it', actual: buildRepoViewArgs().slice(0, 2), expected: ['repo', 'view'] }));
});
describe('buildRepoListArgs', () => {
  test('with owner', () => assert({ given: 'an owner', should: 'include it', actual: buildRepoListArgs({ owner: 'acme' }).slice(0, 3), expected: ['repo', 'list', 'acme'] }));
  test('no owner', () => assert({ given: 'no owner', should: 'omit it', actual: buildRepoListArgs({}).slice(0, 2), expected: ['repo', 'list'] }));
});
describe('buildRepoForkArgs', () => {
  test('builds', () => assert({ given: 'a repo', should: 'fork without clone/remote', actual: buildRepoForkArgs('a/b'), expected: ['repo', 'fork', 'a/b', '--clone=false', '--remote=false'] }));
});
describe('buildRepoCreateArgs', () => {
  test('private + description', () => assert({ given: 'private + description', should: '--private --description', actual: buildRepoCreateArgs({ name: 't', visibility: 'private', description: 'd' }), expected: ['repo', 'create', 't', '--private', '--description', 'd'] }));
  test('public no description', () => assert({ given: 'public, no description', should: '--public only', actual: buildRepoCreateArgs({ name: 't', visibility: 'public' }), expected: ['repo', 'create', 't', '--public'] }));
});
describe('buildSearchArgs', () => {
  test('code fields, query after --', () => assert({ given: 'type code', should: 'code json fields, query after --', actual: buildSearchArgs({ type: 'code', query: '-1 x' }), expected: ['search', 'code', '--limit', '20', '--json', 'repository,path,url', '--', '-1 x'] }));
  test('repos fields', () => assert({ given: 'type repos', should: 'repos json fields', actual: buildSearchArgs({ type: 'repos', query: 'q' })[5], expected: 'fullName,description,url' }));
  test('issues/prs fields', () => assert({ given: 'type prs', should: 'issue-shaped json fields', actual: buildSearchArgs({ type: 'prs', query: 'q' })[5], expected: 'number,title,state,url,repository' }));
});
describe('buildLabelListArgs', () => {
  test('with repo', () => assert({ given: 'a repo', should: '--repo scope', actual: buildLabelListArgs({ repo: 'a/b' }), expected: ['label', 'list', '--repo', 'a/b', '--limit', '50', '--json', 'name,description,color'] }));
  test('no repo', () => assert({ given: 'no repo', should: 'omit --repo', actual: buildLabelListArgs({}), expected: ['label', 'list', '--limit', '50', '--json', 'name,description,color'] }));
});
