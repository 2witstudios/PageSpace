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
 * Words that make a name unitless when they END it: `LOW_BALANCE_THRESHOLD_PCT`,
 * `costShare`, `costFraction` are ratios, and a ratio times 100 is a percentage. Only the
 * last word counts, so `revenueShareCents` and `perSeatShareCents` stay money.
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
  if (words.length > 0 && UNITLESS_WORDS.has(words[words.length - 1])) return false;
  return words.some((w) => MONEY_WORDS.has(w));
}

/**
 * Stripe objects whose `total` / `tax` fields are money in minor units, although the
 * field name says no unit: `invoice.total / 100` is a conversion. A rule-level word list,
 * matched on the object's words (`upcomingInvoice`, `charge`, `refund` …).
 */
export const STRIPE_MONEY_OBJECTS: ReadonlySet<string> = new Set([
  'invoice', 'invoices', 'charge', 'charges', 'payment', 'refund', 'refunds', 'coupon', 'quote', 'upcoming',
]);
const STRIPE_UNITLESS_MONEY_FIELDS: ReadonlySet<string> = new Set(['total', 'tax']);

/** `invoice.total`, `upcomingInvoice?.tax`: a Stripe money object's total or tax field. */
function isStripeMoneyField(names: readonly string[]): boolean {
  for (let k = 1; k < names.length; k++) {
    const field = identWords(names[k]);
    if (field.length === 0 || !STRIPE_UNITLESS_MONEY_FIELDS.has(field[field.length - 1])) continue;
    if (identWords(names[k - 1]).some((w) => STRIPE_MONEY_OBJECTS.has(w))) return true;
  }
  return false;
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
  if (names.some(isMoneyName) || isStripeMoneyField(names)) return 1;
  for (let k = calls.length - 1; k >= 0; k--) {
    for (const { piece } of splitTopLevel(calls[k], (s, x) => (s[x] === ',' ? 1 : 0))) {
      const d = exprDim(piece);
      if (d !== 0) return d;
    }
  }
  return 0;
}

/** One factor of a product chain: its text and whether it divides. */
export interface Factor {
  text: string;
  div: boolean;
}

const stripUnary = (t: string) => t.trim().replace(/^[+\-!~]+/, '').trim();

/** `( … )` wrapping the whole text. */
function isParenGroup(text: string): boolean {
  const t = text.trim();
  return t.startsWith('(') && matchRight(t, 0) === t.length - 1;
}

/**
 * Net money dimension of a chain of factors: money numerators minus money divisors.
 * One precise exception, the growth shape: a group divided by one of its OWN terms,
 * `(revenue - prev) / prev`, is a ratio of like values and contributes nothing.
 */
export function factorsDim(factors: readonly Factor[]): number {
  let dim = 0;
  for (let i = 0; i < factors.length; i++) {
    const f = factors[i];
    const next = factors[i + 1];
    if (!f.div && next?.div && isParenGroup(f.text)) {
      const inner = f.text.trim().slice(1, -1);
      const terms = splitTopLevel(inner, termSeparator).map(({ piece }) => stripUnary(piece));
      if (terms.includes(stripUnary(next.text))) {
        i += 1;
        continue;
      }
    }
    const d = operandDim(f.text);
    dim += f.div ? -d : d;
  }
  return dim;
}

/** Net money dimension of a product chain written as one text. */
function productDim(text: string): number {
  return factorsDim(splitTopLevel(text, productSeparator).map(({ piece, sep }) => ({ text: piece, div: sep === '/' })));
}

/**
 * Money dimension of an expression: that of its first money-carrying term, so a group
 * mixing a money term with an unnamed one — `(amountPaid - refunded)`,
 * `(isTrial ? 0 : costDollars)` — still carries money.
 */
