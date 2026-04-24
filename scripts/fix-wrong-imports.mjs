/**
 * Fix incorrectly migrated imports:
 * 1. Symbols in monitoring/change-group that should be in monitoring/activity-logger
 * 2. Symbols in content/page-type-validators that should be in content/page-types.config
 * 3. Missing subpath exports in package.json for integrations
 */

import { readFileSync, writeFileSync } from 'fs';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Symbols that belong in activity-logger, not change-group
const ACTIVITY_LOGGER_SYMBOLS = new Set([
  'logActivityWithTx',
  'ActivityOperation',
  'ActivityResourceType',
  'DeferredWorkflowTrigger',
  'logRollbackActivity',
  'getActorInfo',
  'logPageActivity',
  'logDriveActivity',
  'logMessageActivity',
  'logPermissionActivity',
  'logAgentConfigActivity',
  'logMemberActivity',
  'logRoleActivity',
  'logUserActivity',
  'logTokenActivity',
  'logFileActivity',
  'logConversationUndo',
  'ActorInfo',
  'ActivityLogInput',
  'logActivity',
]);

// Symbols that belong in page-types.config, not page-type-validators
const PAGE_TYPES_CONFIG_SYMBOLS = new Set([
  'isFolderPage',
  'isDocumentPage',
  'isFilePage',
  'isAIChatPage',
  'isSheetPage',
  'isCodePage',
  'isCanvasPage',
  'isChannelPage',
  'isTaskListPage',
  'isTerminalPage',
  'getPageTypeEmoji',
  'getDefaultContent',
  'getCreatablePageTypes',
  'getPageTypeConfig',
  'getPageTypeIconName',
  'canPageTypeAcceptUploads',
  'getPageTypeComponent',
  'getLayoutViewType',
  'supportsAI',
  'supportsRealtime',
  'canBeConverted',
  'getPageTypeDisplayName',
  'getPageTypeDescription',
  'PageTypeCapabilities',
  'PageTypeApiValidation',
  'PageTypeConfig',
]);

/**
 * Split a single import block into multiple, routing symbols to correct subpaths.
 * Returns the replacement string.
 */
function splitImportBlock(fullMatch, symbols, fromPath, targetSymbols, targetPath) {
  const inTarget = [];
  const remaining = [];

  for (const sym of symbols) {
    if (targetSymbols.has(sym.name)) {
      inTarget.push(sym);
    } else {
      remaining.push(sym);
    }
  }

  if (inTarget.length === 0) return fullMatch;

  const lines = [];

  // Build target import
  if (inTarget.length > 0) {
    const allType = inTarget.every(s => s.isType);
    const names = inTarget.map(s => {
      const prefix = !allType && s.isType ? 'type ' : '';
      return s.alias ? `${prefix}${s.name} as ${s.alias}` : `${prefix}${s.name}`;
    }).join(', ');
    const kw = allType ? 'import type' : 'import';
    lines.push(`${kw} { ${names} } from '${targetPath}'`);
  }

  // Build remaining import (if any)
  if (remaining.length > 0) {
    const allType = remaining.every(s => s.isType);
    const names = remaining.map(s => {
      const prefix = !allType && s.isType ? 'type ' : '';
      return s.alias ? `${prefix}${s.name} as ${s.alias}` : `${prefix}${s.name}`;
    }).join(', ');
    const kw = allType ? 'import type' : 'import';
    lines.push(`${kw} { ${names} } from '${fromPath}'`);
  }

  return lines.join('\n');
}

/**
 * Parse symbols from an import block's braces content.
 */
function parseSymbols(inner) {
  return inner
    .split(',')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('//'))
    .map(s => {
      const isType = s.startsWith('type ');
      const withoutType = s.replace(/^type\s+/, '');
      const [name, alias] = withoutType.split(/\s+as\s+/).map(p => p.trim());
      return { name, alias: alias || null, isType };
    })
    .filter(s => s.name);
}

function fixFile(filePath, fixes) {
  let source = readFileSync(filePath, 'utf8');
  let modified = source;

  for (const { fromPath, targetSymbols, targetPath } of fixes) {
    // Match imports from fromPath (multi-line)
    const regex = new RegExp(
      `import(\\s+type)?\\s+\\{([^}]+)\\}\\s+from\\s+'${escapeRegExp(fromPath)}'`,
      'gs'
    );

    const blocks = [...modified.matchAll(regex)];
    if (blocks.length === 0) continue;

    // Process in reverse to preserve positions
    for (const block of [...blocks].reverse()) {
      const isTypeImport = Boolean(block[1]);
      const symbols = parseSymbols(block[2]).map(s => ({
        ...s,
        isType: s.isType || isTypeImport,
      }));

      const replacement = splitImportBlock(block[0], symbols, fromPath, targetSymbols, targetPath);
      if (replacement !== block[0]) {
        modified = modified.slice(0, block.index) + replacement + modified.slice(block.index + block[0].length);
      }
    }
  }

  if (modified !== source) {
    writeFileSync(filePath, modified, 'utf8');
    return true;
  }
  return false;
}

// ─── Files to fix ─────────────────────────────────────────────────────────────

const CHANGE_GROUP_FILES = [
  'apps/web/src/app/api/pages/bulk-copy/route.ts',
  'apps/web/src/app/api/pages/bulk-delete/route.ts',
  'apps/web/src/app/api/pages/[pageId]/restore/route.ts',
  'apps/web/src/app/api/pages/bulk-move/route.ts',
  'apps/web/src/lib/ai/tools/page-write-tools.ts',
  'apps/web/src/services/api/rollback-service.ts',
  'apps/web/src/services/api/drive-backup-service.ts',
  'apps/web/src/services/api/page-service.ts',
  'apps/web/src/services/api/page-mutation-service.ts',
];

const PAGE_TYPE_VALIDATORS_FILES = [
  'apps/web/src/components/layout/middle-content/page-views/folder/FolderView.tsx',
  'apps/web/src/components/layout/middle-content/content-header/index.tsx',
  'apps/web/src/components/ai/shared/chat/tool-calls/FileTreeRenderer.tsx',
  'apps/web/src/components/ai/shared/chat/tool-calls/PageTreeRenderer.tsx',
];

const ROOT = new URL('..', import.meta.url).pathname;
let count = 0;

for (const rel of CHANGE_GROUP_FILES) {
  const full = ROOT + rel;
  const changed = fixFile(full, [{
    fromPath: '@pagespace/lib/monitoring/change-group',
    targetSymbols: ACTIVITY_LOGGER_SYMBOLS,
    targetPath: '@pagespace/lib/monitoring/activity-logger',
  }]);
  if (changed) { console.log(`✓ fixed change-group: ${rel}`); count++; }
}

for (const rel of PAGE_TYPE_VALIDATORS_FILES) {
  const full = ROOT + rel;
  const changed = fixFile(full, [{
    fromPath: '@pagespace/lib/content/page-type-validators',
    targetSymbols: PAGE_TYPES_CONFIG_SYMBOLS,
    targetPath: '@pagespace/lib/content/page-types.config',
  }]);
  if (changed) { console.log(`✓ fixed page-type-validators: ${rel}`); count++; }
}

console.log(`\nFixed ${count} files`);
