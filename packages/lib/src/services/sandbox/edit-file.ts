/**
 * Pure string-replacement core for the sandbox `editFile` tool.
 *
 * Targeted edits without rewriting the whole file: replace `oldString` with
 * `newString`. By default `oldString` must be unique so an edit can't silently
 * hit the wrong occurrence; `replaceAll` opts into replacing every match.
 *
 * Literal, not regex: matching and replacement use split/join, so neither
 * `oldString`'s regex metacharacters nor `newString`'s `$` replacement patterns
 * are interpreted. Pure and never throws — the runner maps the failure reasons
 * onto tool denials.
 */

export type ApplyEditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; reason: 'edit_no_match' | 'edit_not_unique' };

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

export function applyEdit({
  content,
  oldString,
  newString,
  replaceAll = false,
}: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): ApplyEditResult {
  const count = countOccurrences(content, oldString);
  if (count === 0) return { ok: false, reason: 'edit_no_match' };
  if (count > 1 && !replaceAll) return { ok: false, reason: 'edit_not_unique' };

  // count === 1, or replaceAll with count >= 1: split/join replaces literally,
  // interpreting nothing in either string.
  return { ok: true, content: content.split(oldString).join(newString), replacements: count };
}