export function exprDim(text: string): number {
  for (const { piece } of splitTopLevel(text, termSeparator)) {
    const d = productDim(piece);
    if (d !== 0) return d;
  }
  return 0;
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

/** What a literal hundred multiplies or divides: its chain's factors, in source order. */
export interface HundredChain {
  factors: Factor[];
  /** Index of the hundred itself in `factors`. */
  hundred: number;
}

/**
 * The chain a literal `100` at [start, end) sits in, or null when the 100 is not a factor
 * or divisor of anything. A compound assignment (`target /= 100`) is a two-factor chain.
 */
export function chainAt(s: string, start: number, end: number): HundredChain | null {
  const hundredText = s.slice(start, end);
  const eqIdx = skipWsLeft(s, start - 1);
  if (s[eqIdx] === '=' && (s[eqIdx - 1] === '*' || s[eqIdx - 1] === '/') && s[eqIdx - 2] !== s[eqIdx - 1]) {
    const targetEnd = skipWsLeft(s, eqIdx - 2);
    const targetStart = operandStartLeft(s, targetEnd);
    if (targetStart < 0) return null;
    return {
      factors: [{ text: s.slice(targetStart, targetEnd + 1), div: false }, { text: hundredText, div: s[eqIdx - 1] === '/' }],
      hundred: 1,
    };
  }
  const left: Factor[] = [];
  let found = false;
  // Leftwards: `… op a op 100`. The operator before each operand decides its role.
  let opIdx = skipWsLeft(s, start - 1);
  let op = mulDivAt(s, opIdx);
  const hundredDiv = op === '/';
  while (op) {
    found = true;
    const operandEnd = skipWsLeft(s, opIdx - 1);
    const operandStart = operandStartLeft(s, operandEnd);
    if (operandStart < 0) break;
    const beforeIdx = skipWsLeft(s, operandStart - 1);
    const before = mulDivAt(s, beforeIdx);
    left.unshift({ text: s.slice(operandStart, operandEnd + 1), div: before === '/' });
    opIdx = beforeIdx;
    op = before;
  }
  const right: Factor[] = [];
  // Rightwards: `100 op b op c …`.
  let p = skipWsRight(s, end);
  op = mulDivAt(s, p);
  while (op) {
    found = true;
    const operandStart = skipWsRight(s, p + 1);
    const operandEnd = operandEndRight(s, operandStart);
    if (operandEnd < 0) break;
    right.push({ text: s.slice(operandStart, operandEnd), div: op === '/' });
    p = skipWsRight(s, operandEnd);
    op = mulDivAt(s, p);
  }
  if (!found) return null;
  return { factors: [...left, { text: hundredText, div: hundredDiv }, ...right], hundred: left.length };
}

/** Net money dimension of the chain a hundred sits in (kept for callers and tests). */
export function chainDimAt(s: string, start: number, end: number): number | null {
  const chain = chainAt(s, start, end);
  return chain ? factorsDim(chain.factors) : null;
}

/**
 * The percent idiom, the one negative-dimension shape that is not a conversion: a
 * parenthesised ratio with money only in its divisor, times a hundred —
 * `(used / allowance) * 100`. Every other negative chain (`100 / costCents`) is flagged.
 */
function isPercentIdiom(chain: HundredChain): boolean {
  if (chain.factors[chain.hundred].div) return false;
  return chain.factors.every((f, i) => {
    if (i === chain.hundred) return true;
    const d = operandDim(f.text);
    const contribution = f.div ? -d : d;
    return contribution >= 0 || (!f.div && isParenGroup(f.text));
  });
}

/** Whether the hundred at [start, end) converts money. */
export function isConversionAt(s: string, start: number, end: number): boolean {
  const chain = chainAt(s, start, end);
  if (!chain) return false;
  const dim = factorsDim(chain.factors);
  if (dim > 0) return true;
  return dim < 0 && !isPercentIdiom(chain);
}

export interface ConversionHit {
  line: number;
  text: string;
}

/** The literal ways to write a hundred (or its inverse): `100`, `100.0`, `1e2`, `1e-2`, `0.01`. */
const HUNDRED_LITERAL = /(?<![\w$.])(?:100(?:\.0+)?|1e2|1e-2|0\.01)(?![\w$.])/g;

/** Renaming the SQL constant on import (`CENTS_PER_DOLLAR as K`) would hide every use. */
const CENTS_PER_DOLLAR_ALIAS = /\bCENTS_PER_DOLLAR\s+as\b/g;

/** `import { … } from '…'` and `export { … } from '…'` (a name listed there is not a use). */
const IMPORT_EXPORT_FROM = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"\n]*['"]/g;

