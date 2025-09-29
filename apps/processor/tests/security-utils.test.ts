import assert from 'node:assert/strict';
import path from 'path';
import {
  sanitizeExtension,
  resolvePathWithin,
  normalizeIdentifier,
  DEFAULT_EXTENSION,
  DEFAULT_IMAGE_EXTENSION,
} from '../src/utils/security';

const results: Array<{ name: string; error?: unknown }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name });
  } catch (error) {
    results.push({ name, error });
  }
}

test('sanitizeExtension keeps safe extension', () => {
  const ext = sanitizeExtension('photo.PNG', DEFAULT_IMAGE_EXTENSION);
  assert.equal(ext, '.png');
});

test('sanitizeExtension falls back on unsafe names', () => {
  const ext = sanitizeExtension('../etc/passwd', DEFAULT_EXTENSION);
  assert.equal(ext, DEFAULT_EXTENSION);
});

test('resolvePathWithin allows safe relative paths', () => {
  const base = path.join(process.cwd(), 'tmp', 'security');
  const resolved = resolvePathWithin(base, 'uploads', 'file.txt');
  assert.ok(resolved);
  assert.ok(resolved!.startsWith(path.resolve(base) + path.sep));
});

test('resolvePathWithin rejects traversal', () => {
  const base = path.join(process.cwd(), 'tmp', 'security');
  const resolved = resolvePathWithin(base, '..', 'evil.txt');
  assert.equal(resolved, null);
});

test('normalizeIdentifier trims and accepts safe values', () => {
  const id = normalizeIdentifier('  user_123  ');
  assert.equal(id, 'user_123');
});

test('normalizeIdentifier rejects unsafe values', () => {
  const id = normalizeIdentifier('../etc/passwd');
  assert.equal(id, null);
});

let failed = false;
for (const result of results) {
  if (result.error) {
    failed = true;
    console.error(`✗ ${result.name}`);
    console.error(result.error);
  } else {
    console.log(`✓ ${result.name}`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('All security utils tests passed');
}
