/**
 * The MON-5 second-conversion scanner ("A test greps for any second conversion and fails
 * on it"), used by billing/__tests__/money-model-guard.test.ts.
 *
 * A credit is defined once, in packages/lib/src/billing/money-model.ts. A literal `100`
 * multiplying or dividing a money value anywhere else is a second definition of what a
 * credit (or a dollar) is. Review 2 showed a line regex misses the shapes that matter:
 * a call result (`walletRemainingCents(x) / 100`, M9b), an operand whose name says
 * dollars rather than cents (`costDollars * 100`, M9c), a parenthesised chain
 * (`costDollars(m) * (MARKUP_BPS / 10_000) * 100`), a `*` that starts a continuation
 * line, and a SQL interpolation (`${aiUsageLogs.cost}::numeric * 100`). So this scans
 * the whole file, not lines:
 *
 *   1. mask comments and '…' / "…" string contents with spaces (offsets and newlines
 *      survive; template-literal text is kept, because SQL lives there);
 *   2. for every whole literal `100` that is a factor or divisor (`x * 100`, `x / 100`,
 *      `100 * x`), collect the multiplicative chain it sits in, to the left and right;
 *   3. give each operand a money dimension: 1 when a name in it (identifier, member
 *      segment, callee, or — through a call such as Math.round or COALESCE, a paren
 *      group, or a `${…}` interpolation — the expression inside) is a money word;
 *   4. flag it when the chain's net dimension (money numerators minus money divisors)
 *      is not zero. `(chargedCents - realCostCents) / realCostCents * 100` is a ratio
 *      of two money values — a percentage — and nets to zero; `cents / 100` does not.
 *
 * There is no allowlist and no exception list: a flagged line is routed through
 * money-model, or the rule is wrong and gets a test here.
 */

/** Words that make a name a money value (split from camelCase / snake_case / CONSTANT_CASE). */
export const MONEY_WORDS: ReadonlySet<string> = new Set([
  'cent', 'cents', 'millicent', 'millicents',
  'credit', 'credits',
  'dollar', 'dollars', 'usd',
  'cost', 'costs',
  'amount', 'amounts',
  'price', 'prices',
  'charge', 'charged', 'charges',
  'paid', 'fee', 'fees',
  'spend', 'spent',
  'allowance', 'allowances',
  'balance', 'balances', 'subtotal', 'budget', 'budgets',
  'revenue', 'liability',
]);

/**
 * Words that make a name unitless whatever else it says: `LOW_BALANCE_THRESHOLD_PCT`,
 * `costShare`, `costFraction` are ratios, and a ratio times 100 is a percentage.
 */
export const UNITLESS_WORDS: ReadonlySet<string> = new Set([
  'pct', 'percent', 'percentage', 'ratio', 'share', 'fraction', 'bps',
]);

/** Split an identifier into lowercase words: `realCostCents` → real, cost, cents. */
export function identWords(ident: string): string[] {
  return ident
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isMoneyName(ident: string): boolean {
  const words = identWords(ident);
  if (words.some((w) => UNITLESS_WORDS.has(w))) return false;
  return words.some((w) => MONEY_WORDS.has(w));
}

/**
 * Blank comments and single/double-quoted string contents with spaces, keeping every
 * offset and newline. Template-literal text is kept (SQL is written there), and code
 * inside `${…}` is scanned as code, comments included. `keepStrings` blanks comments
 * only — for scanning published copy, which lives in strings.
 */
export function maskSource(src: string, opts: { keepStrings?: boolean } = {}): string {
  const out = src.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Stack of contexts: 'code' (with a brace depth for `${`), or 'tpl' (template text).
  const stack: Array<{ kind: 'code'; depth: number } | { kind: 'tpl' }> = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const n = src[i + 1];
    if (top.kind === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; continue; }
      if (c === '$' && n === '{') { stack.push({ kind: 'code', depth: 0 }); i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          if (!opts.keepStrings) blank(i);
          i += 1;
        }
        if (i < src.length && src[i] !== '\n') {
          if (!opts.keepStrings) blank(i);
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (c === '`') { stack.push({ kind: 'tpl' }); i += 1; continue; }
    if (c === '{') { top.depth += 1; i += 1; continue; }
    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); i += 1; continue; }
      top.depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket matching the closer at `end`, scanning left; -1 if unbalanced. */
function matchLeft(s: string, end: number): number {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = s[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      depth -= 1;
      if (depth === 0) return OPEN[s[end]] === c ? i : -1;
    }
  }
  return -1;
}

/** Index of the bracket matching the opener at `start`, scanning right; -1 if unbalanced. */
function matchRight(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return CLOSE[s[start]] === c ? i : -1;
    }
  }
  return -1;
}

