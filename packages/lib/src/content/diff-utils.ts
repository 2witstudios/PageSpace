import DiffMatchPatch from 'diff-match-patch';
import { type PageContentFormat, detectPageContentFormat } from './page-content-format';

/**
 * Represents a single change in a diff
 */
export interface DiffChange {
  /** Type of change: 'add', 'remove', or 'unchanged' */
  type: 'add' | 'remove' | 'unchanged';
  /** The content that was added, removed, or unchanged */
  value: string;
  /** Start position in the original content (for remove/unchanged) */
  originalStart?: number;
  /** End position in the original content (for remove/unchanged) */
  originalEnd?: number;
  /** Start position in the new content (for add/unchanged) */
  newStart?: number;
  /** End position in the new content (for add/unchanged) */
  newEnd?: number;
}

/**
 * Result of comparing two content versions
 */
export interface DiffResult {
  /** The detected or specified format of the content */
  format: PageContentFormat;
  /** Array of changes between the two versions */
  changes: DiffChange[];
  /** Summary statistics about the diff */
  stats: DiffStats;
  /** Whether the two contents are identical */
  isIdentical: boolean;
}

/**
 * Statistics about a diff result
 */
export interface DiffStats {
  /** Number of added characters/lines */
  additions: number;
  /** Number of removed characters/lines */
  deletions: number;
  /** Number of unchanged characters/lines */
  unchanged: number;
  /** Total number of changes (add + remove operations) */
  totalChanges: number;
}

/**
 * Options for diff generation
 */
export interface DiffOptions {
  /** Content format to use. If not provided, will be auto-detected */
  format?: PageContentFormat;
  /** For text/HTML, whether to diff by lines instead of characters */
  lineMode?: boolean;
  /** Timeout for diff computation in milliseconds (default: 1000) */
  timeout?: number;
  /** For JSON/tiptap, whether to pretty-print before diffing */
  prettyPrint?: boolean;
}

// Create a shared diff-match-patch instance
const dmp = new DiffMatchPatch();

/**
 * Generates a diff between two content strings
 *
 * @param oldContent - The original/previous content
 * @param newContent - The new/current content
 * @param options - Optional configuration for diff generation
 * @returns DiffResult containing changes and statistics
 *
 * @example
 * ```ts
 * const result = diffContent('Hello world', 'Hello there');
 * // result.changes contains the individual changes
 * // result.stats contains {additions: 5, deletions: 5, unchanged: 6}
 * ```
 */
export function diffContent(
  oldContent: string,
  newContent: string,
  options: DiffOptions = {}
): DiffResult {
  // Handle null/undefined inputs
  const normalizedOld = oldContent ?? '';
  const normalizedNew = newContent ?? '';

  // Detect or use provided format
  const format = options.format ?? detectContentFormatForDiff(normalizedOld, normalizedNew);

  // Preprocess content based on format
  const { processedOld, processedNew } = preprocessContent(
    normalizedOld,
    normalizedNew,
    format,
    options
  );

  // Set timeout
  const previousTimeout = dmp.Diff_Timeout;
  dmp.Diff_Timeout = (options.timeout ?? 1000) / 1000; // Convert to seconds

  try {
    let diffs: [number, string][];

    if (options.lineMode) {
      // Use line mode for large text diffs
      diffs = diffLines(processedOld, processedNew);
    } else {
      // Character-level diff
      diffs = dmp.diff_main(processedOld, processedNew);
      dmp.diff_cleanupSemantic(diffs);
    }

    // Convert to our format
    const { changes, stats } = convertDiffs(diffs);

    return {
      format,
      changes,
      stats,
      isIdentical: normalizedOld === normalizedNew,
    };
  } finally {
    // Restore timeout
    dmp.Diff_Timeout = previousTimeout;
  }
}

/**
 * Generates a unified diff string (like git diff output)
 *
 * @param oldContent - The original content
 * @param newContent - The new content
 * @param oldLabel - Label for the old content (default: 'original')
 * @param newLabel - Label for the new content (default: 'modified')
 * @returns Unified diff string
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  oldLabel: string = 'original',
  newLabel: string = 'modified'
): string {
  const normalizedOld = oldContent ?? '';
  const normalizedNew = newContent ?? '';

  const diffs = dmp.diff_main(normalizedOld, normalizedNew);
  dmp.diff_cleanupSemantic(diffs);

  const patches = dmp.patch_make(normalizedOld, diffs);
  let patchText = dmp.patch_toText(patches);

  // Add headers
  const header = `--- ${oldLabel}\n+++ ${newLabel}\n`;

  return header + patchText;
}

/**
 * Applies a diff to restore content from one version to another
 *
 * @param baseContent - The base content to apply the patch to
 * @param patchText - The unified diff patch text
 * @returns The patched content
 */
