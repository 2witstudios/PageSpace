/**
 * Fix broken logger injection: when logger: was inserted inside a nested vi.fn block
 * instead of at the top level of the vi.mock factory object.
 *
 * Broken pattern:
 *   debug: vi.fn(),
 *       <blank>
 *   logger: { child: ... },
 * })),
 *
 * Fixed pattern:
 *   debug: vi.fn(),
 *       })),
 *
 * Plus: ensure logger: is present at the correct top level.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readdirSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CHILD_FN = `vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))`;

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

// Balanced match: find the full vi.mock call
function findMockEnd(content, start) {
  let depth = 0;
  let i = start;
  while (i < content.length) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const testFiles = getAllFiles(join(ROOT, 'apps'));
let fixedCount = 0;

for (const filePath of testFiles) {
  const content = readFileSync(filePath, 'utf8');

  if (!content.includes("@pagespace/lib/logging/logger-config")) continue;

  // Find the broken pattern: logger: line followed by })), inside a vi.fn block
  // The exact broken sequence is:
  //   debug: vi.fn(),\n<whitespace>\n<whitespace>logger: { child: ...\n<whitespace>})),
  const brokenRe = /([ \t]+debug: vi\.fn\(\),\n)([ \t]*\n)([ \t]+logger: \{ child: [^\n]+\},\n)([ \t]*\}\)\),)/g;

  if (!brokenRe.test(content)) continue;
  brokenRe.lastIndex = 0;

  let fixed = content;

  // Step 1: Remove the broken logger line from inside the vi.fn block
  // and fix the })), closing
  fixed = fixed.replace(brokenRe, (match, debugLine, blankLine, loggerLine, closeParen) => {
    // Extract indentation from closeParen to know the right indent for }))
    const fnCloseIndent = closeParen.match(/^([ \t]*)/)?.[1] ?? '      ';
    return `${debugLine}${fnCloseIndent}})),\n`;
  });

  // Step 2: Add logger: at the correct top level of the vi.mock factory
  // Find the logger-config mock and add logger: before the final }))
  const mockStart = fixed.indexOf("vi.mock('@pagespace/lib/logging/logger-config'");
  if (mockStart === -1) continue;

  const mockEnd = findMockEnd(fixed, mockStart);
  if (mockEnd === -1) continue;

  const mockBlock = fixed.slice(mockStart, mockEnd + 1);

  // Check if logger: is already at a top-level position (not inside nested fn).
  // Use a loose indent pattern to handle 2-space, 4-space, or tab indentation.
  if (/^\s+logger\s*:/m.test(mockBlock)) {
    // Already has it at correct level
    writeFileSync(filePath, fixed);
    fixedCount++;
    const rel = filePath.replace(ROOT, '');
    console.log('Fixed (removed broken injection):', rel);
    continue;
  }

  // Add logger: before the final }))
  // The final })) in the mock block is the last 3 chars
  const insertPoint = mockEnd - 1; // before the final )
  // Walk back to find the }); that closes the factory object
  // The mockBlock ends with })) - insert before }}
  const newMockBlock = mockBlock.replace(
    /(\n[ \t]*\}\)\))$/,
    (_, closing) => {
      const needsComma = !mockBlock.slice(0, mockBlock.length - closing.length).trimEnd().endsWith(',');
      return `${needsComma ? ',' : ''}\n  logger: { child: ${CHILD_FN} },\n}))`;
    }
  );

  if (newMockBlock !== mockBlock) {
    fixed = fixed.slice(0, mockStart) + newMockBlock + fixed.slice(mockEnd + 1);
    writeFileSync(filePath, fixed);
    fixedCount++;
    const rel = filePath.replace(ROOT, '');
    console.log('Fixed:', rel);
  }
}

console.log(`\nTotal fixed: ${fixedCount}`);
