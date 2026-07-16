import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  DEFAULT_BRANCHES,
  pushDestinationBranch,
  isDeleteRefspec,
  evaluatePushGuard,
} from '../refspec';

// Security-critical: this is the push guard, the injection-adjacent code the
// epic wants to be the MOST-tested in the file. Every branch of every function
// below carries a test.

describe('pushDestinationBranch', () => {
  test('bare branch name (no + , no :)', () => {
    assert({
      given: 'a bare branch name',
      should: 'return the name lowercased',
      actual: pushDestinationBranch('Feature'),
      expected: 'feature',
    });
  });

  test('src:dst refspec', () => {
    assert({
      given: 'a src:dst refspec',
      should: 'return the segment after the last colon',
      actual: pushDestinationBranch('HEAD:main'),
      expected: 'main',
    });
  });

  test('+-prefixed force refspec', () => {
    assert({
      given: 'a +-prefixed force refspec',
      should: 'strip the leading + before resolving the destination',
      actual: pushDestinationBranch('+main'),
      expected: 'main',
    });
  });

  test('fully-qualified refs/heads/ destination', () => {
    assert({
      given: 'a destination of the form refs/heads/<name>',
      should: 'strip the refs/heads/ prefix',
      actual: pushDestinationBranch('feature:refs/heads/master'),
      expected: 'master',
    });
  });

  test('surrounding whitespace and uppercase', () => {
    assert({
      given: 'a destination with surrounding whitespace and uppercase',
      should: 'trim and lowercase before comparison',
      actual: pushDestinationBranch('HEAD: MAIN '),
      expected: 'main',
    });
  });

  test('multiple colons — uses the last', () => {
    assert({
      given: 'a refspec with more than one colon',
      should: 'take the segment after the LAST colon',
      actual: pushDestinationBranch('a:b:feature'),
      expected: 'feature',
    });
  });
});

describe('isDeleteRefspec', () => {
  test('empty-source :dst', () => {
    assert({
      given: 'an empty-source refspec :dst',
      should: 'be recognized as a delete',
      actual: isDeleteRefspec(':main'),
      expected: true,
    });
  });

  test('+:dst (forced delete form)', () => {
    assert({
      given: 'a +:dst refspec',
      should: 'strip the + and still recognize the empty source as a delete',
      actual: isDeleteRefspec('+:main'),
      expected: true,
    });
  });

  test('whitespace-only source', () => {
    assert({
      given: 'a refspec whose source is only whitespace',
      should: 'treat it as a delete after trimming',
      actual: isDeleteRefspec('  :main'),
      expected: true,
    });
  });

  test('normal src:dst is not a delete', () => {
    assert({
      given: 'a src:dst refspec with a non-empty source',
      should: 'not be a delete',
      actual: isDeleteRefspec('HEAD:main'),
      expected: false,
    });
  });

  test('bare branch (no colon) is not a delete', () => {
    assert({
      given: 'a bare branch name with no colon',
      should: 'not be a delete',
      actual: isDeleteRefspec('main'),
      expected: false,
    });
  });
});

describe('DEFAULT_BRANCHES', () => {
  test('contains main and master only', () => {
    assert({
      given: 'the protected default-branch set',
      should: 'contain exactly main and master',
      actual: [...DEFAULT_BRANCHES].sort(),
      expected: ['main', 'master'],
    });
  });
});

describe('evaluatePushGuard', () => {
  test('force to the default branch HEAD:main', () => {
    assert({
      given: 'force: true pushing HEAD:main',
      should: 'reject — a force whose destination is the default branch',
      actual: evaluatePushGuard({ force: true, branch: 'HEAD:main' }).ok,
      expected: false,
    });
  });

  test('force to a fully-qualified default ref', () => {
    assert({
      given: 'force: true pushing feature:refs/heads/master',
      should: 'reject after stripping refs/heads/',
      actual: evaluatePushGuard({ force: true, branch: 'feature:refs/heads/master' }).ok,
      expected: false,
    });
  });

  test('+-prefixed force to default branch without the force flag', () => {
    assert({
      given: 'no force flag but a +main refspec',
      should: 'reject — the + is a per-refspec force',
      actual: evaluatePushGuard({ branch: '+main' }).ok,
      expected: false,
    });
  });

  test('delete of the default branch', () => {
    assert({
      given: 'a delete refspec :main',
      should: 'reject — deleting the default branch is as destructive as a force',
      actual: evaluatePushGuard({ branch: ':main' }).ok,
      expected: false,
    });
  });

  test('force with no branch argument', () => {
    assert({
      given: 'force: true with no branch',
      should: 'reject — the target cannot be verified',
      actual: evaluatePushGuard({ force: true }).ok,
      expected: false,
    });
  });

  test('force with no branch — error names the branch requirement', () => {
    const result = evaluatePushGuard({ force: true });
    assert({
      given: 'force: true with no branch',
      should: 'return the explicit-branch error',
      actual: result.ok === false && result.error.includes('explicit branch'),
      expected: true,
    });
  });

  test('force of a non-default branch', () => {
    assert({
      given: 'force: true pushing a feature branch',
      should: 'allow — the guard protects default branches only',
      actual: evaluatePushGuard({ force: true, branch: 'pu/fix-x' }).ok,
      expected: true,
    });
  });

  test('force whose refspec destination is a feature branch (main:feature)', () => {
    assert({
      given: 'force: true pushing main:feature',
      should: 'allow — the destination, not the source, is what matters',
      actual: evaluatePushGuard({ force: true, branch: 'main:feature' }).ok,
      expected: true,
    });
  });

  test('delete of a non-default branch', () => {
    assert({
      given: 'a delete refspec :feature',
      should: 'allow — only default-branch deletes are refused',
      actual: evaluatePushGuard({ branch: ':feature' }).ok,
      expected: true,
    });
  });

  test('plain non-force push with no branch', () => {
    assert({
      given: 'no force and no branch (push the current branch)',
      should: 'allow',
      actual: evaluatePushGuard({}).ok,
      expected: true,
    });
  });

  test('plain fast-forward push to a branch named main is allowed', () => {
    assert({
      given: 'a non-destructive push to a branch named main',
      should: 'allow — only force/delete of a default branch is refused',
      actual: evaluatePushGuard({ branch: 'main' }).ok,
      expected: true,
    });
  });

  test('force rejection error names the default-branch refusal', () => {
    const result = evaluatePushGuard({ force: true, branch: 'main' });
    assert({
      given: 'a force to main',
      should: 'return the default-branch refusal error',
      actual: result.ok === false && result.error.includes('default branch'),
      expected: true,
    });
  });
});
