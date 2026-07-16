import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  optArg,
  optFlag,
  csvFlag,
  buildGhJsonFlag,
  buildApiKvArgs,
} from '../arg-builders';

// Argv-construction primitives that replace the 120+ ad-hoc conditional spreads
// and 9 `list.join(',')` copies. buildApiKvArgs is the injection-containment seam
// for `gh api -f`: a value must stay a single argv element even with `=`/newline.

describe('optArg', () => {
  test('present value emits flag + value', () => {
    assert({ given: 'a present value', should: 'emit [flag, value]', actual: optArg('--base', 'main'), expected: ['--base', 'main'] });
  });
  test('undefined value emits nothing', () => {
    assert({ given: 'an undefined value', should: 'emit []', actual: optArg('--base', undefined), expected: [] });
  });
  test('empty-string value emits nothing (truthiness match)', () => {
    assert({ given: 'an empty-string value', should: 'emit [] — preserves the `x ? [flag,x] : []` idiom', actual: optArg('--base', ''), expected: [] });
  });
});

describe('optFlag', () => {
  test('true condition emits the flag', () => {
    assert({ given: 'a true condition', should: 'emit [flag]', actual: optFlag('--cached', true), expected: ['--cached'] });
  });
  test('false condition emits nothing', () => {
    assert({ given: 'a false condition', should: 'emit []', actual: optFlag('--cached', false), expected: [] });
  });
  test('undefined condition emits nothing', () => {
    assert({ given: 'an undefined condition', should: 'emit []', actual: optFlag('--cached', undefined), expected: [] });
  });
});

describe('csvFlag', () => {
  test('non-empty list joins with comma', () => {
    assert({ given: 'a non-empty list', should: 'emit [flag, "a,b"]', actual: csvFlag('--label', ['a', 'b']), expected: ['--label', 'a,b'] });
  });
  test('single-element list', () => {
    assert({ given: 'a single-element list', should: 'emit [flag, "a"]', actual: csvFlag('--label', ['a']), expected: ['--label', 'a'] });
  });
  test('empty list emits nothing', () => {
    assert({ given: 'an empty list', should: 'emit []', actual: csvFlag('--label', []), expected: [] });
  });
  test('undefined list emits nothing', () => {
    assert({ given: 'an undefined list', should: 'emit []', actual: csvFlag('--label', undefined), expected: [] });
  });
});

describe('buildGhJsonFlag', () => {
  test('joins fields into a --json arg', () => {
    assert({ given: 'a list of fields', should: 'emit ["--json", "a,b,c"]', actual: buildGhJsonFlag(['a', 'b', 'c']), expected: ['--json', 'a,b,c'] });
  });
  test('single field', () => {
    assert({ given: 'a single field', should: 'emit ["--json", "a"]', actual: buildGhJsonFlag(['a']), expected: ['--json', 'a'] });
  });
});

describe('buildApiKvArgs', () => {
  test('builds an -f key=value pair', () => {
    assert({ given: 'a -f key/value', should: 'emit ["-f", "key=value"]', actual: buildApiKvArgs('-f', 'body', 'hello'), expected: ['-f', 'body=hello'] });
  });
  test('builds an -F raw pair for numbers', () => {
    assert({ given: 'a -F key/number', should: 'stringify the number into one element', actual: buildApiKvArgs('-F', 'line', 10), expected: ['-F', 'line=10'] });
  });
  test('a value containing "=" stays a single argv element', () => {
    assert({ given: 'a value containing "="', should: 'keep it a single element (no split)', actual: buildApiKvArgs('-f', 'body', 'a=b=c'), expected: ['-f', 'body=a=b=c'] });
  });
  test('a value containing a newline stays a single argv element', () => {
    assert({ given: 'a value containing a newline', should: 'keep it a single element', actual: buildApiKvArgs('-f', 'body', 'line1\nline2'), expected: ['-f', 'body=line1\nline2'] });
  });
});