/** Start of the operand that ends at `end` (inclusive), or -1 when there is none. */
function operandStartLeft(s: string, end: number): number {
  let p = end;
  let start = -1;
  for (;;) {
    if (p < 0) return start;
    const c = s[p];
    let wasGroup = false;
    if (c === ')' || c === ']' || c === '}') {
      const open = matchLeft(s, p);
      if (open < 0) return start;
      start = open;
      p = open - 1;
      if (c === '}') return s[p] === '$' ? p : start; // a `${…}` interpolation is a whole operand
      wasGroup = true;
    } else if (IDENT_CHAR.test(c)) {
      while (p >= 0 && IDENT_CHAR.test(s[p])) p -= 1;
      start = p + 1;
    } else {
      return start;
    }
    // What joins this piece to the one before it?
    if (s[p] === '.' && s[p - 1] === '?') p -= 2; // `a?.b`
    else if (s[p] === '.' && s[p - 1] !== '.') p -= 1; // `a.b` (not a spread)
    else if (s[p] === ':' && s[p - 1] === ':') p -= 2; // a SQL `::type` cast
    else if (s[p] === '!' && p > 0 && /[\w$)\]]/.test(s[p - 1])) p -= 1; // non-null `a!`
    else if (!(wasGroup && p >= 0 && /[\w$)\]]/.test(s[p]))) return start; // else: callee `fn(x)`, index `a[0]`
  }
}

/** End (exclusive) of the operand that starts at `start`, or -1 when there is none. */
function operandEndRight(s: string, start: number): number {
  let p = start;
  while (s[p] === '+' || s[p] === '-' || s[p] === '!' || s[p] === '~') p += 1;
  if (s[p] === '$' && s[p + 1] === '{') {
    const close = matchRight(s, p + 1);
    return close < 0 ? -1 : close + 1;
  }
  let end = -1;
  for (;;) {
    const c = s[p];
    if (c === '(' || c === '[') {
      const close = matchRight(s, p);
      if (close < 0) return end;
      p = close + 1;
      end = p;
    } else if (c !== undefined && IDENT_CHAR.test(c)) {
      while (p < s.length && /[A-Za-z0-9_$.]/.test(s[p]) && !(s[p] === '.' && !IDENT_CHAR.test(s[p + 1] ?? ''))) p += 1;
      end = p;
    } else {
      return end;
    }
    if (s[p] === '?' && s[p + 1] === '.') p += 2;
    else if (s[p] === '.' && IDENT_CHAR.test(s[p + 1] ?? '')) p += 1;
    else if (s[p] === '!' && s[p + 1] !== '=') p += 1;
    else if (s[p] === ':' && s[p + 1] === ':') p += 2;
    else if (s[p] === '(' || s[p] === '[') continue;
    else return end;
  }
}

/** Split `text` at depth-0 occurrences of any separator matched by `sep` (returns pieces and the separator before each). */
function splitTopLevel(text: string, isSep: (s: string, i: number) => number): Array<{ piece: string; sep: string }> {
  const parts: Array<{ piece: string; sep: string }> = [];
  let depth = 0;
  let last = 0;
  let lastSep = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0) {
      const len = isSep(text, i);
      if (len > 0) {
        parts.push({ piece: text.slice(last, i), sep: lastSep });
        lastSep = text.slice(i, i + len);
        last = i + len;
        i += len - 1;
      }
    }
  }
  parts.push({ piece: text.slice(last), sep: lastSep });
  return parts;
}

/** Additive, logical, comparison, ternary and comma boundaries: a new term starts after one. */
function termSeparator(s: string, i: number): number {
  const two = s.slice(i, i + 3);
  if (two === '===' || two === '!==') return 3;
  const pair = s.slice(i, i + 2);
  if (['??', '||', '&&', '<=', '>=', '==', '!=', '=>'].includes(pair)) return 2;
  const c = s[i];
  if (c === ',' || c === '?' || c === ':' || c === '<' || c === '>') {
    if (c === ':' && (s[i + 1] === ':' || s[i - 1] === ':')) return 0; // `::type` cast
    if (c === '?' && s[i + 1] === '.') return 0;
    return 1;
  }
  if ((c === '+' || c === '-') && s[i + 1] !== c) {
    // A binary +/- follows an operand; a unary one follows an operator or starts the text.
    const before = s.slice(0, i).trimEnd();
    return before.length > 0 && /[\w$)\]}]$/.test(before) ? 1 : 0;
  }
  return 0;
}

function productSeparator(s: string, i: number): number {
  const c = s[i];
  if ((c === '*' || c === '/') && s[i + 1] !== '*' && s[i - 1] !== '*' && s[i + 1] !== '=') return 1;
  return 0;
}

