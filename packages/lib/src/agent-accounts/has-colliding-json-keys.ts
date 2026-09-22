/**
 * `hasCollidingJsonKeys` — whether any JSON object in `text` names the same
 * key twice, compared after unescaping and case-insensitively (G1c review of
 * PR #2660). `JSON.parse` silently keeps the LAST duplicate; other parsers keep
 * the first, and some match keys case-insensitively. A body where two readers
 * can disagree about which `channel` it names is refused, so the value the
 * plane restricts is the value the provider uses.
 *
 * Call it only on text `JSON.parse` already accepted: the scanner trusts the
 * structure and only tracks objects, arrays and strings. Pure.
 */
type Frame = { readonly kind: 'array' } | { readonly kind: 'object'; readonly keys: Set<string>; expectingKey: boolean };

export function hasCollidingJsonKeys({ text }: { readonly text: string }): boolean {
  const stack: Frame[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const top = stack[stack.length - 1];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (top?.kind === 'object' && top.expectingKey) {
        const key = (JSON.parse(text.slice(index, end + 1)) as string).toLowerCase();
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectingKey = false;
      }
      index = end;
    } else if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), expectingKey: true });
    } else if (char === '[') {
      stack.push({ kind: 'array' });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',' && top?.kind === 'object') {
      top.expectingKey = true;
    }
  }
  return false;
}