export function applyDiff(baseContent: string, patchText: string): { content: string; success: boolean } {
  const normalizedBase = baseContent ?? '';

  try {
    // Strip unified diff headers (--- and +++ lines) if present
    let cleanedPatch = patchText;
    const lines = patchText.split('\n');
    if (lines.length >= 2 && lines[0].startsWith('---') && lines[1].startsWith('+++')) {
      cleanedPatch = lines.slice(2).join('\n');
    }

    const patches = dmp.patch_fromText(cleanedPatch);
    const [result, success] = dmp.patch_apply(patches, normalizedBase);

    return {
      content: result,
      success: success.every((s) => s),
    };
  } catch {
    return {
      content: normalizedBase,
      success: false,
    };
  }
}

/**
 * Generates a human-readable summary of changes
 *
 * @param diffResult - The diff result to summarize
 * @returns Human-readable summary string
 */
export function summarizeDiff(diffResult: DiffResult): string {
  if (diffResult.isIdentical) {
    return 'No changes detected';
  }

  const { additions, deletions, unchanged } = diffResult.stats;
  const total = additions + deletions + unchanged;

  const parts: string[] = [];

  if (additions > 0) {
    const percent = ((additions / total) * 100).toFixed(1);
    parts.push(`+${additions} characters (${percent}%)`);
  }

  if (deletions > 0) {
    const percent = ((deletions / total) * 100).toFixed(1);
    parts.push(`-${deletions} characters (${percent}%)`);
  }

  if (parts.length === 0) {
    return 'No significant changes';
  }

  return parts.join(', ');
}

/**
 * Extracts sections from tiptap/JSON content for selective rollback
 *
 * @param content - The content to extract sections from
 * @returns Array of section identifiers with their content
 */
export function extractSections(content: string): Array<{ id: string; type: string; content: string }> {
  const format = detectPageContentFormat(content);

  if (format !== 'tiptap' && format !== 'json') {
    // For text/HTML, split by paragraphs
    return extractTextSections(content);
  }

  try {
    const parsed = JSON.parse(content);
    return extractTiptapSections(parsed);
  } catch {
    return extractTextSections(content);
  }
}

/**
 * Diffs two tiptap documents and returns node-level changes
 *
 * @param oldContent - The original tiptap JSON content
 * @param newContent - The new tiptap JSON content
 * @returns Array of changes at the node level
 */
export function diffTiptapNodes(
  oldContent: string,
  newContent: string
): Array<{
  type: 'add' | 'remove' | 'modify' | 'unchanged';
  nodeType: string;
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
}> {
  const changes: Array<{
    type: 'add' | 'remove' | 'modify' | 'unchanged';
    nodeType: string;
    path: string;
    oldValue?: unknown;
    newValue?: unknown;
  }> = [];

  try {
    const oldDoc = JSON.parse(oldContent || '{"type":"doc","content":[]}');
    const newDoc = JSON.parse(newContent || '{"type":"doc","content":[]}');

    const oldNodes = oldDoc.content || [];
    const newNodes = newDoc.content || [];

    // Simple node comparison by position
    const maxLen = Math.max(oldNodes.length, newNodes.length);

    for (let i = 0; i < maxLen; i++) {
      const oldNode = oldNodes[i];
      const newNode = newNodes[i];
      const path = `content[${i}]`;

      if (!oldNode && newNode) {
        changes.push({
          type: 'add',
          nodeType: newNode.type || 'unknown',
          path,
          newValue: newNode,
        });
      } else if (oldNode && !newNode) {
        changes.push({
          type: 'remove',
          nodeType: oldNode.type || 'unknown',
          path,
          oldValue: oldNode,
        });
      } else if (JSON.stringify(oldNode) !== JSON.stringify(newNode)) {
        changes.push({
          type: 'modify',
          nodeType: newNode?.type || oldNode?.type || 'unknown',
          path,
          oldValue: oldNode,
          newValue: newNode,
        });
      } else {
        changes.push({
          type: 'unchanged',
          nodeType: oldNode?.type || 'unknown',
          path,
          oldValue: oldNode,
        });
      }
    }
  } catch {
    // If parsing fails, return single modify change
    changes.push({
      type: 'modify',
      nodeType: 'document',
      path: '',
      oldValue: oldContent,
      newValue: newContent,
    });
  }

  return changes;
}