/** Money dimension of one operand's text (see the module comment). */
export function operandDim(raw: string): number {
  let text = raw.trim().replace(/^(?:await|new|typeof|void)\s+/, '').replace(/^[+\-!~]+/, '').trim();
  if (text === '') return 0;
  if (/^\d/.test(text)) return 0;
  if (text.startsWith('${') && text.endsWith('}')) return exprDim(text.slice(2, -1));
  text = text.replace(/::[A-Za-z_][\w ]*$/, '');
  if (text.startsWith('${')) {
    const close = matchRight(text, 1);
    if (close > 0) return exprDim(text.slice(2, close));
  }
  if (text.startsWith('(') && matchRight(text, 0) === text.length - 1) return exprDim(text.slice(1, -1));
  // A member/call chain: names outside brackets, and the argument list of each call.
  const names: string[] = [];
  const calls: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(' || c === '[') {
      const close = matchRight(text, i);
      if (close < 0) break;
      if (c === '(') calls.push(text.slice(i + 1, close));
      i = close + 1;
    } else if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j < text.length && IDENT_CHAR.test(text[j])) j += 1;
      names.push(text.slice(i, j));
      i = j;
    } else {
      i += 1;
    }
  }
  if (names.some(isMoneyName)) return 1;
  for (let k = calls.length - 1; k >= 0; k--) {
    for (const { piece } of splitTopLevel(calls[k], (s, x) => (s[x] === ',' ? 1 : 0))) {
      const d = exprDim(piece);
      if (d !== 0) return d;
    }
  }
  return 0;
}

/** Net money dimension of a product chain: money numerators minus money divisors. */
function productDim(text: string): number {
  let dim = 0;
  for (const { piece, sep } of splitTopLevel(text, productSeparator)) {
    const d = operandDim(piece);
    dim += sep === '/' ? -d : d;
  }
  return dim;
}