/**
 * money-model exports CENTS_PER_DOLLAR for SQL, where no function can run: the only
 * use allowed elsewhere is a `${CENTS_PER_DOLLAR}` interpolation. Anywhere else it is
 * a hand-rolled conversion that dodges the literal (`cents / CENTS_PER_DOLLAR`).
 */
const CENTS_PER_DOLLAR_USE = /(?<!\$\{\s*)\bCENTS_PER_DOLLAR\b(?!\s*\})/g;

/**
 * KNOWN LIMITS — what this scanner cannot see. It reads one file's text and judges a
 * value by the NAME it is written with at the point of conversion, so a conversion slips
 * whenever the money name is gone by then. These are not exceptions (there are none):
 * they are the edge of what a text scan can know. money-model-guard.test.ts asserts
 * every example below is NOT flagged, so this list stays the scanner's true reach, and
 * a change that closes one shows up as a failing "known limit" test to move into the
 * "flags" table. {@link resolveBindings} closed the aliased operand, the value split across
 * a variable, the named-constant divisor and the hundred split into steps; what is left
 * needs a type checker (a parameter's caller in another file) or is not code (quoted SQL,
 * an index path), and is accepted as the scan's edge.
 */
export const KNOWN_LIMITS: ReadonlyArray<{ shape: string; example: string; why: string }> = [
  {
    shape: 'a conversion inside a helper, called with cents from elsewhere',
    example: 'export const toDollars = (v: number) => v / 100;',
    why: 'the parameter has no money name; the caller in another file is never linked',
  },
  {
    shape: 'SQL inside a quoted string',
    example: "sql.raw('SELECT balance_cents / 100 FROM wallets');",
    why: 'quoted strings are masked (template text is scanned, so write SQL in a sql`` template)',
  },
  {
    shape: 'an operand with no name at all',
    example: 'const d = rows[0][2] / 100;',
    why: 'an index path carries no word to judge',
  },
];

const VALUE_CHAIN = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\([^()]*\)|\s*\[[^\]]*\])*)/;

/**
 * The name a value is known by: the last member of the leading access chain, ignoring call
 * arguments and indexes — `walletRemainingCents(x)` → walletRemainingCents, `row?.count ?? 0`
 * → count, `Math.round(x)` → round (a wrapper hides the value, so nothing is inferred).
 */
function valueName(init: string): string | null {
  const chain = VALUE_CHAIN.exec(init)?.[1];
  if (!chain) return null;
  const members = chain.replace(/\([^()]*\)|\[[^\]]*\]/g, '').match(/[A-Za-z_$][\w$]*/g);
  return members ? members[members.length - 1] : null;
}

/** Where the block a declaration ending at `from` sits in closes (the binding's scope). */
function scopeEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}' && --depth < 0) return i;
  }
  return code.length;
}

/**
 * Uses of `name` from `from` to the end of its block: not a property (`.name`), an object key
 * (`name:`) or a longer word. Scoped, so a `const r` in one function never renames another's.
 */
