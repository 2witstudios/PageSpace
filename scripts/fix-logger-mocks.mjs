/**
 * Add 'logger' export to all vi.mock('@pagespace/lib/logging/logger-config', ...)
 * mocks that only have 'loggers' (plural) but are missing 'logger' (singular).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readdirSync, statSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;

function getAllFiles(dir, exts = ['.ts']) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      results.push(...getAllFiles(full, exts));
    } else if (entry.isFile() && exts.some(e => full.endsWith(e)) && full.includes('__tests__')) {
      results.push(full);
    }
  }
  return results;
}

const testFiles = getAllFiles(join(ROOT, 'apps'));
const childFn = `vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))`;

let fixedCount = 0;
for (const filePath of testFiles) {
  const content = readFileSync(filePath, 'utf8');

  // Skip if doesn't mock logger-config
  if (!content.includes("vi.mock('@pagespace/lib/logging/logger-config'")) {
    continue;
  }

  // Skip if already has 'logger:' somewhere in the logger-config mock
  // Find the mock block and check
  const mockIdx = content.indexOf("vi.mock('@pagespace/lib/logging/logger-config'");
  if (mockIdx === -1) continue;

  // Find the end of the mock call (matching parentheses)
  let depth = 0;
  let i = mockIdx;
  let mockEnd = -1;
  while (i < content.length) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) { mockEnd = i; break; }
    }
    i++;
  }

  const mockBlock = content.slice(mockIdx, mockEnd + 1);

  // Skip if the mock already has loggers: (plural — what logger-config exports)
  // or logger: (singular — already injected or manually added)
  if (/\bloggers?\s*:/.test(mockBlock)) continue;

  // Use the paren-bounded mock block to inject precisely before the final }))
  // so we never accidentally inject into a nested vi.fn(() => ({ ... })) call.
  const before = content.slice(0, mockIdx);
  const block = content.slice(mockIdx, mockEnd + 1);
  const after = content.slice(mockEnd + 1);

  // block ends with })) — insert before the final newline+}))
  const newBlock = block.replace(/(\n?[ \t]*\}\)\))$/, (_, closing) => {
    const needsComma = !block.slice(0, block.length - closing.length).trimEnd().endsWith(',');
    return `${needsComma ? ',' : ''}\n  logger: { child: ${childFn} },\n}))`;
  });

  if (newBlock !== block) {
    writeFileSync(filePath, before + newBlock + after);
    fixedCount++;
    const rel = filePath.replace(ROOT, '');
    console.log('Fixed:', rel);
  }
}
console.log(`\nTotal fixed: ${fixedCount}`);