/** A term that carries no unit of its own: a number, null/undefined, a boolean, a masked string. */
const LITERAL_TERM = /^\s*(?:[+-]?\d[\d_.]*(?:e[+-]?\d+)?|null|undefined|true|false|(['"`])\s*\1)?\s*$/;

/**
 * Money dimension of an expression. A term that is a bare literal (`row.cost ?? 0`) does
 * not count. When the others mix a money term with a non-money one — `(revenue - prev)`,
 * where `prev` names no unit — the unit is unknown and the group counts as 0, so a
 * growth percentage is not taken for a conversion.
 */
export function exprDim(text: string): number {
  let found = 0;
  let unknown = false;
  for (const { piece } of splitTopLevel(text, termSeparator)) {
    if (LITERAL_TERM.test(piece)) continue;
    const d = productDim(piece);
    if (d === 0) unknown = true;
    else if (found === 0) found = d;
  }
  return unknown ? 0 : found;
}

/** Skip whitespace leftwards from `i`; the index of the first non-space char, or -1. */
function skipWsLeft(s: string, i: number): number {
  while (i >= 0 && /\s/.test(s[i])) i -= 1;
  return i;
}

function skipWsRight(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

/** The `*` or `/` at `i`, when it is a binary multiply/divide (not `**`, `*=`, `/=`, `/*`). */
function mulDivAt(s: string, i: number): '*' | '/' | null {
  const c = s[i];
  if (c !== '*' && c !== '/') return null;
  if (s[i - 1] === '*' || s[i + 1] === '*' || s[i + 1] === '=' || s[i - 1] === '/' || s[i + 1] === '/') return null;
  return c;
}

/**
 * The chain a literal `100` at [start, end) sits in, as signed operand dimensions, or
 * null when the 100 is not a factor or divisor of anything.
 */
export function chainDimAt(s: string, start: number, end: number): number | null {
  let dim = 0;
  let found = false;
  // Compound assignment: `target /= 100`, `target *= 100` — the target is the operand.
  const eqIdx = skipWsLeft(s, start - 1);
  if (s[eqIdx] === '=' && (s[eqIdx - 1] === '*' || s[eqIdx - 1] === '/') && s[eqIdx - 2] !== s[eqIdx - 1]) {
    const targetEnd = skipWsLeft(s, eqIdx - 2);
    const targetStart = operandStartLeft(s, targetEnd);
    return targetStart < 0 ? null : operandDim(s.slice(targetStart, targetEnd + 1));
  }
  // Leftwards: `… op a op 100`. The operator before each operand decides its role.
  let opIdx = skipWsLeft(s, start - 1);
  let op = mulDivAt(s, opIdx);
  while (op) {
    found = true;
    const operandEnd = skipWsLeft(s, opIdx - 1);
    const operandStart = operandStartLeft(s, operandEnd);
    if (operandStart < 0) break;
    const d = operandDim(s.slice(operandStart, operandEnd + 1));
    const beforeIdx = skipWsLeft(s, operandStart - 1);
    const before = mulDivAt(s, beforeIdx);
    dim += before === '/' ? -d : d;
    opIdx = beforeIdx;
    op = before;
  }
  // Rightwards: `100 op b op c …`.
  let p = skipWsRight(s, end);
  op = mulDivAt(s, p);
  while (op) {
    found = true;
    const operandStart = skipWsRight(s, p + 1);
    const operandEnd = operandEndRight(s, operandStart);
    if (operandEnd < 0) break;
    const d = operandDim(s.slice(operandStart, operandEnd));
    dim += op === '/' ? -d : d;
    p = skipWsRight(s, operandEnd);
    op = mulDivAt(s, p);
  }
  return found ? dim : null;
}

export interface ConversionHit {
  line: number;
  text: string;
}

/** The literal ways to write a hundred (or its inverse): `100`, `100.0`, `1e2`, `0.01`. */
const HUNDRED_LITERAL = /(?<![\w$.])(?:100(?:\.0+)?|1e2|0\.0*1)(?![\w$.])/g;

/** `import { … } from '…'` and `export { … } from '…'` (a name listed there is not a use). */
const IMPORT_EXPORT_FROM = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"\n]*['"]/g;

/**
 * money-model exports CENTS_PER_DOLLAR for SQL, where no function can run: the only
 * use allowed elsewhere is a `${CENTS_PER_DOLLAR}` interpolation. Anywhere else it is
 * a hand-rolled conversion that dodges the literal (`cents / CENTS_PER_DOLLAR`).
 */
const CENTS_PER_DOLLAR_USE = /(?<!\$\{\s*)\bCENTS_PER_DOLLAR\b(?!\s*\})/g;

/**
 * Every second conversion in one source text (1-based lines, trimmed source line text).
 *
 * Known limits (the tests say so): a value renamed or destructured away from its money
 * name (`const { remainingCents: r } = v; r / 100`), a conversion split across a
 * variable or a helper in another file, a divisor spelled some other way (`HUNDRED`,
 * `/ 10 / 10`), and SQL inside a quoted string, which is masked.
 */
export function findConversionsInSource(src: string): ConversionHit[] {
  const masked = maskSource(src);
  const lines = src.split('\n');
  const hits: ConversionHit[] = [];
  const seen = new Set<number>();
  const hit = (offset: number) => {
    const line = masked.slice(0, offset).split('\n').length;
    if (seen.has(line)) return;
    seen.add(line);
    hits.push({ line, text: (lines[line - 1] ?? '').trim() });
  };
  for (const m of masked.matchAll(HUNDRED_LITERAL)) {
    const start = m.index ?? 0;
    const dim = chainDimAt(masked, start, start + m[0].length);
    // A positive net dimension is money scaled by a hundred. A negative one is a money
    // divisor under a non-money numerator (`used / allowance * 100`): a percentage.
    if (dim !== null && dim > 0) hit(start);
  }
  const code = masked.replace(IMPORT_EXPORT_FROM, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of code.matchAll(CENTS_PER_DOLLAR_USE)) hit(m.index ?? 0);
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * MON-1 copy scan: a literal credit figure in published text, in any case: "5 credits",
 * "15/month in credits", "Start with 500 free credits", "1,500 AI credits", "1.5k
 * credits", "Credits: 1500/month". Up to two words may sit between the number and
 * "credits". A figure interpolated from the money model (`{MONTHLY_CREDITS.pro} credits`)
 * has no digit before the word and never matches. A decimal counts only with a `k`
 * suffix, so a section heading like "11.3 Credits and Usage Limits" is not a figure. The
 * label form needs a capital C ("Credits: 1500"), so a code key `credits: 1_200` is not copy.
 */
export const CREDIT_FIGURE =
  /(?<![\w.,$])\d[\d,]*(?:\.\d+[kK]|[kK])?(?:\s*\/\s*(?:mo|month))?(?:\s+[A-Za-z-]+){0,2}\s+(?:[Cc]redits?|CREDITS?)\b|\b(?:Credits?|CREDITS?)\s*:\s*\d/g;

/** MON-1 / A-9 copy scan: the removed Founder plan, as a word ("NotFoundError" never matches). */
export const FOUNDER_PLAN = /\bfounders?\b/gi;

/** Lines of `src` (comments stripped, strings kept) where `pattern` matches. */
export function findCopyHits(src: string, pattern: RegExp): ConversionHit[] {
  const masked = maskSource(src, { keepStrings: true });
  const lines = src.split('\n');
  const hits: ConversionHit[] = [];
  masked.split('\n').forEach((line, i) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push({ line: i + 1, text: (lines[i] ?? '').trim() });
  });
  pattern.lastIndex = 0;
  return hits;
}