// ============================================================================
// Internal helper functions
// ============================================================================

/**
 * Detects the most appropriate format for diffing
 */
function detectContentFormatForDiff(
  oldContent: string,
  newContent: string
): PageContentFormat {
  // Try to detect from new content first, then old
  const newFormat = detectPageContentFormat(newContent);
  if (newFormat !== 'text') {
    return newFormat;
  }

  return detectPageContentFormat(oldContent);
}

/**
 * Preprocesses content based on format before diffing
 */
function preprocessContent(
  oldContent: string,
  newContent: string,
  format: PageContentFormat,
  options: DiffOptions
): { processedOld: string; processedNew: string } {
  if ((format === 'json' || format === 'tiptap') && options.prettyPrint) {
    try {
      const oldParsed = JSON.parse(oldContent);
      const newParsed = JSON.parse(newContent);
      return {
        processedOld: JSON.stringify(oldParsed, null, 2),
        processedNew: JSON.stringify(newParsed, null, 2),
      };
    } catch {
      // If parsing fails, use original content
    }
  }

  return {
    processedOld: oldContent,
    processedNew: newContent,
  };
}

/**
 * Performs line-by-line diff for better performance on large texts
 */
function diffLines(oldText: string, newText: string): [number, string][] {
  const lineData = dmp.diff_linesToChars_(oldText, newText);
  const diffs = dmp.diff_main(lineData.chars1, lineData.chars2, false);
  dmp.diff_charsToLines_(diffs, lineData.lineArray);
  return diffs;
}

/**
 * Converts diff-match-patch format to our DiffChange format
 */
function convertDiffs(diffs: [number, string][]): { changes: DiffChange[]; stats: DiffStats } {
  const changes: DiffChange[] = [];
  const stats: DiffStats = {
    additions: 0,
    deletions: 0,
    unchanged: 0,
    totalChanges: 0,
  };

  let originalPos = 0;
  let newPos = 0;

  for (const [operation, text] of diffs) {
    const length = text.length;

    switch (operation) {
      case DiffMatchPatch.DIFF_DELETE:
        changes.push({
          type: 'remove',
          value: text,
          originalStart: originalPos,
          originalEnd: originalPos + length,
        });
        stats.deletions += length;
        stats.totalChanges++;
        originalPos += length;
        break;

      case DiffMatchPatch.DIFF_INSERT:
        changes.push({
          type: 'add',
          value: text,
          newStart: newPos,
          newEnd: newPos + length,
        });
        stats.additions += length;
        stats.totalChanges++;
        newPos += length;
        break;

      case DiffMatchPatch.DIFF_EQUAL:
        changes.push({
          type: 'unchanged',
          value: text,
          originalStart: originalPos,
          originalEnd: originalPos + length,
          newStart: newPos,
          newEnd: newPos + length,
        });
        stats.unchanged += length;
        originalPos += length;
        newPos += length;
        break;
    }
  }

  return { changes, stats };
}

/**
 * Extracts sections from plain text content
 */
function extractTextSections(
  content: string
): Array<{ id: string; type: string; content: string }> {
  const sections: Array<{ id: string; type: string; content: string }> = [];

  // Split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\n+/);

  paragraphs.forEach((para, index) => {
    if (para.trim()) {
      sections.push({
        id: `section-${index}`,
        type: 'paragraph',
        content: para.trim(),
      });
    }
  });

  return sections;
}

/**
 * Extracts sections from tiptap JSON content
 */
function extractTiptapSections(
  doc: { type?: string; content?: Array<{ type?: string; content?: unknown; attrs?: unknown }> }
): Array<{ id: string; type: string; content: string }> {
  const sections: Array<{ id: string; type: string; content: string }> = [];

  if (!doc.content || !Array.isArray(doc.content)) {
    return sections;
  }

  doc.content.forEach((node, index) => {
    sections.push({
      id: `node-${index}`,
      type: node.type || 'unknown',
      content: JSON.stringify(node),
    });
  });

  return sections;
}
