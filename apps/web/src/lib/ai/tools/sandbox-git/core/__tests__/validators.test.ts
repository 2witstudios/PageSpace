import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  startsLikeFlag,
  validateFlagSafe,
  validateShaOnly,
  validateWorkflowInputNames,
  validateRepoName,
  assertHttps,
} from '../validators';

// Flag-injection, SHA-only, workflow-input-name, repo-name and HTTPS validators
// are the injection-containment layer shared by the ~20 tools that used to each
// carry a hand-rolled copy. Every branch is tested.

describe('startsLikeFlag', () => {
  test('leading hyphen', () => {
    assert({ given: 'a value starting with "-"', should: 'be flag-like', actual: startsLikeFlag('--exec=x'), expected: true });
  });
  test('normal value', () => {
    assert({ given: 'a value not starting with "-"', should: 'not be flag-like', actual: startsLikeFlag('main'), expected: false });
  });
});

describe('validateFlagSafe', () => {
  test('rejects a flag-like value and names the field', () => {
    const r = validateFlagSafe('--exec=whoami', 'ref');
    assert({ given: 'a flag-like ref', should: 'reject with a field-named message', actual: r.ok === false && r.error, expected: 'ref must not start with "-"' });
  });
  test('accepts a safe value', () => {
    assert({ given: 'a non-flag value', should: 'accept', actual: validateFlagSafe('feature', 'branch').ok, expected: true });
  });
});

describe('validateShaOnly', () => {
  test('rejects a 3-char sha (too short)', () => {
    assert({ given: 'a 3-hex-char sha', should: 'reject', actual: validateShaOnly('abc').ok, expected: false });
  });
  test('rejects a 41-char sha (too long)', () => {
    assert({ given: 'a 41-hex-char sha', should: 'reject', actual: validateShaOnly('a'.repeat(41)).ok, expected: false });
  });
  test('rejects uppercase hex', () => {
    assert({ given: 'uppercase hex', should: 'reject — lowercase only', actual: validateShaOnly('ABC123').ok, expected: false });
  });
  test('rejects HEAD (a ref, not a sha)', () => {
    assert({ given: 'the ref HEAD', should: 'reject', actual: validateShaOnly('HEAD').ok, expected: false });
  });
  test('rejects a range a..b', () => {
    assert({ given: 'a range expression a..b', should: 'reject', actual: validateShaOnly('abc123..def456').ok, expected: false });
  });
  test('rejects a flag-like value', () => {
    assert({ given: 'a --flag value', should: 'reject', actual: validateShaOnly('--flag').ok, expected: false });
  });
  test('accepts a minimal 4-char lowercase sha', () => {
    assert({ given: 'a 4-hex-char lowercase sha', should: 'accept', actual: validateShaOnly('abcd').ok, expected: true });
  });
  test('accepts a full 40-char lowercase sha', () => {
    assert({ given: 'a 40-hex-char lowercase sha', should: 'accept', actual: validateShaOnly('a'.repeat(40)).ok, expected: true });
  });
});

describe('validateWorkflowInputNames', () => {
  test('undefined inputs', () => {
    assert({ given: 'no inputs', should: 'accept', actual: validateWorkflowInputNames(undefined).ok, expected: true });
  });
  test('empty inputs', () => {
    assert({ given: 'an empty inputs object', should: 'accept', actual: validateWorkflowInputNames({}).ok, expected: true });
  });
  test('valid keys', () => {
    assert({ given: 'alphanumeric/_/- keys', should: 'accept', actual: validateWorkflowInputNames({ 'env-1': 'a', build_no: 'b' }).ok, expected: true });
  });
  test('rejects a key containing = and reports it', () => {
    const r = validateWorkflowInputNames({ 'a=b': 'x' });
    assert({ given: 'a key containing "="', should: 'reject and name the offending key', actual: r.ok === false && r.error.includes('a=b'), expected: true });
  });
  test('rejects a key containing a space', () => {
    assert({ given: 'a key containing a space', should: 'reject', actual: validateWorkflowInputNames({ 'bad name': 'x' }).ok, expected: false });
  });
  test('rejects a key containing a slash', () => {
    assert({ given: 'a key containing "/"', should: 'reject', actual: validateWorkflowInputNames({ 'a/b': 'x' }).ok, expected: false });
  });
});

describe('validateRepoName', () => {
  test('accepts a normal name', () => {
    assert({ given: 'a name with letters, digits, ., _, -', should: 'accept', actual: validateRepoName('my-tool.v2_x').ok, expected: true });
  });
  test('rejects a leading hyphen (flag injection)', () => {
    assert({ given: 'a name starting with "-"', should: 'reject', actual: validateRepoName('--private').ok, expected: false });
  });
  test('rejects a leading dot', () => {
    assert({ given: 'a name starting with "."', should: 'reject — first char must be a letter or digit', actual: validateRepoName('.hidden').ok, expected: false });
  });
  test('rejects flag-like characters', () => {
    assert({ given: 'a name with "=" and "/"', should: 'reject', actual: validateRepoName('--source=.').ok, expected: false });
  });
});

describe('assertHttps', () => {
  test('accepts an https URL', () => {
    assert({ given: 'an https:// URL', should: 'accept', actual: assertHttps('https://github.com/o/r.git', 'git clone').ok, expected: true });
  });
  test('rejects git@ SSH', () => {
    assert({ given: 'a git@ URL', should: 'reject', actual: assertHttps('git@github.com:o/r.git', 'git clone').ok, expected: false });
  });
  test('rejects ssh://', () => {
    assert({ given: 'an ssh:// URL', should: 'reject', actual: assertHttps('ssh://git@github.com/o/r.git', 'git clone').ok, expected: false });
  });
  test('rejects file://', () => {
    assert({ given: 'a file:// URL', should: 'reject', actual: assertHttps('file:///etc/passwd', 'git clone').ok, expected: false });
  });
  test('rejects http:// and names the operation', () => {
    const r = assertHttps('http://github.com/o/r.git', 'git remote add');
    assert({ given: 'a plaintext http:// URL', should: 'reject with the operation named', actual: r.ok === false && r.error.includes('git remote add'), expected: true });
  });
});