function renameUses(code: string, name: string, to: string, from: number): string {
  const use = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*:(?!:))`, 'g');
  const end = scopeEnd(code, from);
  return code.slice(0, from) + code.slice(from, end).replace(use, to) + code.slice(end);
}

/** True when `expr` has a `*`, `/`, `%`, `+` or `-` outside every bracket: arithmetic, not one value. */
function hasTopLevelArithmetic(expr: string): boolean {
  let depth = 0;
  for (const c of expr) {
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && /[*/%+-]/.test(c)) return true;
  }
  return false;
}

/**
 * Follow the bindings a text scan would otherwise lose, inside one file, before judging any
 * operator (each closes a former KNOWN_LIMITS entry):
 *   - a hundred bound to a name (`const HUNDRED = 100`) is a hundred wherever it is used;
 *   - a hundred split into steps (`/ 10 / 10`, `* 10 * 10`) is a hundred;
 *   - a money field renamed by destructuring (`{ remainingCents: r }`) keeps its money name;
 *   - a name bound to ONE money value (`const n = walletRemainingCents(x)`, no arithmetic in
 *     the initializer, so a ratio such as `used / allowanceCents` is never renamed) keeps it.
 * Line structure is preserved, so every hit still reports its source line.
 */
export function resolveBindings(code: string): string {
  let out = code.replace(/([*/])\s*10\s*\1\s*10(?![\w$.])/g, '$1 100');
  for (const m of [...out.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(?:100(?:\.0+)?|1e2|0\.01|1e-2)\s*;/g)]) {
    out = renameUses(out, m[1], m[0].includes('0.01') || m[0].includes('1e-2') ? '0.01' : '100', (m.index ?? 0) + m[0].length);
  }
  for (const m of [...out.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)]) {
    for (const entry of m[1].split(',')) {
      const [key, alias] = entry.split(':').map((part) => part.trim().split(/\s*=/)[0]);
      if (key && alias && /^[A-Za-z_$][\w$]*$/.test(alias) && isMoneyName(key) && !isMoneyName(alias)) {
        out = renameUses(out, alias, key, (m.index ?? 0) + m[0].length);
      }
    }
  }
  for (const m of [...out.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+);/g)]) {
    const [, name, init] = m;
    if (isMoneyName(name) || /=>|\bfunction\b|\bnew\b/.test(init) || hasTopLevelArithmetic(init.replace(/\?\?|\?\.|\?|:/g, ' '))) continue;
    const value = valueName(init);
    if (value && isMoneyName(value)) out = renameUses(out, name, value, (m.index ?? 0) + m[0].length);
  }
  return out;
}

/** Every second conversion in one source text (1-based lines, trimmed source line text). See KNOWN_LIMITS. */
export function findConversionsInSource(src: string): ConversionHit[] {
  const masked = resolveBindings(maskSource(src));
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
    if (isConversionAt(masked, start, start + m[0].length)) hit(start);
  }
  for (const m of masked.matchAll(CENTS_PER_DOLLAR_ALIAS)) hit(m.index ?? 0);
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

/**
 * MON-1 definition scan: a constant of the money model's vocabulary — a markup, the
 * credit rate, the included-credit ratio, an allowance, a starter grant, a pack, a
 * per-consumer cap default, a top-up bound — whose initializer carries a numeric
 * literal. Outside money-model.ts that is a second statement of the money model; a
 * constant DERIVED from money-model (`centsFromCredits(DEFAULT_SEAT_ALLOWANCE_CREDITS)`)
 * has no literal and passes. Comments and string contents are masked first, so an env
 * var name or prose never counts.
 */
export const MONEY_MODEL_VOCABULARY =
  /MARKUP|CREDITS_PER_DOLLAR|CREDIT_RATIO|ALLOWANCE|STARTER_CREDITS|CREDIT_PACK|CONSUMER_CAP|CAP_CREDITS|TOPUP_(?:MIN|MAX)_CREDITS/;

const CONST_DECLARATION = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\b[^=;]*=([^;]{0,400})/g;
const NUMERIC_LITERAL = /(?<![\w.$])\d/;

/** Declarations in `src` that state a money-model figure (see {@link MONEY_MODEL_VOCABULARY}). */
export function findMoneyModelDefinitions(src: string): ConversionHit[] {
  const masked = maskSource(src);
  const hits: ConversionHit[] = [];
  for (const match of masked.matchAll(CONST_DECLARATION)) {
    const [, name, initializer] = match;
    if (!MONEY_MODEL_VOCABULARY.test(name) || !NUMERIC_LITERAL.test(initializer)) continue;
    const line = masked.slice(0, match.index).split('\n').length;
    hits.push({ line, text: `${name} = ${initializer.trim().split('\n')[0]}` });
  }
  return hits;
}
