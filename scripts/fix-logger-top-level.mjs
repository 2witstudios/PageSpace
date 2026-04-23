/**
 * Add 'logger' export to vi.mock('@pagespace/lib/logging/logger-config')
 * mocks that are missing it, using balanced-parens parsing to insert at
 * the correct top level (not inside nested vi.fn blocks).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readdirSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const LOGGER_LINE = `  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },`;

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

/**
 * Find the position of the end of the top-level vi.mock call starting at `start`.
 * Returns the index of the final ')' that closes the vi.mock call.
 */
function findMockCallEnd(content, start) {
  let depth = 0;
  let i = start;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string content
      const quote = ch;
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === quote) break;
        i++;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Find the position of the top-level factory object's closing brace inside the vi.mock call.
 * The vi.mock structure is: vi.mock('path', () => ({ ... }))
 * We want the index of the '}' that closes the factory object (just before the final `)`).
 */
function findFactoryObjectEnd(content, mockStart, mockEnd) {
  // The mock ends with })) - the last ) is at mockEnd
  // Walk backwards from mockEnd to find the matching {
  // Structure: vi.mock(..., () => ({ ...BODY... }))
  // mockEnd is the outer )
  // mockEnd-1 is )  <- closes the factory function call `() => (...)`
  // mockEnd-2 is }  <- closes the factory object
  // We need to find the position just before this final `}` to insert our line

  let i = mockEnd;
  // Go back to find the `}` that closes the factory object
  let depth = 0;
  while (i >= mockStart) {
    const ch = content[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth < 0) break;
    }
    if (ch === '}' && depth <= 1) {
      return i; // This is the closing brace of the factory object
    }
    i--;
  }
  return -1;
}

const targetFiles = [
  'apps/web/src/app/api/cron/calendar-triggers/__tests__/route.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/agent-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/calendar-write-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/channel-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/drive-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/page-read-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/page-write-tools.test.ts',
  'apps/web/src/lib/ai/tools/__tests__/web-search-tools.test.ts',
  'apps/web/src/lib/workflows/__tests__/task-trigger-helpers.test.ts',
];

let fixedCount = 0;
for (const relPath of targetFiles) {
  const filePath = join(ROOT, relPath);
  const content = readFileSync(filePath, 'utf8');

  const mockMarker = "vi.mock('@pagespace/lib/logging/logger-config'";
  const mockStart = content.indexOf(mockMarker);
  if (mockStart === -1) continue;

  const mockEnd = findMockCallEnd(content, mockStart);
  if (mockEnd === -1) continue;

  const mockBlock = content.slice(mockStart, mockEnd + 1);

  // Check if logger: is already there
  if (/\blogger\s*:/.test(mockBlock)) {
    console.log('Already has logger:', relPath);
    continue;
  }

  // Find the closing brace of the factory object
  // The factory object ends with `\n}` just before the final `))`
  // We want to insert our logger line before this `}`

  // Strategy: find the last `\n}` before `))` at the end of mockBlock
  // The mock ends with: ...last property,\n}))
  // or: ...last property\n}))

  const insertPattern = /(\n)([ \t]*\}\)\))$/;
  if (!insertPattern.test(mockBlock)) {
    console.log('Could not find insert point:', relPath);
    continue;
  }

  const newMockBlock = mockBlock.replace(insertPattern, (match, newline, closing) => {
    return `\n${LOGGER_LINE}\n${closing}`;
  });

  const fixed = content.slice(0, mockStart) + newMockBlock + content.slice(mockEnd + 1);
  writeFileSync(filePath, fixed);
  fixedCount++;
  console.log('Fixed:', relPath);
}

console.log(`\nTotal fixed: ${fixedCount}`);
